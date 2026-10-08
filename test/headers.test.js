// Ported from the mail-mover worker (test/headers.test.ts), plus the getFull() adapter.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { headersFromPart, parseAddressList, parseHeaderFields, stripComments, unfold } from "../src/headers.js";

describe("parseHeaderFields", () => {
  it("lower-cases names, keeps order and unfolds continuation lines", () => {
    const h = parseHeaderFields(
      "Delivered-To: dev@braunben.de\r\n" +
        "To: A <a@x.de>,\r\n\t B <b@x.de>\r\n" +
        "DELIVERED-TO: old@gmail.com\r\n" +
        "\r\n" +
        "Body: not a header\r\n",
    );
    assert.deepEqual(h.get("delivered-to"), ["dev@braunben.de", "old@gmail.com"]);
    assert.deepEqual(h.get("to"), ["A <a@x.de>, B <b@x.de>"]);
    assert.equal(h.has("body"), false);
  });

  it("copes with LF-only line ends and garbage lines", () => {
    const h = parseHeaderFields("no colon here\nCc: c@x.de\n");
    assert.deepEqual(h.get("cc"), ["c@x.de"]);
    assert.equal(h.size, 1);
  });

  it("returns an empty map for empty input", () => {
    assert.equal(parseHeaderFields("").size, 0);
  });
});

describe("parseAddressList", () => {
  const cases = [
    ["dev@braunben.de", ["dev@braunben.de"]],
    ["<Dev@BraunBen.de>", ["dev@braunben.de"]],
    ["Ben <dev@braunben.de>", ["dev@braunben.de"]],
    ['"Braun, Ben" <job@braunben.de>, privat@braunben.de', ["job@braunben.de", "privat@braunben.de"]],
    ["job@braunben.de (Ben, Arbeit), dev@braunben.de", ["job@braunben.de", "dev@braunben.de"]],
    ["Team: a@x.de, b@x.de;, c@x.de", ["a@x.de", "b@x.de", "c@x.de"]],
    ["undisclosed-recipients:;", []],
    ["<@relay.example:dev@braunben.de>", ["dev@braunben.de"]],
    ['"Ben \\"the\\" Dev" <dev@braunben.de>', ["dev@braunben.de"]],
    ["=?UTF-8?Q?J=C3=BCrgen?= <privat@braunben.de>", ["privat@braunben.de"]],
    ["=?UTF-8?Q?Braun=2C_Ben?= <job@braunben.de>", ["job@braunben.de"]],
    ["", []],
  ];
  for (const [input, expected] of cases) {
    it(`parses ${JSON.stringify(input)}`, () => {
      assert.deepEqual(parseAddressList(input), expected);
    });
  }

  it("never takes an address from a display name", () => {
    assert.deepEqual(parseAddressList('"dev@braunben.de" <evil@example.org>'), ["evil@example.org"]);
    assert.deepEqual(parseAddressList("dev@braunben.de <evil@example.org>"), ["evil@example.org"]);
    assert.deepEqual(parseAddressList('"spam@braunben.de"'), ['"spam@braunben.de"']);
  });

  it("does not match longer addresses that contain ours", () => {
    assert.deepEqual(parseAddressList("xdev@braunben.de, dev@braunben.de.evil.com"), [
      "xdev@braunben.de",
      "dev@braunben.de.evil.com",
    ]);
  });
});

describe("unfold / stripComments", () => {
  it("joins folded lines", () => {
    assert.equal(unfold("A <a@x.de>,\r\n\t B <b@x.de>\r\n"), "A <a@x.de>, B <b@x.de>");
    assert.equal(unfold("a\n b"), "a b");
  });

  it("removes nested comments but keeps quoted strings", () => {
    assert.equal(stripComments("Tue, 6 Oct 2026 (a (nested) comment) 14:03:59 +0200 (CEST)").replace(/\s+/g, " ").trim(), "Tue, 6 Oct 2026 14:03:59 +0200");
    assert.equal(stripComments('"(not a comment)" x'), '"(not a comment)" x');
  });
});

describe("headersFromPart (messages.getFull result)", () => {
  it("prefers rawHeaders, lower-cases names, unfolds and keeps the order", () => {
    const h = headersFromPart({
      rawHeaders: {
        Received: ["from b by mx.ionos;\r\n\tTue, 6 Oct 2026 14:03:59 +0200", "from a by b; Tue, 6 Oct 2026 14:03:50 +0200"],
        "delivered-to": ["dev@braunben.de"],
        to: ["=?UTF-8?Q?Braun=2C_Ben?= <job@braunben.de>"],
      },
      headers: { to: ["Braun, Ben <job@braunben.de>"] },
    });
    assert.deepEqual(h.get("received"), ["from b by mx.ionos; Tue, 6 Oct 2026 14:03:59 +0200", "from a by b; Tue, 6 Oct 2026 14:03:50 +0200"]);
    assert.deepEqual(h.get("to"), ["=?UTF-8?Q?Braun=2C_Ben?= <job@braunben.de>"]);
    assert.deepEqual(h.get("delivered-to"), ["dev@braunben.de"]);
  });

  it("falls back to decoded headers and survives junk", () => {
    assert.deepEqual(headersFromPart({ headers: { To: ["dev@braunben.de"] } }).get("to"), ["dev@braunben.de"]);
    assert.equal(headersFromPart(null).size, 0);
    assert.equal(headersFromPart({ rawHeaders: { x: [] } }).size, 0);
    assert.deepEqual(headersFromPart({ rawHeaders: { x: "single" } }).get("x"), ["single"]);
  });
});
