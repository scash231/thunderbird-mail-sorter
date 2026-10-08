// Options page: status/log view and settings. Reads and writes storage.local directly,
// commands that change the scheduler state go to the background page.

import { planEntry } from "../src/classify.js";
import { defaultConfig, effectiveRules, exportConfig, importConfig, loadConfig, validateConfig } from "../src/config.js";
import { listFolders, resolveFolder } from "../src/folders.js";

const $ = (id) => document.getElementById(id);

let saved = defaultConfig(); // what is stored
let draft = clone(saved); // what the settings form shows
let dirty = false;
let saveProblems = [];
let accounts = [];
const folderCache = new Map(); // accountId -> {root, folders} | null (account gone)
let data = { index: {}, log: [], status: {} };

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

/** Small DOM helper. Text always goes through textContent, never through HTML. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (["value", "checked", "disabled", "selected", "hidden", "title", "placeholder"].includes(k)) node[k] = v;
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : String(c));
  }
  return node;
}

const SOURCE_LABEL = { Received: "laut Received-Header", Date: "laut Date-Header", firstSeen: "zuerst gesehen" };

function fmtTime(t) {
  return new Date(t).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function fmtDuration(ms) {
  const m = Math.max(1, Math.ceil(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

function ago(t, now = Date.now()) {
  const d = now - t;
  if (d < 60_000) return "gerade eben";
  return `vor ${fmtDuration(d)}`;
}

async function send(cmd) {
  return messenger.runtime.sendMessage({ cmd });
}

// ---------------------------------------------------------------- status view

function renderAlerts(config, status) {
  const box = $("alerts");
  box.replaceChildren();
  const alert = (kind, text, list) =>
    box.append(el("div", { class: `alert ${kind}` }, text, list?.length ? el("ul", {}, list.map((x) => el("li", { text: x }))) : null));
  if (!config.accountId) alert("warn", "Noch kein Konto gewählt. Unter Einstellungen das IONOS-Konto auswählen und speichern.");
  if (status.error) alert("error", `Fehler im letzten Lauf: ${status.error}`);
  if (status.configProblems?.length) {
    alert("error", "Die gespeicherten Einstellungen sind ungültig, es gelten die Vorgaben mit DRY_RUN:", status.configProblems);
  }
  if (status.folderProblems?.length) {
    alert(
      "error",
      "Zielordner fehlen. Mails für diese Ordner bleiben im Posteingang, die anderen Regeln laufen weiter:",
      status.folderProblems.map((p) => p.problem),
    );
  }
  if (config.accountId && config.dryRun) {
    alert("info", "DRY_RUN ist an: Es wird nichts verschoben. Das Protokoll zeigt, was verschoben würde.");
  }
}

function renderStatus() {
  const config = saved;
  const rules = effectiveRules(config);
  const now = Date.now();
  const status = data.status ?? {};

  const badge = $("mode-badge");
  badge.textContent = config.dryRun ? "DRY_RUN: nur Anzeige" : "Aktiv: verschiebt";
  badge.className = `badge ${config.dryRun ? "dry" : "live"}`;
  $("last-run").textContent = status.lastRun ? `Letzter Lauf ${ago(status.lastRun.at, now)}` : "Noch kein Lauf";
  renderAlerts(config, status);

  const missing = new Set((status.folderProblems ?? []).map((p) => p.folder));
  const waiting = [];
  const others = [];
  let nomatch = 0;
  let due = 0;
  for (const e of Object.values(data.index ?? {})) {
    if (e.accountId !== config.accountId) continue;
    const p = planEntry(e, rules, config.recipientHeaders, now);
    if (p.action === "keep") {
      if (p.reason === "no-match") nomatch++;
      others.push({ e, p });
    } else {
      if (p.action === "move") due++;
      waiting.push({ e, p });
    }
  }
  $("c-waiting").textContent = String(waiting.length - due);
  $("c-due").textContent = String(due);
  $("c-nomatch").textContent = String(nomatch);
  $("c-inbox").textContent = String(status.scan?.inboxCount ?? waiting.length + others.length);

  const scan = status.scan;
  let scanText = scan?.at ? `Posteingang zuletzt eingelesen ${ago(scan.at, now)}.` : "Posteingang noch nicht eingelesen.";
  if (scan && !scan.complete && scan.pending) scanText += ` ${scan.pending} Mails noch nicht gelesen, folgen in den nächsten Läufen.`;
  $("scan-info").textContent = scanText;

  waiting.sort((a, b) => a.p.dueAt - b.p.dueAt);
  $("waiting-body").replaceChildren(
    ...waiting.map(({ e, p }) => {
      let when;
      if (missing.has(p.rule.folder)) when = "Zielordner fehlt";
      else if (p.action === "move") {
        if (config.dryRun) when = e.dryRunReported === p.rule.folder ? "fällig (DRY_RUN, wird nicht verschoben)" : "fällig (DRY_RUN)";
        else when = "fällig, im nächsten Lauf";
      } else if (p.reason === "retry") when = `neuer Versuch in ${fmtDuration(p.dueAt - now)}`;
      else when = `in ${fmtDuration(p.dueAt - now)} (${fmtTime(p.dueAt)})`;
      return el(
        "tr",
        {},
        el("td", { class: "subject" }, e.subject || "(kein Betreff)", el("span", { class: "sub", text: e.author })),
        el("td", { text: p.rule.folder }),
        el("td", {}, p.header, el("span", { class: "sub", text: p.address })),
        el("td", { class: "nowrap" }, fmtTime(e.arrivedAt), el("span", { class: "sub", text: SOURCE_LABEL[e.arrivalSource] ?? "" })),
        el("td", {}, when, e.lastError ? el("span", { class: "sub", text: `Letzter Fehler: ${e.lastError}` }) : null),
      );
    }),
  );
  $("waiting-empty").hidden = waiting.length > 0;

  const reasonText = ({ e, p }) => {
    switch (p.reason) {
      case "no-match":
        return "keine deiner Adressen, bleibt";
      case "returned":
        return `war schon in ${p.rule.folder}, zurückgeschoben, bleibt`;
      case "failed":
        return `Verschieben nach ${p.rule.folder} mehrfach fehlgeschlagen: ${e.lastError ?? ""}`;
      case "unread":
        return `Header nicht lesbar: ${e.fetchError ?? "noch nicht gelesen"}`;
      default:
        return p.reason;
    }
  };
  $("others-count").textContent = String(others.length);
  $("others-body").replaceChildren(
    ...others
      .slice(0, 500)
      .map((o) =>
        el(
          "tr",
          {},
          el("td", { class: "subject", text: o.e.subject || "(kein Betreff)" }),
          el("td", { text: o.e.author }),
          el("td", { text: reasonText(o) }),
        ),
      ),
  );

  renderLog();
}

const LOG_LABEL = { moved: "verschoben", dryrun: "würde verschoben", error: "Fehler", info: "Info" };

function renderLog() {
  const filter = $("log-filter").value;
  const rows = (data.log ?? []).filter((l) => {
    if (filter === "moves") return l.kind === "moved" || l.kind === "dryrun";
    if (filter === "error") return l.kind === "error";
    return true;
  });
  $("log-body").replaceChildren(
    ...rows.slice(0, 500).map((l) => {
      let detail = l.text ?? "";
      if (!detail && (l.kind === "moved" || l.kind === "dryrun")) {
        detail = `Alter ${l.ageMinutes ?? "?"} min, Eingang ${SOURCE_LABEL[l.source] ?? l.source ?? "?"}`;
      }
      return el(
        "tr",
        {},
        el("td", { class: "nowrap", text: fmtTime(l.t) }),
        el("td", {}, el("span", { class: `tag ${l.kind}`, text: LOG_LABEL[l.kind] ?? l.kind })),
        el("td", { class: "subject" }, l.subject ?? "", l.author ? el("span", { class: "sub", text: l.author }) : null),
        el("td", { text: l.folder ?? "" }),
        el("td", {}, l.header ?? "", l.address ? el("span", { class: "sub", text: l.address }) : null),
        el("td", { text: detail }),
      );
    }),
  );
  $("log-empty").hidden = rows.length > 0;
}

let statusTimer = null;
function scheduleStatus() {
  if (statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    renderStatus();
  }, 300);
}

// ---------------------------------------------------------------- settings

async function loadFolders(accountId) {
  if (!accountId || folderCache.has(accountId)) return;
  const account = await messenger.accounts.get(accountId, true);
  folderCache.set(accountId, account ? { root: account.rootFolder, folders: listFolders(account.rootFolder) } : null);
}

function markDirty() {
  dirty = true;
  renderSettings();
}

function parseAddresses(text) {
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseDelay(text) {
  const t = String(text).trim();
  return t === "" ? null : Number(t);
}

function moveItem(list, i, delta) {
  const j = i + delta;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
}

function folderSelect(rule, tree) {
  const select = el("select", {
    onchange: (ev) => {
      rule.folder = ev.target.value;
      markDirty();
    },
  });
  const options = [];
  let known = false;
  if (tree) {
    for (const f of tree.folders) {
      if (f.path === "INBOX") continue;
      if (f.path === rule.folder) known = true;
      options.push(el("option", { value: f.path, text: f.label, selected: f.path === rule.folder }));
    }
  }
  if (!rule.folder) options.unshift(el("option", { value: "", text: "(Ordner wählen)", selected: true }));
  else if (!known) options.unshift(el("option", { value: rule.folder, text: `${rule.folder} (nicht gefunden)`, selected: true }));
  select.append(...options);
  let problem = null;
  if (tree && rule.folder) {
    const r = resolveFolder(tree.root, rule.folder);
    if ("problem" in r) problem = r.problem;
  }
  return { select, problem };
}

function renderSettings() {
  // problems
  const problemsBox = $("settings-problems");
  problemsBox.replaceChildren();
  if (saveProblems.length) {
    problemsBox.append(
      el("div", { class: "alert error" }, "Nicht gespeichert, bitte korrigieren:", el("ul", {}, saveProblems.map((p) => el("li", { text: p })))),
    );
  }

  // account
  const accountSel = $("account");
  const accountOptions = [el("option", { value: "", text: "(bitte wählen)", selected: !draft.accountId })];
  for (const a of accounts) {
    accountOptions.push(el("option", { value: a.id, text: `${a.name} (${a.type})`, selected: a.id === draft.accountId }));
  }
  if (draft.accountId && !accounts.some((a) => a.id === draft.accountId)) {
    accountOptions.push(el("option", { value: draft.accountId, text: "(Konto nicht gefunden)", selected: true }));
  }
  accountSel.replaceChildren(...accountOptions);

  $("dry-run").checked = draft.dryRun;
  $("dry-run-warning").hidden = !(saved.dryRun && !draft.dryRun);
  $("default-delay").value = String(draft.defaultDelayMinutes ?? "");
  $("max-moves").value = String(draft.maxMovesPerRun ?? "");

  // rules
  const tree = draft.accountId ? folderCache.get(draft.accountId) : null;
  $("rules-body").replaceChildren(
    ...draft.rules.map((rule, i) => {
      const { select, problem } = folderSelect(rule, tree);
      return el(
        "tr",
        {},
        el("td", { text: String(i + 1) }),
        el(
          "td",
          {},
          el("input", {
            type: "text",
            value: (rule.addresses ?? []).join(", "),
            placeholder: "name@braunben.de",
            onchange: (ev) => {
              rule.addresses = parseAddresses(ev.target.value);
              markDirty();
            },
          }),
        ),
        el("td", {}, select, problem ? el("div", { class: "rule-problem", text: problem }) : null),
        el(
          "td",
          {},
          el("input", {
            type: "number",
            min: "0",
            max: "10080",
            step: "1",
            value: rule.delayMinutes === null || rule.delayMinutes === undefined ? "" : String(rule.delayMinutes),
            placeholder: `Standard (${draft.defaultDelayMinutes})`,
            onchange: (ev) => {
              rule.delayMinutes = parseDelay(ev.target.value);
              markDirty();
            },
          }),
        ),
        el(
          "td",
          { class: "nowrap" },
          el("button", { type: "button", class: "secondary icon", title: "nach oben (höhere Priorität)", text: "▲", disabled: i === 0, onclick: () => (moveItem(draft.rules, i, -1), markDirty()) }),
          " ",
          el("button", { type: "button", class: "secondary icon", title: "nach unten", text: "▼", disabled: i === draft.rules.length - 1, onclick: () => (moveItem(draft.rules, i, 1), markDirty()) }),
          " ",
          el("button", { type: "button", class: "secondary icon", title: "Regel löschen", text: "✕", onclick: () => (draft.rules.splice(i, 1), markDirty()) }),
        ),
      );
    }),
  );

  // header order
  $("headers-list").replaceChildren(
    ...draft.recipientHeaders.map((h, i) =>
      el(
        "li",
        {},
        el("span", { text: h }),
        el("button", { type: "button", class: "secondary icon", title: "nach oben", text: "▲", disabled: i === 0, onclick: () => (moveItem(draft.recipientHeaders, i, -1), markDirty()) }),
        " ",
        el("button", { type: "button", class: "secondary icon", title: "nach unten", text: "▼", disabled: i === draft.recipientHeaders.length - 1, onclick: () => (moveItem(draft.recipientHeaders, i, 1), markDirty()) }),
        " ",
        el("button", { type: "button", class: "secondary icon", title: "entfernen", text: "✕", onclick: () => (draft.recipientHeaders.splice(i, 1), markDirty()) }),
      ),
    ),
  );

  $("save-state").textContent = dirty ? "Ungespeicherte Änderungen" : "Alles gespeichert";
}

async function save() {
  try {
    const config = validateConfig(draft);
    await messenger.storage.local.set({ config });
    saved = config;
    draft = clone(config);
    dirty = false;
    saveProblems = [];
    renderSettings();
    renderStatus();
  } catch (e) {
    saveProblems = e.problems ?? [String(e)];
    renderSettings();
  }
}

function setJsonState(text) {
  $("json-state").textContent = text;
}

function doImport(text) {
  try {
    draft = importConfig(text, draft);
    saveProblems = [];
    markDirty();
    setJsonState("Importiert. Zum Übernehmen Speichern klicken.");
  } catch (e) {
    setJsonState(`Import fehlgeschlagen: ${(e.problems ?? [String(e)]).join("; ")}`);
  }
}

function exportText() {
  return JSON.stringify(exportConfig(draft), null, 2) + "\n";
}

// ---------------------------------------------------------------- wiring

function showTab(name) {
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
  $("tab-status").hidden = name !== "status";
  $("tab-settings").hidden = name !== "settings";
  history.replaceState(null, "", `#${name}`);
}

function wire() {
  for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => showTab(b.dataset.tab));

  $("run-now").addEventListener("click", async (ev) => {
    const button = ev.currentTarget;
    button.disabled = true;
    button.textContent = "Läuft …";
    try {
      await send("runNow");
    } finally {
      button.disabled = false;
      button.textContent = "Jetzt prüfen";
    }
  });
  $("clear-log").addEventListener("click", () => send("clearLog"));
  $("log-filter").addEventListener("change", renderLog);
  $("reset-index").addEventListener("click", async (ev) => {
    ev.currentTarget.disabled = true;
    try {
      await send("resetIndex");
    } finally {
      ev.currentTarget.disabled = false;
    }
  });

  $("account").addEventListener("change", async (ev) => {
    draft.accountId = ev.target.value || null;
    await loadFolders(draft.accountId);
    markDirty();
  });
  $("dry-run").addEventListener("change", (ev) => {
    draft.dryRun = ev.target.checked;
    markDirty();
  });
  $("default-delay").addEventListener("change", (ev) => {
    draft.defaultDelayMinutes = parseDelay(ev.target.value);
    markDirty();
  });
  $("max-moves").addEventListener("change", (ev) => {
    draft.maxMovesPerRun = parseDelay(ev.target.value);
    markDirty();
  });
  $("add-rule").addEventListener("click", () => {
    draft.rules.push({ addresses: [], folder: "", delayMinutes: null });
    markDirty();
  });
  const addHeader = () => {
    const name = $("new-header").value.trim();
    if (!name) return;
    draft.recipientHeaders.push(name);
    $("new-header").value = "";
    markDirty();
  };
  $("add-header").addEventListener("click", addHeader);
  $("new-header").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") addHeader();
  });

  $("save").addEventListener("click", save);
  $("discard").addEventListener("click", () => {
    draft = clone(saved);
    dirty = false;
    saveProblems = [];
    renderSettings();
  });
  $("defaults").addEventListener("click", () => {
    const d = defaultConfig();
    draft = { ...d, accountId: draft.accountId, dryRun: draft.dryRun };
    markDirty();
  });

  $("export").addEventListener("click", () => {
    $("json").value = exportText();
    setJsonState("Zeigt die Regeln aus dem Formular (auch ungespeicherte Änderungen).");
  });
  $("copy").addEventListener("click", async () => {
    if (!$("json").value.trim()) $("json").value = exportText();
    try {
      await navigator.clipboard.writeText($("json").value);
      setJsonState("In die Zwischenablage kopiert.");
    } catch {
      $("json").select();
      setJsonState("Kopieren ging nicht automatisch, der Text ist markiert (Strg+C).");
    }
  });
  $("download").addEventListener("click", () => {
    const blob = new Blob([exportText()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: "mail-sortierer-regeln.json" });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });
  $("import").addEventListener("click", () => doImport($("json").value));
  $("import-file").addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    $("json").value = text;
    doImport(text);
    ev.target.value = "";
  });

  window.addEventListener("beforeunload", (ev) => {
    if (dirty) ev.preventDefault();
  });
}

function onStorageChanged(changes, area) {
  if (area !== "local") return;
  if (changes.index) data.index = changes.index.newValue ?? {};
  if (changes.log) data.log = changes.log.newValue ?? [];
  if (changes.status) data.status = changes.status.newValue ?? {};
  if (changes.config) {
    const next = loadConfig(changes.config.newValue).config;
    if (JSON.stringify(next) !== JSON.stringify(saved)) {
      saved = next;
      if (!dirty) {
        draft = clone(saved);
        loadFolders(draft.accountId).then(renderSettings);
      }
    }
  }
  scheduleStatus();
}

async function init() {
  wire();
  const stored = await messenger.storage.local.get(["config", "index", "log", "status"]);
  saved = loadConfig(stored.config).config;
  draft = clone(saved);
  data = { index: stored.index ?? {}, log: stored.log ?? [], status: stored.status ?? {} };
  accounts = await messenger.accounts.list(false);
  await loadFolders(draft.accountId);
  renderSettings();
  renderStatus();
  const wanted = location.hash.slice(1);
  showTab(wanted === "settings" || wanted === "status" ? wanted : saved.accountId ? "status" : "settings");
  messenger.storage.onChanged.addListener(onStorageChanged);
  setInterval(renderStatus, 30_000);
}

init().catch((e) => {
  document.body.prepend(el("div", { class: "alert error", text: `Seite konnte nicht geladen werden: ${e?.message ?? e}` }));
});
