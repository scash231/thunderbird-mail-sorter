// Decides for one message: which folder (rule) it belongs to and whether it is old enough.

import { parseAddressList, parseHeaderFields } from "./headers";

export interface Rule {
  /** Position in the configured list; lower = higher priority. */
  priority: number;
  /** Target folder as configured, levels separated by "/". */
  folder: string;
  /** Lower-cased addresses that belong to this folder. */
  addresses: string[];
  delayMinutes: number;
}

export interface RuleMatch {
  rule: Rule;
  /** Header the decision was based on, as configured (e.g. "Delivered-To"). */
  header: string;
}

/**
 * Finds the rule for a message. The headers are checked in the configured order and the
 * first header that contains one of our addresses decides. Within that header the rule
 * with the highest priority wins. Only the topmost occurrence of each header counts:
 * the receiving server prepends its trace headers, older or forged copies sit below.
 */
export function findRule(headers: Map<string, string[]>, rules: readonly Rule[], headerOrder: readonly string[]): RuleMatch | null {
  for (const header of headerOrder) {
    const top = headers.get(header.toLowerCase())?.[0];
    if (!top) continue;
    const found = new Set(parseAddressList(top));
    if (found.size === 0) continue;
    for (const rule of rules) {
      if (rule.addresses.some((a) => found.has(a))) return { rule, header };
    }
  }
  return null;
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const INTERNALDATE = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})\s*$/;

/** Parses an IMAP INTERNALDATE ("06-Oct-2026 14:03:59 +0200") to epoch milliseconds. */
export function parseInternalDate(value: string): number | null {
  const m = INTERNALDATE.exec(value);
  if (!m) return null;
  const [, d, mon, y, hh, mm, ss, sign, zh, zm] = m;
  const month = MONTHS[mon!.toLowerCase()];
  const day = Number(d);
  const hour = Number(hh);
  const minute = Number(mm);
  const second = Number(ss);
  if (month === undefined || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 60) return null;
  const local = Date.UTC(Number(y), month, day, hour, minute, Math.min(second, 59));
  const check = new Date(local);
  if (check.getUTCDate() !== day) return null; // e.g. 31-Feb
  const offset = (Number(zh) * 60 + Number(zm)) * 60_000;
  return sign === "+" ? local - offset : local + offset;
}

export interface MessageInfo {
  uid: number;
  flags: string[];
  internalDate: string | null;
  header: string | null;
}

export type Decision =
  | { action: "move"; uid: number; rule: Rule; header: string; ageMinutes: number }
  | { action: "wait"; uid: number; rule: Rule; header: string; dueInMinutes: number }
  | { action: "keep"; uid: number; reason: "no-match" | "deleted" | "bad-date" };

/** Decides what to do with one message at time `now` (epoch ms). */
export function decide(msg: MessageInfo, rules: readonly Rule[], headerOrder: readonly string[], now: number): Decision {
  if (msg.flags.some((f) => f.toLowerCase() === "\\deleted")) return { action: "keep", uid: msg.uid, reason: "deleted" };
  const match = findRule(parseHeaderFields(msg.header ?? ""), rules, headerOrder);
  if (!match) return { action: "keep", uid: msg.uid, reason: "no-match" };
  const delayMs = match.rule.delayMinutes * 60_000;
  const received = msg.internalDate === null ? null : parseInternalDate(msg.internalDate);
  if (received === null) {
    // Without a date the age is unknown. Only folders without delay may move anyway.
    if (delayMs === 0) return { action: "move", uid: msg.uid, rule: match.rule, header: match.header, ageMinutes: 0 };
    return { action: "keep", uid: msg.uid, reason: "bad-date" };
  }
  const age = now - received;
  // Delay 0 means "right away", even if the server clock is a few seconds ahead of ours.
  if (delayMs === 0 || age >= delayMs) {
    return { action: "move", uid: msg.uid, rule: match.rule, header: match.header, ageMinutes: Math.max(0, Math.floor(age / 60_000)) };
  }
  return { action: "wait", uid: msg.uid, rule: match.rule, header: match.header, dueInMinutes: Math.ceil((delayMs - age) / 60_000) };
}
