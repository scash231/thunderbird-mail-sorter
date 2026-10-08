// Decides for one message: which folder (rule) it belongs to, when it arrived and
// whether it is old enough. Ported from the mail-mover worker (reference/classify.ts).

import { parseAddressList, stripComments } from "./headers.js";

/**
 * @typedef {object} Rule
 * @property {number} priority Position in the configured list; lower = higher priority.
 * @property {string} folder Target folder as configured, levels separated by "/".
 * @property {string[]} addresses Lower-cased addresses that belong to this folder.
 * @property {number} delayMinutes
 */

/**
 * Finds the rule for a message. The headers are checked in the configured order and the
 * first header that contains one of our addresses decides. Within that header the rule
 * with the highest priority wins. Only the topmost occurrence of each header counts:
 * the receiving server prepends its trace headers, older or forged copies sit below.
 * @param {Map<string, string[]>} headers lower-cased name -> values, topmost first
 * @param {readonly Rule[]} rules ordered by priority
 * @param {readonly string[]} headerOrder
 * @returns {{rule: Rule, header: string, address: string} | null}
 */
export function findRule(headers, rules, headerOrder) {
  for (const header of headerOrder) {
    const top = headers.get(header.toLowerCase())?.[0];
    if (!top) continue;
    const found = new Set(parseAddressList(top));
    if (found.size === 0) continue;
    for (const rule of rules) {
      const address = rule.addresses.find((a) => found.has(a));
      if (address) return { rule, header, address };
    }
  }
  return null;
}

/** The topmost value of each wanted header, the only part findRule() looks at. */
export function topValues(headers, names) {
  const tops = {};
  for (const name of names) {
    const top = headers.get(name.toLowerCase())?.[0];
    if (top) tops[name.toLowerCase()] = top.length > 2000 ? top.slice(0, 2000) : top;
  }
  return tops;
}

/** findRule() on the stored top values of a tracked message. */
export function findRuleInTops(tops, rules, headerOrder) {
  const map = new Map(Object.entries(tops || {}).map(([k, v]) => [k, [v]]));
  return findRule(map, rules, headerOrder);
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
// Obsolete zone names from RFC 5322 4.3. Military letters mean "unknown", read as UTC.
const ZONES = {
  ut: 0, utc: 0, gmt: 0, z: 0,
  est: -300, edt: -240, cst: -360, cdt: -300, mst: -420, mdt: -360, pst: -480, pdt: -420,
};
const DATE_TIME =
  /^(?:[A-Za-z]{3,9},?\s*)?(\d{1,2})\s*[ -]\s*([A-Za-z]{3})[A-Za-z]*\.?\s*[ -]\s*(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(?:([+-])(\d{2}):?(\d{2})|([A-Za-z]{1,3}))$/;

/**
 * Parses an RFC 5322 date-time ("Tue, 6 Oct 2026 14:03:59 +0200 (CEST)") to epoch
 * milliseconds. Accepts the obsolete forms (two-digit years, zone names, no seconds).
 * Returns null for anything it cannot read with certainty, a missing zone included.
 * @param {string} value
 * @returns {number | null}
 */
export function parseRfc5322Date(value) {
  if (typeof value !== "string") return null;
  const text = stripComments(value).replace(/\s+/g, " ").trim();
  const m = DATE_TIME.exec(text);
  if (!m) return null;
  const [, d, mon, y, hh, mm, ss, sign, zh, zm, zoneName] = m;
  const month = MONTHS[mon.toLowerCase()];
  let year = Number(y);
  if (y.length === 2) year += year < 50 ? 2000 : 1900;
  else if (y.length === 3) year += 1900;
  const day = Number(d);
  const hour = Number(hh);
  const minute = Number(mm);
  const second = ss === undefined ? 0 : Number(ss);
  if (month === undefined || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null;
  let offsetMinutes;
  if (sign) {
    if (Number(zm) > 59) return null;
    offsetMinutes = (Number(zh) * 60 + Number(zm)) * (sign === "-" ? -1 : 1);
  } else {
    const zone = zoneName.toLowerCase();
    if (zone in ZONES) offsetMinutes = ZONES[zone];
    else if (zone.length === 1 && zone !== "j") offsetMinutes = 0;
    else return null; // "CEST" and friends are not defined, better fall back than guess
  }
  const local = Date.UTC(year, month, day, hour, minute, Math.min(second, 59));
  if (new Date(local).getUTCDate() !== day) return null; // e.g. 31 Feb
  return local - offsetMinutes * 60_000;
}

/**
 * Reads the date of a Received header ("from ... by ...; Tue, 6 Oct 2026 14:03:59 +0200"),
 * which is what follows the last semicolon.
 * @param {string} value
 * @returns {number | null}
 */
export function parseReceivedDate(value) {
  if (typeof value !== "string") return null;
  for (const text of [stripComments(value), value]) {
    const semi = text.lastIndexOf(";");
    if (semi < 0) continue;
    const t = parseRfc5322Date(text.slice(semi + 1));
    if (t !== null) return t;
  }
  return null;
}

/**
 * When did the mail arrive? The topmost Received header was written by the last server,
 * at IONOS that is the moment the mail reached the mailbox. Fallback: the Date header
 * (set by the sender, can be off), then the moment the add-on first saw the mail.
 * The add-on cannot have seen a mail before it arrived, so later values are capped at
 * firstSeen. That also defuses server clocks running ahead and dates in the future.
 * @param {Map<string, string[]>} headers
 * @param {number} firstSeen epoch ms
 * @returns {{arrivedAt: number, source: "Received" | "Date" | "firstSeen"}}
 */
export function arrivalTime(headers, firstSeen) {
  const candidates = [
    ["Received", parseReceivedDate(headers.get("received")?.[0])],
    ["Date", parseRfc5322Date(headers.get("date")?.[0])],
  ];
  for (const [source, t] of candidates) {
    if (t !== null) return { arrivedAt: Math.min(t, firstSeen), source };
  }
  return { arrivedAt: firstSeen, source: "firstSeen" };
}

/**
 * Stable key of a message across Thunderbird restarts (message ids are only valid for
 * one session). Two copies of the same mail (one per alias) share the key, callers
 * tell them apart.
 */
export function messageKey(msg) {
  const raw = msg.date instanceof Date ? msg.date.getTime() : new Date(msg.date ?? NaN).getTime();
  return `${msg.headerMessageId ?? ""}|${Number.isFinite(raw) ? raw : ""}`;
}

/**
 * Decides what to do with one tracked message at time `now` (epoch ms).
 * @param {object} entry tracked message (see sorter.js)
 * @param {readonly Rule[]} rules
 * @param {readonly string[]} headerOrder
 * @param {number} now
 */
export function planEntry(entry, rules, headerOrder, now) {
  if (!entry.tops) return { action: "keep", reason: "unread" };
  const match = findRuleInTops(entry.tops, rules, headerOrder);
  if (!match) return { action: "keep", reason: "no-match" };
  const { rule, header, address } = match;
  const base = { rule, header, address };
  if (entry.returned === rule.folder) return { action: "keep", reason: "returned", ...base };
  if (entry.gaveUp) return { action: "keep", reason: "failed", ...base };
  const delayMs = rule.delayMinutes * 60_000;
  const dueAt = entry.arrivedAt + delayMs;
  const ageMinutes = Math.max(0, Math.floor((now - entry.arrivedAt) / 60_000));
  // Delay 0 means "right away", even if the arrival time is a few seconds ahead of ours.
  if (delayMs === 0 || now >= dueAt) {
    if (entry.nextTryAt && entry.nextTryAt > now) return { action: "wait", reason: "retry", dueAt: entry.nextTryAt, ...base };
    return { action: "move", dueAt, ageMinutes, ...base };
  }
  return { action: "wait", reason: "delay", dueAt, ...base };
}
