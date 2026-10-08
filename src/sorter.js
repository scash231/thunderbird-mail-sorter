// The scheduler: tracks the messages in the inbox of the chosen account and moves the
// ones whose delay has passed. Everything that touches the stored state runs one at a
// time (exclusive()), so runs never overlap and nothing is moved twice.
//
// Stored in storage.local:
//   config  - settings (options page writes it, everything else only reads it)
//   index   - tracked inbox messages, id -> entry (see fetchEntry)
//   history - "key|folder" -> time of our move, to leave mails alone that were moved back
//   log     - newest first
//   status  - last run, last scan, folder problems, current error
// Message ids are only valid for one Thunderbird session, so every entry remembers the
// session it was seen in (storage.session) and the inbox is re-listed after a restart.

import { arrivalTime, findRuleInTops, messageKey, planEntry, topValues } from "./classify.js";
import { effectiveRules, loadConfig, neededHeaders } from "./config.js";
import { findInbox, resolveTargets, sameFolder } from "./folders.js";
import { headersFromPart } from "./headers.js";

export const ALARM_NAME = "mail-sorter-tick";

export const LIMITS = {
  /** messages.getFull calls per scan pass, the rest follows in the next run. */
  fetchPerScan: 100,
  /** Re-list the whole inbox this often, as a safety net for missed events. */
  rescanMinutes: 60,
  logSize: 1000,
  historyDays: 90,
  /** Failed moves of one message before giving up (until the next start). */
  maxAttempts: 5,
  /** Save progress after this many fetched messages during a scan. */
  checkpointEvery: 20,
};
const RETRY_MINUTES = [1, 5, 15, 60];
const FETCH_RETRY_MINUTES = 15;

function errorText(e) {
  return (e && typeof e === "object" && "message" in e ? e.message : String(e)) || "Unbekannter Fehler";
}

class Problem extends Error {}

/**
 * @param {object} deps
 * @param {object} deps.api the messenger object (or a mock of it)
 * @param {() => number} [deps.now]
 * @param {Partial<typeof LIMITS>} [deps.limits]
 */
export function createSorter({ api, now = () => Date.now(), limits = {} }) {
  const L = { ...LIMITS, ...limits };
  let tail = Promise.resolve();
  let sessionId = null;
  let tickQueued = null;
  const tickReasons = new Set();
  let badge = null;

  /** Runs fn after everything queued before it. One task at a time. */
  function exclusive(fn) {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  }

  async function getSession() {
    if (sessionId) return sessionId;
    const area = api.storage.session;
    if (area) {
      const { sessionId: stored } = await area.get("sessionId");
      if (stored) return (sessionId = stored);
    }
    const id = `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    if (area) await area.set({ sessionId: id });
    return (sessionId = id);
  }

  async function load() {
    const data = await api.storage.local.get(["config", "index", "history", "log", "status"]);
    const { config, problems } = loadConfig(data.config);
    return {
      config,
      configProblems: problems,
      rules: effectiveRules(config),
      index: data.index ?? {},
      history: data.history ?? {},
      log: data.log ?? [],
      status: data.status ?? {},
      dirty: new Set(),
    };
  }

  async function save(ctx) {
    if (ctx.dirty.size === 0) return;
    const out = {};
    for (const key of ctx.dirty) out[key] = ctx[key];
    ctx.dirty.clear();
    await api.storage.local.set(out);
  }

  function addLog(ctx, entry) {
    ctx.log.unshift({ t: now(), ...entry });
    if (ctx.log.length > L.logSize) ctx.log.length = L.logSize;
    ctx.dirty.add("log");
  }

  async function collect(list) {
    if (!list) return [];
    let page = await list;
    const out = [...(page?.messages ?? [])];
    while (page?.id) {
      page = await api.messages.continueList(page.id);
      out.push(...(page?.messages ?? []));
    }
    return out;
  }

  function isWatchedInbox(ctx, folder) {
    return (
      !!ctx.config.accountId &&
      folder?.accountId === ctx.config.accountId &&
      Array.isArray(folder.specialUse) &&
      folder.specialUse.includes("inbox")
    );
  }

  async function openAccount(ctx) {
    const account = await api.accounts.get(ctx.config.accountId, true);
    if (!account) throw new Problem("Das gewählte Konto gibt es nicht mehr. Bitte in den Einstellungen neu wählen.");
    const inbox = findInbox(account.rootFolder);
    if (!inbox) throw new Problem(`Im Konto "${account.name}" gibt es keinen Posteingang.`);
    return { account, inbox };
  }

  function freeId(index, key) {
    if (!index[key]) return key;
    let n = 2;
    while (index[`${key}#${n}`]) n++;
    return `${key}#${n}`;
  }

  /** Reads the headers of one message and builds its index entry. Never throws. */
  async function fetchEntry(ctx, msg, { session, firstSeen, fetchAttempts = 0, keep = {} }) {
    const base = {
      key: messageKey(msg),
      accountId: ctx.config.accountId,
      msgId: msg.id,
      session,
      subject: msg.subject ?? "",
      author: msg.author ?? "",
      firstSeen,
    };
    const names = neededHeaders(ctx.config);
    try {
      const part = await api.messages.getFull(msg.id, { decodeHeaders: false });
      const headers = headersFromPart(part);
      const { arrivedAt, source } = arrivalTime(headers, firstSeen);
      return { ...base, ...keep, tops: topValues(headers, names), headerNames: names, arrivedAt, arrivalSource: source };
    } catch (e) {
      return {
        ...base,
        tops: null,
        fetchError: errorText(e),
        fetchAttempts: fetchAttempts + 1,
        nextFetchAt: now() + FETCH_RETRY_MINUTES * 60_000,
      };
    }
  }

  /**
   * Stores a freshly fetched entry. Leaves it alone if we moved it out of the inbox before,
   * or if the user moved it into the inbox (byUser).
   */
  function storeEntry(ctx, entry, { byUser = false } = {}) {
    const id = freeId(ctx.index, entry.key);
    entry.id = id;
    ctx.index[id] = entry;
    ctx.dirty.add("index");
    if (entry.fetchError) {
      addLog(ctx, { kind: "error", subject: entry.subject, author: entry.author, text: `Header nicht lesbar: ${entry.fetchError}` });
      return;
    }
    const match = findRuleInTops(entry.tops, ctx.rules, ctx.config.recipientHeaders);
    if (!match || entry.returned === match.rule.folder) return;
    const movedAt = ctx.history[`${entry.key}|${match.rule.folder}`];
    let text = null;
    if (byUser) text = "Von dir in den Posteingang verschoben, bleibt dort";
    else if (movedAt && movedAt <= entry.firstSeen) text = "Wurde schon einmal einsortiert und liegt wieder im Posteingang, bleibt dort";
    if (!text) return;
    entry.returned = match.rule.folder;
    addLog(ctx, { kind: "info", subject: entry.subject, author: entry.author, folder: match.rule.folder, header: match.header, text });
  }

  async function addMessages(ctx, msgs, session, { byUser = false } = {}) {
    const known = new Set();
    for (const e of Object.values(ctx.index)) if (e.session === session) known.add(e.msgId);
    for (const msg of msgs) {
      if (known.has(msg.id)) continue;
      known.add(msg.id);
      storeEntry(ctx, await fetchEntry(ctx, msg, { session, firstSeen: now() }), { byUser });
    }
  }

  function removeByMsgIds(ctx, ids, session) {
    if (ids.size === 0) return;
    for (const [id, e] of Object.entries(ctx.index)) {
      if (e.session === session && ids.has(e.msgId)) {
        delete ctx.index[id];
        ctx.dirty.add("index");
      }
    }
  }

  /**
   * Lists the inbox and brings the index in line with it: known messages get their new
   * session id (no header fetch), vanished ones are dropped, new ones are fetched,
   * newest first, at most L.fetchPerScan per pass.
   */
  async function scan(ctx, inbox, session) {
    const t = now();
    for (const [id, e] of Object.entries(ctx.index)) {
      if (e.accountId !== ctx.config.accountId) delete ctx.index[id]; // another account was chosen
    }
    const listed = await collect(api.messages.list(inbox.id));
    const tracked = Object.values(ctx.index);
    if (listed.length === 0 && tracked.length > 0 && !ctx.status.scan?.emptySeen) {
      // An empty list while we track messages: check again next run before forgetting.
      ctx.status.scan = { ...ctx.status.scan, at: t, complete: false, emptySeen: true };
      return;
    }

    const groups = new Map();
    for (const m of listed) {
      const k = messageKey(m);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    }
    const byKey = new Map();
    for (const e of tracked) {
      if (!byKey.has(e.key)) byKey.set(e.key, []);
      byKey.get(e.key).push(e);
    }
    const needed = neededHeaders(ctx.config);
    // Entries with session null wait for a fetch (set below), so they are fetched in any case.
    const needsFetch = (e) => {
      if (e.session === null) return true;
      if (!e.tops) return e.session !== session || (e.nextFetchAt ?? 0) <= t;
      return !needed.every((h) => e.headerNames?.includes(h));
    };

    const keep = new Set();
    const todo = []; // {msgs, prevs, firstSeen, date}
    for (const [key, msgs] of groups) {
      const entries = byKey.get(key) ?? [];
      const sameSession =
        entries.length === msgs.length && msgs.every((m) => entries.some((e) => e.session === session && e.msgId === m.id));
      if (sameSession || (entries.length === 1 && msgs.length === 1)) {
        for (const e of entries) {
          const msg = sameSession ? msgs.find((m) => m.id === e.msgId) : msgs[0];
          const refetch = needsFetch(e);
          if (e.session !== session) {
            // New Thunderbird session: new message id, and failed moves get another chance.
            e.session = session;
            e.msgId = msg.id;
            delete e.gaveUp;
            delete e.attempts;
            delete e.nextTryAt;
          }
          e.subject = msg.subject ?? e.subject;
          if (refetch) {
            e.session = null; // not usable until fetched again
            todo.push({ msgs: [msg], prevs: [e], firstSeen: e.firstSeen, date: msg.date });
          } else {
            keep.add(e.id);
          }
        }
        continue;
      }
      // New message, or several copies of one mail (one per alias) that cannot be paired
      // with the stored entries safely: fetch them again.
      for (const e of entries) e.session = null;
      const firstSeen = entries.length ? Math.min(...entries.map((e) => e.firstSeen)) : t;
      todo.push({ msgs, prevs: entries, firstSeen, date: msgs[0].date });
    }
    const pendingPrevs = new Set(todo.flatMap((g) => g.prevs.map((e) => e.id)));
    for (const id of Object.keys(ctx.index)) {
      if (!keep.has(id) && !pendingPrevs.has(id)) delete ctx.index[id];
    }
    ctx.dirty.add("index");

    todo.sort((a, b) => new Date(b.date ?? 0).getTime() - new Date(a.date ?? 0).getTime());
    let fetched = 0;
    let done = 0;
    for (const group of todo) {
      if (fetched >= L.fetchPerScan) break;
      for (const e of group.prevs) delete ctx.index[e.id];
      const attempts = Math.max(0, ...group.prevs.map((e) => e.fetchAttempts ?? 0));
      // A single message fetched again (e.g. a header was added to the order) keeps its marks.
      const prev = group.prevs.length === 1 && group.msgs.length === 1 ? group.prevs[0] : null;
      const marks = prev ? { returned: prev.returned, dryRunReported: prev.dryRunReported } : {};
      for (const msg of group.msgs) {
        const opts = { session, firstSeen: group.firstSeen, fetchAttempts: attempts, keep: marks };
        storeEntry(ctx, await fetchEntry(ctx, msg, opts));
        fetched++;
        if (fetched % L.checkpointEvery === 0) await save(ctx);
      }
      done++;
    }

    const cutoff = t - L.historyDays * 24 * 60 * 60_000;
    for (const [k, at] of Object.entries(ctx.history)) {
      if (at < cutoff) {
        delete ctx.history[k];
        ctx.dirty.add("history");
      }
    }
    ctx.status.scan = {
      at: t,
      session,
      accountId: ctx.config.accountId,
      complete: done === todo.length,
      pending: todo.slice(done).reduce((n, g) => n + g.msgs.length, 0),
      inboxCount: listed.length,
      fetched,
    };
  }

  function scanNeeded(ctx, session, t, reasons) {
    const s = ctx.status.scan;
    if (!s || s.session !== session || s.accountId !== ctx.config.accountId || !s.complete) return true;
    if (t - s.at >= L.rescanMinutes * 60_000) return true;
    return ["manual", "config", "start", "install"].some((r) => reasons.has(r));
  }

  function duePlans(ctx, session, t) {
    const plans = [];
    for (const e of Object.values(ctx.index)) {
      if (e.session !== session) continue;
      const p = planEntry(e, ctx.rules, ctx.config.recipientHeaders, t);
      if (p.action !== "move") continue;
      if (ctx.config.dryRun && e.dryRunReported === p.rule.folder) continue;
      plans.push({ entry: e, plan: p });
    }
    return plans.sort((a, b) => a.plan.dueAt - b.plan.dueAt);
  }

  function updateFolderProblems(ctx, problems) {
    const before = JSON.stringify(ctx.status.folderProblems ?? []);
    if (before === JSON.stringify(problems)) return;
    const old = new Set((ctx.status.folderProblems ?? []).map((p) => p.problem));
    for (const p of problems) {
      if (!old.has(p.problem)) addLog(ctx, { kind: "error", folder: p.folder, text: p.problem });
    }
    ctx.status.folderProblems = problems;
  }

  function logFields(entry, plan) {
    return {
      subject: entry.subject,
      author: entry.author,
      folder: plan.rule.folder,
      header: plan.header,
      address: plan.address,
      source: entry.arrivalSource,
      ageMinutes: plan.ageMinutes,
    };
  }

  /** Verifies that the message is still the one we classified and still in the inbox, then moves it. */
  async function moveOne(ctx, entry, plan, target, inbox) {
    let current = null;
    try {
      current = await api.messages.get(entry.msgId);
    } catch {
      current = null;
    }
    if (!current || messageKey(current) !== entry.key) {
      delete ctx.index[entry.id];
      ctx.dirty.add("index");
      addLog(ctx, { kind: "info", ...logFields(entry, plan), text: "Mail gibt es nicht mehr (gelöscht oder verschoben), übersprungen" });
      return;
    }
    if (!sameFolder(current.folder, inbox)) {
      delete ctx.index[entry.id];
      ctx.dirty.add("index");
      addLog(ctx, { kind: "info", ...logFields(entry, plan), text: "Liegt nicht mehr im Posteingang, übersprungen" });
      return;
    }
    try {
      await api.messages.move([entry.msgId], target.id);
    } catch (e) {
      entry.attempts = (entry.attempts ?? 0) + 1;
      entry.lastError = errorText(e);
      ctx.dirty.add("index");
      let text = `Verschieben fehlgeschlagen (Versuch ${entry.attempts}): ${entry.lastError}`;
      if (entry.attempts >= L.maxAttempts) {
        entry.gaveUp = true;
        text += ". Kein weiterer Versuch bis zum nächsten Start oder \"Jetzt prüfen\"";
      } else {
        const wait = RETRY_MINUTES[Math.min(entry.attempts - 1, RETRY_MINUTES.length - 1)];
        entry.nextTryAt = now() + wait * 60_000;
        text += `. Neuer Versuch in ${wait} min`;
      }
      addLog(ctx, { kind: "error", ...logFields(entry, plan), text });
      return;
    }
    ctx.history[`${entry.key}|${plan.rule.folder}`] = now();
    delete ctx.index[entry.id];
    ctx.dirty.add("history").add("index");
    addLog(ctx, { kind: "moved", ...logFields(entry, plan) });
    await save(ctx); // checkpoint: a run that is cut off later must not lose this
  }

  async function moveDue(ctx, account, inbox, session) {
    const { targets, problems } = resolveTargets(account.rootFolder, ctx.rules);
    updateFolderProblems(ctx, problems);
    const plans = duePlans(ctx, session, now());
    let moves = 0;
    let deferred = 0;
    for (const { entry, plan } of plans) {
      const target = targets.get(plan.rule.folder);
      if (!target) continue; // reported once in updateFolderProblems
      if (ctx.config.dryRun) {
        entry.dryRunReported = plan.rule.folder;
        ctx.dirty.add("index");
        addLog(ctx, { kind: "dryrun", ...logFields(entry, plan) });
        continue;
      }
      if (moves >= ctx.config.maxMovesPerRun) {
        deferred++;
        continue;
      }
      moves++;
      await moveOne(ctx, entry, plan, target, inbox);
    }
    ctx.status.lastBatch = { moves, deferred };
  }

  async function runTick(reasons) {
    const ctx = await load();
    const t0 = now();
    const status = ctx.status;
    status.lastRun = { at: t0, reasons: [...reasons] };
    status.configProblems = ctx.configProblems;
    status.dryRun = ctx.config.dryRun;
    ctx.dirty.add("status");
    try {
      if (!ctx.config.accountId) {
        status.error = null;
        return;
      }
      const session = await getSession();
      if (reasons.has("manual")) {
        for (const e of Object.values(ctx.index)) {
          if (e.gaveUp) {
            delete e.gaveUp;
            delete e.attempts;
            delete e.nextTryAt;
            ctx.dirty.add("index");
          }
        }
      }
      const needScan = scanNeeded(ctx, session, t0, reasons);
      if (!needScan && duePlans(ctx, session, t0).length === 0) {
        status.error = null;
        return; // nothing to do: no API calls at all
      }
      const { account, inbox } = await openAccount(ctx);
      status.account = account.name;
      if (needScan) await scan(ctx, inbox, session);
      await moveDue(ctx, account, inbox, session);
      status.error = null;
    } catch (e) {
      const text = errorText(e);
      if (status.error !== text) addLog(ctx, { kind: "error", text });
      status.error = text;
    } finally {
      status.lastRun.ms = now() - t0;
      ctx.dirty.add("status"); // checkpoints in between may have cleared the flag
      await save(ctx);
      await updateBadge(status.error || status.folderProblems?.length ? "!" : ctx.config.dryRun ? "TEST" : "");
    }
  }

  /** Toolbar button: "TEST" while DRY_RUN is on, "!" on problems. */
  async function updateBadge(text) {
    if (badge === text || !api.action?.setBadgeText) return;
    try {
      await api.action.setBadgeText({ text });
      if (text) await api.action.setBadgeBackgroundColor({ color: text === "!" ? "#b42318" : "#c77700" });
      badge = text;
    } catch {
      // cosmetic only
    }
  }

  /**
   * Queues a run. Requests that come in while one is waiting are merged into it;
   * a request during a running run queues exactly one more.
   */
  function tick(reason = "alarm") {
    tickReasons.add(reason);
    if (tickQueued) return tickQueued;
    tickQueued = exclusive(async () => {
      tickQueued = null;
      const reasons = new Set(tickReasons);
      tickReasons.clear();
      await runTick(reasons);
    });
    return tickQueued;
  }

  /** messages.onNewMailReceived */
  async function onNewMail(folder, messageList) {
    const msgs = await collect(messageList);
    let added = false;
    await exclusive(async () => {
      const ctx = await load();
      if (!isWatchedInbox(ctx, folder) || msgs.length === 0) return;
      await addMessages(ctx, msgs, await getSession());
      added = true;
      await save(ctx);
    });
    if (added) await tick("newmail");
  }

  /**
   * messages.onMoved: forget what left the inbox, track what was moved into it. The add-on
   * itself never moves into the inbox, so whatever arrives there this way was the user's
   * decision and stays.
   */
  async function onMoved(originalList, movedList) {
    const before = await collect(originalList);
    const after = await collect(movedList);
    let incoming = 0;
    await exclusive(async () => {
      const ctx = await load();
      if (!ctx.config.accountId) return;
      const session = await getSession();
      removeByMsgIds(ctx, new Set(before.filter((m) => isWatchedInbox(ctx, m.folder)).map((m) => m.id)), session);
      const into = after.filter((m) => isWatchedInbox(ctx, m.folder));
      incoming = into.length;
      await addMessages(ctx, into, session, { byUser: true });
      await save(ctx);
    });
    if (incoming) await tick("moved");
  }

  /** messages.onDeleted */
  async function onDeleted(list) {
    const gone = await collect(list);
    await exclusive(async () => {
      const ctx = await load();
      removeByMsgIds(ctx, new Set(gone.map((m) => m.id)), await getSession());
      await save(ctx);
    });
  }

  /** Commands from the options page. */
  async function command(msg) {
    switch (msg?.cmd) {
      case "runNow":
        await tick("manual");
        return { ok: true };
      case "clearLog":
        await exclusive(async () => {
          const ctx = await load();
          ctx.log = [];
          ctx.dirty.add("log");
          await save(ctx);
        });
        return { ok: true };
      case "resetIndex":
        await exclusive(async () => {
          const ctx = await load();
          ctx.index = {};
          ctx.status.scan = null;
          ctx.dirty.add("index").add("status");
          await save(ctx);
        });
        await tick("manual");
        return { ok: true };
      default:
        return undefined;
    }
  }

  return { tick, onNewMail, onMoved, onDeleted, command, exclusive };
}
