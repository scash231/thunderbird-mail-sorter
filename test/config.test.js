import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ConfigError,
  defaultConfig,
  effectiveRules,
  exportConfig,
  importConfig,
  loadConfig,
  neededHeaders,
  validateConfig,
} from "../src/config.js";

const referenceText = readFileSync(new URL("../reference/rules.json", import.meta.url), "utf8");
const reference = JSON.parse(referenceText);

describe("defaults", () => {
  const config = defaultConfig();

  it("are the values from reference/rules.json", () => {
    assert.deepEqual(exportConfig(config), { ...reference, maxMovesPerRun: 25 });
  });

  it("start in DRY_RUN without an account", () => {
    assert.equal(config.dryRun, true);
    assert.equal(config.accountId, null);
  });

  it("map every address to its folder, apple to the folder without the n", () => {
    const map = Object.fromEntries(config.rules.flatMap((r) => r.addresses.map((a) => [a, r.folder])));
    assert.deepEqual(map, {
      "apple@braunben.de": "INBOX/apple@brauben.de",
      "dev@braunben.de": "INBOX/dev@braunben.de",
      "finanzen@braunben.de": "INBOX/finanzen@braunben.de",
      "gaming@braunben.de": "INBOX/gaming@braunben.de",
      "job@braunben.de": "INBOX/job@braunben.de",
      "privat@braunben.de": "INBOX/privat@braunben.de",
      "schule@braunben.de": "INBOX/schule@braunben.de",
      "social@braunben.de": "INBOX/social@braunben.de",
      "spam@braunben.de": "INBOX/spam@braunben.de",
    });
  });

  it("have the priority finanzen, job, schule, apple, dev, privat, social, gaming, spam", () => {
    assert.deepEqual(
      effectiveRules(config).map((r) => r.addresses[0].split("@")[0]),
      ["finanzen", "job", "schule", "apple", "dev", "privat", "social", "gaming", "spam"],
    );
  });

  it("move spam at once and everything else after 45 minutes", () => {
    for (const r of effectiveRules(config)) assert.equal(r.delayMinutes, r.addresses[0] === "spam@braunben.de" ? 0 : 45);
  });

  it("are a fresh copy each time", () => {
    const a = defaultConfig();
    a.rules[0].addresses.push("x@y.de");
    assert.deepEqual(defaultConfig().rules[0].addresses, ["finanzen@braunben.de"]);
  });
});

describe("validateConfig", () => {
  it("accepts the defaults and normalises addresses and the INBOX case", () => {
    const c = validateConfig({
      ...defaultConfig(),
      accountId: "account1",
      rules: [{ addresses: ["Dev@BraunBen.de", " code@braunben.de "], folder: "inbox/Dev", delayMinutes: 0 }],
    });
    assert.deepEqual(c.rules, [{ addresses: ["dev@braunben.de", "code@braunben.de"], folder: "INBOX/Dev", delayMinutes: 0 }]);
    assert.equal(c.accountId, "account1");
  });

  it("only switches DRY_RUN off for an explicit false", () => {
    const base = defaultConfig();
    assert.equal(validateConfig({ ...base, dryRun: false }).dryRun, false);
    for (const v of [undefined, true, "false", 0, null]) assert.equal(validateConfig({ ...base, dryRun: v }).dryRun, true, String(v));
  });

  it("reports every problem at once", () => {
    const bad = {
      defaultDelayMinutes: -1,
      maxMovesPerRun: 0,
      recipientHeaders: ["To", "to"],
      rules: [
        { addresses: ["dev@braunben.de"], folder: "INBOX/dev" },
        { addresses: ["DEV@braunben.de"], folder: "INBOX/other" },
        { addresses: ["x@y.de"], folder: "INBOX/dev" },
        { addresses: ["not-an-address"], folder: "INBOX/z" },
        { addresses: [], folder: "INBOX/a" },
        { addresses: ["a@b.de"], folder: "/INBOX//x/" },
        { addresses: ["c@d.de"], folder: "INBOX" },
        { addresses: ["e@f.de"], folder: "INBOX/e", delayMinutes: 1.5, priority: 1 },
      ],
    };
    let error;
    try {
      validateConfig(bad);
    } catch (e) {
      error = e;
    }
    assert.ok(error instanceof ConfigError);
    for (const part of [
      "Standardverzögerung",
      "Höchstzahl pro Lauf",
      "Header-Reihenfolge enthält einen Header doppelt",
      "Adresse dev@braunben.de steht schon in Regel 1",
      'Zielordner "INBOX/dev" steht schon in Regel 1',
      '"not-an-address" ist keine gültige Adresse',
      "Regel 5: Adresse fehlt",
      "Regel 6: Zielordner fehlt oder ist ungültig",
      "Regel 7: Zielordner darf nicht der Posteingang selbst sein",
      "Regel 8: Verzögerung",
      'Regel 8: unbekannter Schlüssel "priority"',
    ]) {
      assert.ok(error.message.includes(part), `missing: ${part}\n${error.message}`);
    }
  });

  it("refuses empty rules and bad header names", () => {
    assert.throws(() => validateConfig({ rules: [] }), /mindestens eine Regel/);
    assert.throws(() => validateConfig({ ...defaultConfig(), recipientHeaders: ["To:"] }), /Header-Reihenfolge/);
    assert.throws(() => validateConfig(null), ConfigError);
  });
});

describe("loadConfig", () => {
  it("uses the defaults when nothing is stored", () => {
    assert.deepEqual(loadConfig(undefined), { config: defaultConfig(), problems: [] });
  });

  it("falls back to the defaults with DRY_RUN on when the stored settings are broken", () => {
    const { config, problems } = loadConfig({ accountId: "account7", dryRun: false, rules: [] });
    assert.equal(config.dryRun, true);
    assert.equal(config.accountId, "account7");
    assert.equal(config.rules.length, 9);
    assert.ok(problems.length > 0);
  });
});

describe("export / import", () => {
  it("imports reference/rules.json as is", () => {
    const current = { ...defaultConfig(), accountId: "account1", dryRun: false };
    const c = importConfig(referenceText, current);
    assert.equal(c.accountId, "account1");
    assert.equal(c.dryRun, false);
    assert.deepEqual(c.rules, defaultConfig().rules);
    assert.deepEqual(c.recipientHeaders, reference.recipientHeaders);
  });

  it("round-trips, with several addresses per folder and per-folder delays", () => {
    const config = validateConfig({
      ...defaultConfig(),
      rules: [
        { addresses: ["dev@braunben.de", "code@braunben.de"], folder: "INBOX/dev", delayMinutes: 10 },
        { addresses: ["spam@braunben.de"], folder: "INBOX/spam", delayMinutes: null },
      ],
    });
    const json = JSON.stringify(exportConfig(config));
    assert.ok(json.includes('"addresses":["dev@braunben.de","code@braunben.de"]'));
    assert.ok(!json.includes("accountId") && !json.includes("dryRun"));
    assert.deepEqual(importConfig(json, config), config);
  });

  it("reports bad JSON and unknown keys", () => {
    assert.throws(() => importConfig("{nope", defaultConfig()), /kein gültiges JSON/);
    assert.throws(() => importConfig("[]", defaultConfig()), /Objekt/);
    assert.throws(() => importConfig(JSON.stringify({ ...reference, typo: 1 }), defaultConfig()), /unbekannter Schlüssel "typo"/);
    assert.throws(
      () => importConfig(JSON.stringify({ rules: [{ address: "a@b.de", addresses: ["c@d.de"], folder: "X" }] }), defaultConfig()),
      /entweder/,
    );
  });
});

describe("neededHeaders", () => {
  it("lists the configured headers in lower case", () => {
    assert.deepEqual(neededHeaders(defaultConfig()), ["x-original-to", "delivered-to", "envelope-to", "to", "cc"]);
  });
});
