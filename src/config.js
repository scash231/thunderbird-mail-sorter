// Settings: defaults (taken from reference/rules.json), validation and JSON export/import.
// Validation is ported from the mail-mover worker's loadConfig(): every problem is
// reported at once, in German, because the messages end up in the options page.

export const DEFAULT_RECIPIENT_HEADERS = ["X-Original-To", "Delivered-To", "Envelope-To", "To", "Cc"];
export const DEFAULT_DELAY_MINUTES = 45;
export const DEFAULT_MAX_MOVES_PER_RUN = 25;
export const MAX_DELAY_MINUTES = 7 * 24 * 60;
export const MAX_RULES = 50;

const HEADER_NAME = /^[A-Za-z0-9-]+$/;
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const IMPORT_KEYS = ["defaultDelayMinutes", "recipientHeaders", "rules", "maxMovesPerRun"];
const RULE_KEYS = ["folder", "address", "addresses", "delayMinutes"];

/** The rules from reference/rules.json, order = priority (top = highest). */
const DEFAULT_RULES = [
  ["finanzen@braunben.de", "INBOX/finanzen@braunben.de"],
  ["job@braunben.de", "INBOX/job@braunben.de"],
  ["schule@braunben.de", "INBOX/schule@braunben.de"],
  ["apple@braunben.de", "INBOX/apple@brauben.de"], // the folder really is spelled without the n
  ["dev@braunben.de", "INBOX/dev@braunben.de"],
  ["privat@braunben.de", "INBOX/privat@braunben.de"],
  ["social@braunben.de", "INBOX/social@braunben.de"],
  ["gaming@braunben.de", "INBOX/gaming@braunben.de"],
  ["spam@braunben.de", "INBOX/spam@braunben.de", 0],
];

/** A fresh copy of the default settings. DRY_RUN is on and no account is chosen yet. */
export function defaultConfig() {
  return {
    accountId: null,
    dryRun: true,
    defaultDelayMinutes: DEFAULT_DELAY_MINUTES,
    maxMovesPerRun: DEFAULT_MAX_MOVES_PER_RUN,
    recipientHeaders: [...DEFAULT_RECIPIENT_HEADERS],
    rules: DEFAULT_RULES.map(([address, folder, delay]) => ({
      addresses: [address],
      folder,
      delayMinutes: delay ?? null,
    })),
  };
}

export class ConfigError extends Error {
  constructor(problems) {
    super("Einstellungen ungültig: " + problems.join("; "));
    this.name = "ConfigError";
    this.problems = problems;
  }
}

function isObj(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Folder paths are compared without regard to the case of the INBOX part. */
export function normFolder(path) {
  const p = String(path).trim();
  return /^inbox(\/|$)/i.test(p) ? "INBOX" + p.slice(5) : p;
}

/**
 * Checks the rule part of a configuration (as stored, or as imported from JSON).
 * Rules may use "address" (one) or "addresses" (several); delayMinutes null/absent means
 * "use the default". Returns the cleaned values plus the list of problems found.
 * @param {object} c
 */
export function checkRules(c) {
  const problems = [];
  const int = (v, where, min, max, fallback) => {
    if (v === undefined || v === null || v === "") return fallback;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      problems.push(`${where} muss eine ganze Zahl von ${min} bis ${max} sein`);
      return fallback;
    }
    return v;
  };

  const defaultDelayMinutes = int(c.defaultDelayMinutes, "Standardverzögerung", 0, MAX_DELAY_MINUTES, DEFAULT_DELAY_MINUTES);
  const maxMovesPerRun = int(c.maxMovesPerRun, "Höchstzahl pro Lauf", 1, 200, DEFAULT_MAX_MOVES_PER_RUN);

  let recipientHeaders = [...DEFAULT_RECIPIENT_HEADERS];
  if (c.recipientHeaders !== undefined) {
    const h = c.recipientHeaders;
    if (!Array.isArray(h) || h.length === 0 || !h.every((x) => typeof x === "string" && HEADER_NAME.test(x.trim()))) {
      problems.push('Header-Reihenfolge muss eine Liste von Header-Namen sein, z.B. ["Delivered-To", "To"]');
    } else if (new Set(h.map((x) => x.trim().toLowerCase())).size !== h.length) {
      problems.push("Header-Reihenfolge enthält einen Header doppelt");
    } else {
      recipientHeaders = h.map((x) => x.trim());
    }
  }

  const rules = [];
  if (!Array.isArray(c.rules) || c.rules.length === 0) {
    problems.push("Es muss mindestens eine Regel geben");
  } else if (c.rules.length > MAX_RULES) {
    problems.push(`Höchstens ${MAX_RULES} Regeln`);
  } else {
    const seenAddr = new Map();
    const seenFolder = new Map();
    c.rules.forEach((r, i) => {
      const where = `Regel ${i + 1}`;
      if (!isObj(r)) {
        problems.push(`${where} muss ein Objekt sein`);
        return;
      }
      for (const k of Object.keys(r)) if (!RULE_KEYS.includes(k)) problems.push(`${where}: unbekannter Schlüssel "${k}"`);
      const folder = typeof r.folder === "string" ? normFolder(r.folder) : "";
      if (!folder || folder.startsWith("/") || folder.endsWith("/") || folder.includes("//")) {
        problems.push(`${where}: Zielordner fehlt oder ist ungültig (Ebenen mit "/" trennen, z.B. "INBOX/dev@braunben.de")`);
      } else if (folder === "INBOX") {
        problems.push(`${where}: Zielordner darf nicht der Posteingang selbst sein`);
      } else if (seenFolder.has(folder)) {
        problems.push(`${where}: Zielordner "${folder}" steht schon in Regel ${seenFolder.get(folder) + 1} (mehrere Adressen mit Komma trennen)`);
      } else {
        seenFolder.set(folder, i);
      }
      let list = [];
      if (r.address !== undefined && r.addresses !== undefined) problems.push(`${where}: entweder "address" oder "addresses" angeben`);
      else if (typeof r.address === "string") list = [r.address];
      else if (Array.isArray(r.addresses) && r.addresses.length > 0) list = r.addresses;
      else problems.push(`${where}: Adresse fehlt`);
      const addresses = [];
      for (const a of list) {
        if (typeof a !== "string" || !ADDRESS.test(a.trim())) {
          problems.push(`${where}: "${String(a)}" ist keine gültige Adresse`);
          continue;
        }
        const addr = a.trim().toLowerCase();
        const prev = seenAddr.get(addr);
        if (prev !== undefined) problems.push(`${where}: Adresse ${addr} steht schon in Regel ${prev + 1}`);
        else seenAddr.set(addr, i);
        addresses.push(addr);
      }
      const delayMinutes = int(r.delayMinutes, `${where}: Verzögerung`, 0, MAX_DELAY_MINUTES, null);
      rules.push({ addresses, folder, delayMinutes });
    });
  }
  return { problems, values: { defaultDelayMinutes, maxMovesPerRun, recipientHeaders, rules } };
}

/**
 * Validates a complete stored configuration. Throws ConfigError with all problems.
 * @returns {ReturnType<typeof defaultConfig>}
 */
export function validateConfig(raw) {
  if (!isObj(raw)) throw new ConfigError(["Einstellungen fehlen"]);
  const { problems, values } = checkRules(raw);
  const accountId = raw.accountId === undefined || raw.accountId === null || raw.accountId === "" ? null : raw.accountId;
  if (accountId !== null && typeof accountId !== "string") problems.push("Konto ist ungültig");
  if (problems.length > 0) throw new ConfigError(problems);
  // DRY_RUN is only off for an explicit false. Anything else keeps it on.
  return { accountId, dryRun: raw.dryRun !== false, ...values };
}

/**
 * Stored settings -> settings to work with. Broken or missing settings fall back to
 * the defaults (with DRY_RUN on), so a damaged storage can never cause moves.
 */
export function loadConfig(raw) {
  if (raw === undefined || raw === null) return { config: defaultConfig(), problems: [] };
  try {
    return { config: validateConfig(raw), problems: [] };
  } catch (e) {
    const fallback = defaultConfig();
    if (isObj(raw) && typeof raw.accountId === "string") fallback.accountId = raw.accountId;
    return { config: fallback, problems: e.problems ?? [String(e)] };
  }
}

/**
 * The rules in the form classify.js works with: priority = position, delay resolved.
 * @returns {import("./classify.js").Rule[]}
 */
export function effectiveRules(config) {
  return config.rules.map((r, i) => ({
    priority: i,
    folder: r.folder,
    addresses: r.addresses,
    delayMinutes: r.delayMinutes ?? config.defaultDelayMinutes,
  }));
}

/** Settings as JSON in the format of reference/rules.json (no account, no DRY_RUN). */
export function exportConfig(config) {
  return {
    defaultDelayMinutes: config.defaultDelayMinutes,
    maxMovesPerRun: config.maxMovesPerRun,
    recipientHeaders: [...config.recipientHeaders],
    rules: config.rules.map((r) => {
      const out = r.addresses.length === 1 ? { address: r.addresses[0] } : { addresses: [...r.addresses] };
      out.folder = r.folder;
      if (r.delayMinutes !== null && r.delayMinutes !== undefined) out.delayMinutes = r.delayMinutes;
      return out;
    }),
  };
}

/**
 * Reads exported JSON (or reference/rules.json) and returns new settings. Account and
 * DRY_RUN are kept from `current`. Throws ConfigError with all problems.
 * @param {string} text
 * @param {ReturnType<typeof defaultConfig>} current
 */
export function importConfig(text, current) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ConfigError(["Das ist kein gültiges JSON"]);
  }
  if (!isObj(value)) throw new ConfigError(["JSON muss ein Objekt sein"]);
  const problems = [];
  for (const k of Object.keys(value)) if (!IMPORT_KEYS.includes(k)) problems.push(`unbekannter Schlüssel "${k}"`);
  const checked = checkRules(value);
  problems.push(...checked.problems);
  if (problems.length > 0) throw new ConfigError(problems);
  return { accountId: current.accountId ?? null, dryRun: current.dryRun !== false, ...checked.values };
}

/** Lower-cased names of all headers that must be stored per message for these settings. */
export function neededHeaders(config) {
  return [...new Set(config.recipientHeaders.map((h) => h.toLowerCase()))];
}
