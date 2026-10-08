// findRule tests are ported from the mail-mover worker (test/classify.test.ts). Date
// parsing, arrival time and planning are new: the add-on reads the Received/Date
// headers instead of the IMAP INTERNALDATE.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  arrivalTime,
  findRule,
  findRuleInTops,
  messageKey,
  parseReceivedDate,
  parseRfc5322Date,
  planEntry,
  topValues,
} from "../src/classify.js";
import { parseHeaderFields } from "../src/headers.js";

const rules = [
  { priority: 0, folder: "INBOX/job@braunben.de", addresses: ["job@braunben.de"], delayMinutes: 45 },
  { priority: 1, folder: "INBOX/dev@braunben.de", addresses: ["dev@braunben.de", "code@braunben.de"], delayMinutes: 45 },
  { priority: 2, folder: "INBOX/spam@braunben.de", addresses: ["spam@braunben.de"], delayMinutes: 0 },
];
const order = ["X-Original-To", "Delivered-To", "Envelope-To", "To", "Cc"];
const h = (text) => parseHeaderFields(text.replace(/\n/g, "\r\n") + "\r\n\r\n");

describe("findRule", () => {
  it("prefers envelope headers over To/Cc", () => {
    const m = findRule(h("X-Original-To: dev@braunben.de\nTo: job@braunben.de"), rules, order);
    assert.equal(m?.rule.folder, "INBOX/dev@braunben.de");
    assert.equal(m?.header, "X-Original-To");
    assert.equal(m?.address, "dev@braunben.de");
  });

  it("falls back to To and Cc when there is no envelope header for us", () => {
    assert.equal(findRule(h("Delivered-To: ben@braunben.de\nTo: Someone <dev@braunben.de>"), rules, order)?.header, "To");
    assert.equal(findRule(h("To: list@example.org\nCc: code@braunben.de"), rules, order)?.rule.folder, "INBOX/dev@braunben.de");
  });

  it("uses the priority list when one header names several of our addresses", () => {
    const m = findRule(h("To: dev@braunben.de, job@braunben.de, spam@braunben.de"), rules, order);
    assert.equal(m?.rule.folder, "INBOX/job@braunben.de");
  });

  it("puts spam last: a mail to spam@ and a real address goes to the real folder", () => {
    const m = findRule(h("To: spam@braunben.de, dev@braunben.de"), rules, order);
    assert.equal(m?.rule.folder, "INBOX/dev@braunben.de");
  });

  it("only looks at the topmost occurrence of a header", () => {
    // The lower Delivered-To was added by an earlier hop (or forged by the sender).
    const m = findRule(h("Delivered-To: ben@braunben.de\nDelivered-To: spam@braunben.de\nTo: dev@braunben.de"), rules, order);
    assert.equal(m?.rule.folder, "INBOX/dev@braunben.de");
  });

  it("is case-insensitive for addresses and header names", () => {
    assert.equal(findRule(h("delivered-to: <DEV@BRAUNBEN.DE>"), rules, order)?.rule.folder, "INBOX/dev@braunben.de");
  });

  it("returns null when nothing matches", () => {
    assert.equal(findRule(h("To: xdev@braunben.de\nCc: dev@braunben.de.evil.com"), rules, order), null);
    assert.equal(findRule(h('To: "dev@braunben.de" <evil@example.org>'), rules, order), null);
    assert.equal(findRule(new Map(), rules, order), null);
  });

  it("follows a custom header order", () => {
    const m = findRule(h("X-Original-To: dev@braunben.de\nTo: job@braunben.de"), rules, ["To", "X-Original-To"]);
    assert.equal(m?.rule.folder, "INBOX/job@braunben.de");
  });

  it("works the same on the stored top values", () => {
    const headers = h("Delivered-To: ben@braunben.de\nDelivered-To: spam@braunben.de\nTo: dev@braunben.de\nSubject: x");
    const tops = topValues(headers, order);
    assert.deepEqual(tops, { "delivered-to": "ben@braunben.de", to: "dev@braunben.de" });
    assert.equal(findRuleInTops(tops, rules, order)?.rule.folder, "INBOX/dev@braunben.de");
    assert.equal(findRuleInTops(null, rules, order), null);
  });
});

describe("parseRfc5322Date", () => {
  const utc = (...a) => Date.UTC(...a);
  it("parses the common forms", () => {
    assert.equal(parseRfc5322Date("Tue, 6 Oct 2026 14:03:59 +0200"), utc(2026, 9, 6, 12, 3, 59));
    assert.equal(parseRfc5322Date("Tue, 06 Oct 2026 14:03:59 +0200 (CEST)"), utc(2026, 9, 6, 12, 3, 59));
    assert.equal(parseRfc5322Date("6 Oct 2026 14:03 -0130"), utc(2026, 9, 6, 15, 33, 0));
    assert.equal(parseRfc5322Date("  Tue,  6  Oct  2026  14:03:59  +0000  "), utc(2026, 9, 6, 14, 3, 59));
    assert.equal(parseRfc5322Date("Wed, 31 Dec 2026 23:59:60 +0000"), utc(2026, 11, 31, 23, 59, 59));
  });

  it("accepts the obsolete forms", () => {
    assert.equal(parseRfc5322Date("Tue, 6 Oct 26 14:03:59 GMT"), utc(2026, 9, 6, 14, 3, 59));
    assert.equal(parseRfc5322Date("Tue, 6 Oct 99 14:03:59 UT"), utc(1999, 9, 6, 14, 3, 59));
    assert.equal(parseRfc5322Date("Tue, 6 Oct 2026 10:03:59 EDT"), utc(2026, 9, 6, 14, 3, 59));
    assert.equal(parseRfc5322Date("Tuesday, 6 October 2026 14:03:59 +02:00"), utc(2026, 9, 6, 12, 3, 59));
  });

  it("handles the switch to winter time (the offset decides, not the local clock)", () => {
    const summer = parseRfc5322Date("Sun, 25 Oct 2026 02:30:00 +0200");
    const winter = parseRfc5322Date("Sun, 25 Oct 2026 02:30:00 +0100");
    assert.equal(winter - summer, 3600_000);
  });

  it("rejects what it cannot read with certainty", () => {
    for (const bad of [
      "",
      "2026-10-06T10:00:00Z",
      "Tue, 32 Oct 2026 10:00:00 +0200",
      "Sat, 31 Feb 2026 10:00:00 +0000",
      "Tue, 6 Foo 2026 10:00:00 +0200",
      "Tue, 6 Oct 2026 25:00:00 +0200",
      "Tue, 6 Oct 2026 10:00:00",
      "Tue, 6 Oct 2026 10:00:00 CEST",
      "Tue, 6 Oct 2026 10:00:00 +0275",
      undefined,
      null,
    ]) {
      assert.equal(parseRfc5322Date(bad), null, String(bad));
    }
  });
});

describe("parseReceivedDate", () => {
  it("reads the date after the last semicolon", () => {
    const v =
      "from mout.example.org (mout.example.org [1.2.3.4]) by mx.kundenserver.de (mxeue001 [212.227.15.41]) with ESMTPS (Nemesis) id 1M; Tue, 06 Oct 2026 14:03:59 +0200";
    assert.equal(parseReceivedDate(v), Date.UTC(2026, 9, 6, 12, 3, 59));
  });

  it("ignores semicolons in comments", () => {
    const v = "from a by b; Tue, 6 Oct 2026 14:03:59 +0200 (CEST; really)";
    assert.equal(parseReceivedDate(v), Date.UTC(2026, 9, 6, 12, 3, 59));
  });

  it("returns null without a date", () => {
    assert.equal(parseReceivedDate("from a by b with SMTP"), null);
    assert.equal(parseReceivedDate("from a by b; garbage"), null);
    assert.equal(parseReceivedDate(undefined), null);
  });
});

describe("arrivalTime", () => {
  const seen = Date.UTC(2026, 9, 6, 13, 0, 0);
  it("uses the topmost Received header", () => {
    const headers = h(
      "Received: from x by mx.ionos; Tue, 6 Oct 2026 14:03:59 +0200\n" +
        "Received: from y by x; Tue, 6 Oct 2026 13:50:00 +0200\n" +
        "Date: Tue, 6 Oct 2026 13:00:00 +0200",
    );
    assert.deepEqual(arrivalTime(headers, seen), { arrivedAt: Date.UTC(2026, 9, 6, 12, 3, 59), source: "Received" });
  });

  it("falls back to Date, then to the moment the add-on saw the mail", () => {
    assert.deepEqual(arrivalTime(h("Received: from x by y\nDate: Tue, 6 Oct 2026 13:00:00 +0200"), seen), {
      arrivedAt: Date.UTC(2026, 9, 6, 11, 0, 0),
      source: "Date",
    });
    assert.deepEqual(arrivalTime(h("Date: yesterday"), seen), { arrivedAt: seen, source: "firstSeen" });
    assert.deepEqual(arrivalTime(new Map(), seen), { arrivedAt: seen, source: "firstSeen" });
  });

  it("never puts the arrival after the moment the add-on saw the mail", () => {
    const future = h("Received: from x by y; Tue, 6 Oct 2026 20:00:00 +0200");
    assert.deepEqual(arrivalTime(future, seen), { arrivedAt: seen, source: "Received" });
  });
});

describe("messageKey", () => {
  it("combines Message-ID and date, the parts that survive a restart", () => {
    assert.equal(messageKey({ id: 4, headerMessageId: "a@b", date: new Date(1000) }), "a@b|1000");
    assert.equal(messageKey({ id: 5, headerMessageId: "a@b", date: "1970-01-01T00:00:01.000Z" }), "a@b|1000");
    assert.equal(messageKey({ id: 6 }), "|");
  });
});

describe("planEntry", () => {
  const now = Date.UTC(2026, 9, 6, 12, 0, 0);
  const entry = (to, minutesAgo, extra = {}) => ({ tops: { to }, arrivedAt: now - minutesAgo * 60_000, ...extra });

  it("moves when the delay has passed, exactly at the boundary too", () => {
    assert.equal(planEntry(entry("dev@braunben.de", 45), rules, order, now).action, "move");
    assert.equal(planEntry(entry("dev@braunben.de", 45), rules, order, now).ageMinutes, 45);
    assert.equal(planEntry(entry("dev@braunben.de", 300), rules, order, now).action, "move");
  });

  it("waits while the mail is younger than the delay", () => {
    const p = planEntry(entry("dev@braunben.de", 44), rules, order, now);
    assert.equal(p.action, "wait");
    assert.equal(p.dueAt, now + 60_000);
    assert.equal(p.header, "To");
    assert.equal(planEntry(entry("dev@braunben.de", 0), rules, order, now).dueAt, now + 45 * 60_000);
  });

  it("moves delay-0 folders at once, even with an arrival slightly in the future", () => {
    assert.equal(planEntry(entry("spam@braunben.de", 0), rules, order, now).action, "move");
    const p = planEntry(entry("spam@braunben.de", -1), rules, order, now);
    assert.equal(p.action, "move");
    assert.equal(p.ageMinutes, 0);
  });

  it("keeps unmatched, unread, returned and given-up messages", () => {
    assert.equal(planEntry(entry("someone@example.org", 999), rules, order, now).reason, "no-match");
    assert.equal(planEntry({ tops: null }, rules, order, now).reason, "unread");
    assert.equal(planEntry(entry("dev@braunben.de", 999, { returned: "INBOX/dev@braunben.de" }), rules, order, now).reason, "returned");
    assert.equal(planEntry(entry("dev@braunben.de", 999, { gaveUp: true }), rules, order, now).reason, "failed");
  });

  it("a returned mark only counts for the folder it was made for", () => {
    const p = planEntry(entry("job@braunben.de", 999, { returned: "INBOX/dev@braunben.de" }), rules, order, now);
    assert.equal(p.action, "move");
  });

  it("waits for the retry time after a failed move", () => {
    const p = planEntry(entry("dev@braunben.de", 999, { nextTryAt: now + 5 * 60_000 }), rules, order, now);
    assert.deepEqual([p.action, p.reason, p.dueAt], ["wait", "retry", now + 5 * 60_000]);
    assert.equal(planEntry(entry("dev@braunben.de", 999, { nextTryAt: now }), rules, order, now).action, "move");
  });
});
