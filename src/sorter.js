// The scheduler: tracks the messages in the inbox of the chosen account and moves the
// ones whose delay has passed. Everything that touches the stored state runs one at a
// time (exclusive()), so runs never overlap and nothing is moved twice.
//
// Stored in storage.local:
//   config  - settings (options page writes it, everything else only reads it)
//   index   - tracked inbox messages, id -> entry (see fetchEntry)
//   history - "key|folder" -> time of our move, to leave mails alone that were moved back
//   log     - newest first
//   status  - last run, last scan, folder problems, current error, next wake-up
// Message ids are only valid for one Thunderbird session, so every entry remembers the
// session it was seen in (storage.session) and the inbox is re-listed after a restart.
//
// Saving resources: the background page sleeps between events. It is woken by a one-shot
// alarm at the time the next mail is due (plus an hourly heartbeat), not every minute.
// While awake it keeps the state in memory and reads only the keys a task needs; the
// background is the only writer apart from the options page, which only writes config.

import { arrivalTime, findRuleInTops, messageKey, planEntry, topValues } from "./classify.js";
import { effectiveRules, loadConfig, neededHeaders } from "./config.js";
import { findInbox, resolveTargets, sameFolder } from "./folders.js";
import { headersFromPart } from "./headers.js";

/** Periodic safety net (and the hourly re-scan). */
export const ALARM_HEARTBEAT = "mail-sorter-tick";
export const HEARTBEAT_MINUTES = 60;
/** One-shot alarm at the next moment something is due. */
export const ALARM_DUE = "mail-sorter-due";

export const LIMITS = {
  /** messages.getFull calls per scan pass, the rest follows in the next run. */
  fetchPerScan: 100,
  /** Re-list the whole inbox this often, as a safety net for missed events. */
  rescanMinutes: 60,
  logSize: 500,
  historyDays: 90,
  /** Failed moves of one message before giving up (until the next start). */
  maxAttempts: 5,
  /** Save progress after this many fetched messages during a scan. */
  checkpointEvery: 20,
  /** Wake up this long after a due time, so mails due within seconds go in one run. */
  coalesceMs: 10_000,
  /** Pause between runs while there is a backlog (batch limit reached, scan unfinished). */
  backlogMs: 60_000,
};
const RETRY_MINUTES = [1, 5, 15, 60];
const FETCH_RETRY_MINUTES = 15;
const STATE_DEFAULTS = { index: () => ({}), history: () => ({}), log: () => [], status: () => ({}) };

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
  let scheduledWake = null;
  let configStale = false;
  let cache = freshCache();

  function freshCache() {
    return { loaded: new Set(), dirty: new Set(), pendingLog: [] };
  }

  /**
   * Runs fn after everything queued before it. One task at a time. A task that fails
   * drops the in-memory state, so the next one starts again from what is stored.
   */
  function exclusive(fn) {
    const run = tail.then(async () => {
      if (configStale) {
        configStale = false;
        cache.loaded.delete("config");
      }
      try {
        return await fn();
      } catch (e) {
        cache = freshCache();
        throw e;
      }
    });
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

  /** The shared state with config and the given keys loaded (each read once per wake-up). */
  async function load(...keys) {
    const want = ["config", ...keys].filter((k) => !cache.loaded.has(k));
    if (want.length) {
      const data = await api.storage.local.get(want);
      for (const k of want) {
        if (k === "config") {
          const { config, problems } = loadConfig(data.config);
          cache.config = config;
          cache.configProblems = problems;
          cache.rules = effectiveRules(config);
        } else {
          cache[k] = data[k] ?? STATE_DEFAULTS[k]();
        }
        cache.loaded.add(k);
      }
    }
    return cache;
  }

  async function save(ctx) {
    if (ctx.pendingLog.length) {
      // The log is only read when there is something to add to it.
      await load("log");
      ctx.log = [...ctx.pendingLog.reverse(), ...ctx.log].slice(0, L.logSize);
      ctx.pendingLog = [];
      ctx.dirty.add("log");
    }
    if (ctx.dirty.size === 0) return;
    const out = {};
    for (const key of ctx.dirty) out[key] = ctx[key];
    ctx.dirty.clear();
    await api.storage.local.set(out);
  }

  function addLog(ctx, entry) {
    ctx.pendingLog.push({ t: now(), ...entry });
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
   * or if the user moved it into the inbox (byUser). Needs index and history loaded.
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
    await load("index", "history");
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
   * newest first, at most L.fetchPerScan per pass. Writes the index only if it changed.
   */
  async function scan(ctx, inbox, session) {
    await load("index", "history", "status");
    const t = now();
    let changed = false;
    const drop = (id) => {
      delete ctx.index[id];
      changed = true;
    };
    for (const [id, e] of Object.entries(ctx.index)) {
      if (e.accountId !== ctx.config.accountId) drop(id); // another account was chosen
    }
    const listed = await collect(api.messages.list(inbox.id));
    const tracked = Object.values(ctx.index);
    if (listed.length === 0 && tracked.length > 0 && !ctx.status.scan?.emptySeen) {
      // An empty list while we track messages: check again next run before forgetting.
      ctx.status.scan = { ...ctx.status.scan, at: t, complete: false, emptySeen: true };
      if (changed) ctx.dirty.add("index");
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
            changed = true;
          }
          if (msg.subject !== undefined && msg.subject !== e.subject) {
            e.subject = msg.subject;
            changed = true;
          }
          if (refetch) {
            e.session = null; // not usable until fetched again
            changed = true;
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
      if (entries.length) changed = true;
      const firstSeen = entries.length ? Math.min(...entries.map((e) => e.firstSeen)) : t;
      todo.push({ msgs, prevs: entries, firstSeen, date: msgs[0].date });
    }
    const pendingPrevs = new Set(todo.flatMap((g) => g.prevs.map((e) => e.id)));
    for (const id of Object.keys(ctx.index)) {
      if (!keep.has(id) && !pendingPrevs.has(id)) drop(id);
    }
    if (changed) ctx.dirty.add("index");

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

  /**
   * When the next run is needed: the next due mail or retry, the next re-scan, or soon if
   * there is a backlog. Mails whose folder is missing do not count, a folder event or the
   * heartbeat picks them up. Returns null when there is nothing to watch.
   */
  function nextWakeAt(ctx, session, t, backlog) {
    if (!ctx.config.accountId) return null;
    let next = (ctx.status.scan?.at ?? t) + L.rescanMinutes * 60_000;
    if (backlog || ctx.status.scan?.complete === false) next = Math.min(next, t + L.backlogMs);
    const missing = new Set((ctx.status.folderProblems ?? []).map((p) => p.folder));
    for (const e of Object.values(ctx.index)) {
      if (e.session !== session) continue;
      const p = planEntry(e, ctx.rules, ctx.config.recipientHeaders, t);
      if (p.action === "keep" || missing.has(p.rule.folder)) continue;
      if (p.action === "move") {
        if (!(ctx.config.dryRun && e.dryRunReported === p.rule.folder)) next = Math.min(next, t + L.backlogMs);
        continue;
      }
      next = Math.min(next, p.dueAt + L.coalesceMs);
    }
    return Math.max(next, t + 1_000);
  }

  async function schedule(when) {
    if (when === scheduledWake) return;
    try {
      if (when === null) await api.alarms.clear(ALARM_DUE);
      else await api.alarms.create(ALARM_DUE, { when });
      scheduledWake = when;
    } catch {
      // the hourly heartbeat still runs
    }
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

  /** Is the message still the one we classified, and still in the inbox? Drops the entry if not. */
  async function verify(ctx, entry, plan, inbox) {
    let current = null;
    try {
      current = await api.messages.get(entry.msgId);
    } catch {
      current = null;
    }
    let text = null;
    if (!current || messageKey(current) !== entry.key) text = "Mail gibt es nicht mehr (gelöscht oder verschoben), übersprungen";
    else if (!sameFolder(current.folder, inbox)) text = "Liegt nicht mehr im Posteingang, übersprungen";
    if (!text) return true;
    delete ctx.index[entry.id];
    ctx.dirty.add("index");
    addLog(ctx, { kind: "info", ...logFields(entry, plan), text });
    return false;
  }

  function moved(ctx, { entry, plan }) {
    ctx.history[`${entry.key}|${plan.rule.folder}`] = now();
    delete ctx.index[entry.id];
    ctx.dirty.add("history").add("index");
    addLog(ctx, { kind: "moved", ...logFields(entry, plan) });
  }

  function moveFailed(ctx, { entry, plan }, e) {
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
  }

  /**
   * Moves all items for one folder with a single messages.move (one IMAP command). If
   * that fails, each mail is tried on its own, so one bad mail does not block the rest.
   */
  async function moveBatch(ctx, items, target) {
    try {
      await api.messages.move(
        items.map((i) => i.entry.msgId),
        target.id,
      );
      for (const item of items) moved(ctx, item);
    } catch (e) {
      if (items.length === 1) {
        moveFailed(ctx, items[0], e);
      } else {
        for (const item of items) {
          try {
            await api.messages.move([item.entry.msgId], target.id);
            moved(ctx, item);
          } catch (single) {
            moveFailed(ctx, item, single);
          }
        }
      }
    }
    await save(ctx); // checkpoint: a run that is cut off later must not lose this
  }

  /** Moves (or in DRY_RUN reports) what is due. Returns whether a backlog is left. */
  async function moveDue(ctx, account, inbox, session) {
    const { targets, problems } = resolveTargets(account.rootFolder, ctx.rules);
    updateFolderProblems(ctx, problems);
    const plans = duePlans(ctx, session, now());
    if (plans.length === 0) {
      ctx.status.lastBatch = { moves: 0, deferred: 0 };
      return false;
    }
    await load("history");
    const batches = new Map(); // folder -> items
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
      if (!(await verify(ctx, entry, plan, inbox))) continue;
      if (!batches.has(plan.rule.folder)) batches.set(plan.rule.folder, { target, items: [] });
      batches.get(plan.rule.folder).items.push({ entry, plan });
    }
    for (const { target, items } of batches.values()) await moveBatch(ctx, items, target);
    ctx.status.lastBatch = { moves, deferred };
    return deferred > 0;
  }

  async function runTick(reasons) {
    const ctx = await load("index", "status");
    const t0 = now();
    const status = ctx.status;
    const quiet = {
      error: status.error ?? null,
      configProblems: JSON.stringify(status.configProblems ?? []),
      dryRun: status.dryRun,
      nextRunAt: status.nextRunAt,
    };
    status.lastRun = { at: t0, reasons: [...reasons] };
    status.configProblems = ctx.configProblems;
    status.dryRun = ctx.config.dryRun;
    let busy = false;
    let backlog = false;
    let session = null;
    try {
      if (!ctx.config.accountId) {
        status.error = null;
        return;
      }
      session = await getSession();
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
      if (!needScan && !reasons.has("folders") && duePlans(ctx, session, t0).length === 0) {
        status.error = null;
        return; // nothing to do: no message API calls at all
      }
      busy = true;
      const { account, inbox } = await openAccount(ctx);
      status.account = account.name;
      if (needScan) await scan(ctx, inbox, session);
      backlog = await moveDue(ctx, account, inbox, session);
      status.error = null;
    } catch (e) {
      const text = errorText(e);
      if (status.error !== text) addLog(ctx, { kind: "error", text });
      status.error = text;
      busy = true;
    } finally {
      status.lastRun.ms = now() - t0;
      status.nextRunAt = session ? nextWakeAt(ctx, session, now(), backlog) : null;
      // An idle alarm run only writes the status if something visible changed, so a quiet
      // mailbox causes no storage writes at all.
      const visible =
        busy ||
        quiet.error !== (status.error ?? null) ||
        quiet.configProblems !== JSON.stringify(status.configProblems) ||
        quiet.dryRun !== status.dryRun ||
        quiet.nextRunAt !== status.nextRunAt ||
        ctx.dirty.size > 0 ||
        ctx.pendingLog.length > 0;
      if (visible || reasons.size !== 1 || !reasons.has("alarm")) ctx.dirty.add("status");
      await save(ctx);
      await schedule(status.nextRunAt);
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
    if (reason === "config") configStale = true;
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

  /** messages.onNewMailReceived. Other folders and accounts are ignored before any storage access. */
  async function onNewMail(folder, messageList) {
    let added = false;
    await exclusive(async () => {
      const ctx = await load();
      if (!isWatchedInbox(ctx, folder)) {
        // Unread pages of a list stay open in Thunderbird until they are read or aborted.
        if (messageList?.id) await api.messages.abortList(messageList.id).catch(() => {});
        return;
      }
      const msgs = await collect(messageList);
      if (msgs.length === 0) return;
      await addMessages(ctx, msgs, await getSession());
      added = true;
      await save(ctx);
    });
    if (added) await tick("newmail");
  }

  /**
   * messages.onMoved: forget what left the inbox, track what was moved into it. The add-on
   * itself never moves into the inbox, so whatever arrives there this way was the user's
   * decision and stays. Moves elsewhere in Thunderbird cost nothing but the config check.
   */
  async function onMoved(originalList, movedList) {
    let incoming = 0;
    await exclusive(async () => {
      const ctx = await load();
      if (!ctx.config.accountId) return;
      const before = (await collect(originalList)).filter((m) => isWatchedInbox(ctx, m.folder));
      const into = (await collect(movedList)).filter((m) => isWatchedInbox(ctx, m.folder));
      if (before.length === 0 && into.length === 0) return;
      const session = await getSession();
      await load("index");
      removeByMsgIds(ctx, new Set(before.map((m) => m.id)), session);
      incoming = into.length;
      if (incoming) await addMessages(ctx, into, session, { byUser: true });
      await save(ctx);
    });
    if (incoming) await tick("moved");
  }

  /** messages.onDeleted */
  async function onDeleted(list) {
    await exclusive(async () => {
      const ctx = await load();
      if (!ctx.config.accountId) return;
      // Deleted messages may come without folder information; only then look at all of them.
      const gone = (await collect(list)).filter((m) => !m.folder || isWatchedInbox(ctx, m.folder));
      if (gone.length === 0) return;
      await load("index");
      removeByMsgIds(ctx, new Set(gone.map((m) => m.id)), await getSession());
      await save(ctx);
    });
  }

  /** folders.onCreated/onRenamed/onMoved/onDeleted: a missing target may exist now. */
  function onFoldersChanged(folder) {
    return exclusive(async () => {
      const ctx = await load();
      return !!ctx.config.accountId && (!folder?.accountId || folder.accountId === ctx.config.accountId);
    }).then((relevant) => (relevant ? tick("folders") : undefined));
  }

  /** Commands from the options page. */
  async function command(msg) {
    switch (msg?.cmd) {
      case "runNow":
        await tick("manual");
        return { ok: true };
      case "clearLog":
        await exclusive(async () => {
          const ctx = await load("log");
          ctx.log = [];
          ctx.pendingLog = [];
          ctx.dirty.add("log");
          await save(ctx);
        });
        return { ok: true };
      case "resetIndex":
        await exclusive(async () => {
          const ctx = await load("index", "status");
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

  return { tick, onNewMail, onMoved, onDeleted, onFoldersChanged, command, exclusive };
}
