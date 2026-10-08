// Scheduler tests against the mocked messenger API.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultConfig } from "../src/config.js";
import { createSorter } from "../src/sorter.js";
import { createMockMessenger } from "./support/mock-messenger.js";

const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);
const MIN = 60_000;
const SUBFOLDERS = [
  "finanzen@braunben.de",
  "job@braunben.de",
  "schule@braunben.de",
  "apple@brauben.de",
  "dev@braunben.de",
  "privat@braunben.de",
  "social@braunben.de",
  "gaming@braunben.de",
  "spam@braunben.de",
];

/** "Tue, 06 Oct 2026 14:03:59 +0200" for an epoch time. */
function rfcDate(t) {
  const d = new Date(t + 2 * 3600_000);
  const p = (n) => String(n).padStart(2, "0");
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${day}, ${p(d.getUTCDate())} ${mon} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0200`;
}

function setup({ limits = {}, subfolders = SUBFOLDERS } = {}) {
  const mock = createMockMessenger();
  mock.addAccount("account1", { INBOX: subfolders, Sent: [], Trash: [] });
  mock.addAccount("account2", { INBOX: ["dev@braunben.de"] }, "Anderes Konto");
  const clock = { t: T0 };
  const make = () => createSorter({ api: mock.api, now: () => clock.t, limits });
  const env = {
    mock,
    clock,
    api: mock.api,
    sorter: make(),
    /** Thunderbird restart: new session, new message ids, new background page. */
    async restart() {
      await mock.restart();
      env.sorter = make();
    },
    async setConfig(patch = {}) {
      await mock.api.storage.local.set({ config: { ...defaultConfig(), accountId: "account1", ...patch } });
    },
    advance(minutes) {
      clock.t += minutes * MIN;
    },
    inbox(accountId = "account1") {
      return mock.folder(accountId, "INBOX");
    },
    /** Adds a message to the inbox (no event). The Received header says it arrived `ago` minutes back. */
    mail(subject, { to = "dev@braunben.de", header = "Delivered-To", ago = 0, received = true, extra = "", accountId = "account1", messageId, date } = {}) {
      const at = clock.t - ago * MIN;
      const lines = [
        received ? `Received: from mout.example.org (mout.example.org [1.2.3.4])\r\n\tby mx.kundenserver.de with ESMTPS; ${rfcDate(at)}` : null,
        received ? `Received: from client by mout.example.org; ${rfcDate(at - 5 * MIN)}` : null,
        `${header}: ${to}`,
        "To: Ben <ben@braunben.de>",
        `Subject: ${subject}`,
        extra,
      ].filter(Boolean);
      return mock.addMessage({ accountId, subject, headers: lines.join("\n"), messageId, date: date ?? at - 5 * MIN });
    },
    /** A message arrives while Thunderbird runs: added and reported via onNewMailReceived. */
    async arrive(subject, opts = {}) {
      const h = env.mail(subject, opts);
      await env.sorter.onNewMail(env.inbox(opts.accountId), { id: null, messages: [h] });
      return h;
    },
    inInbox() {
      return mock.messagesIn("account1", "INBOX").map((m) => m.subject).sort();
    },
    inFolder(name) {
      return mock.messagesIn("account1", `INBOX/${name}`).map((m) => m.subject).sort();
    },
    async stored() {
      return mock.api.storage.local.get(["index", "log", "status", "history"]);
    },
  };
  return env;
}

describe("sorter: delays and moves", () => {
  it("leaves new mail in the inbox and moves it after the delay", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    await env.arrive("Build kaputt");
    assert.deepEqual(env.inInbox(), ["Build kaputt"]);
    assert.equal(env.mock.calls.getFull.length, 1);

    env.advance(44);
    await env.sorter.tick();
    assert.deepEqual(env.inInbox(), ["Build kaputt"]);

    env.advance(1);
    await env.sorter.tick();
    assert.deepEqual(env.inInbox(), []);
    assert.deepEqual(env.inFolder("dev@braunben.de"), ["Build kaputt"]);
    const { log, index } = await env.stored();
    assert.deepEqual(Object.keys(index), []);
    assert.equal(log[0].kind, "moved");
    assert.equal(log[0].folder, "INBOX/dev@braunben.de");
    assert.equal(log[0].header, "Delivered-To");
    assert.equal(log[0].address, "dev@braunben.de");
    assert.equal(log[0].source, "Received");
    assert.equal(log[0].ageMinutes, 45);
  });

  it("moves spam right away", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    await env.arrive("Gewinnspiel", { to: "spam@braunben.de" });
    assert.deepEqual(env.inFolder("spam@braunben.de"), ["Gewinnspiel"]);
  });

  it("does not change the read state when moving", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    const h = env.mock.addMessage({
      subject: "Gelesen",
      headers: `Received: from a by b; ${rfcDate(T0 - 60 * MIN)}\nDelivered-To: job@braunben.de`,
      read: true,
    });
    await env.sorter.onNewMail(env.inbox(), { id: null, messages: [h] });
    assert.deepEqual(env.mock.messagesIn("account1", "INBOX/job@braunben.de").map((m) => m.read), [true]);
  });

  it("counts the age from the topmost Received header, not from when Thunderbird saw the mail", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    await env.arrive("Alt", { ago: 40 }); // Thunderbird was busy or the PC just woke up
    env.advance(5);
    await env.sorter.tick();
    assert.deepEqual(env.inFolder("dev@braunben.de"), ["Alt"]);
  });

  it("falls back to the first sighting when the mail has no usable date", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    await env.arrive("Ohne Datum", { received: false });
    const { index } = await env.stored();
    assert.equal(Object.values(index)[0].arrivalSource, "firstSeen");
    env.advance(44);
    await env.sorter.tick();
    assert.deepEqual(env.inInbox(), ["Ohne Datum"]);
    env.advance(1);
    await env.sorter.tick();
    assert.deepEqual(env.inInbox(), []);
  });

  it("uses the priority list and the header order", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    await env.arrive("Mehrere", { header: "To", to: "gaming@braunben.de, finanzen@braunben.de, spam@braunben.de", ago: 60 });
    await env.arrive("Envelope", { header: "X-Original-To", to: "schule@braunben.de", extra: "Cc: job@braunben.de", ago: 60 });
    assert.deepEqual(env.inFolder("finanzen@braunben.de"), ["Mehrere"]);
    assert.deepEqual(env.inFolder("schule@braunben.de"), ["Envelope"]);
  });

  it("sends apple mail to the folder spelled without the n", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    await env.arrive("Rechnung", { to: "apple@braunben.de", ago: 60 });
    assert.deepEqual(env.inFolder("apple@brauben.de"), ["Rechnung"]);
  });

  it("applies a changed delay without reading the headers again", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    await env.arrive("Schnell");
    env.advance(10);
    await env.sorter.tick();
    assert.deepEqual(env.inInbox(), ["Schnell"]);
    const cfg = defaultConfig();
    cfg.rules.find((r) => r.addresses[0] === "dev@braunben.de").delayMinutes = 10;
    await env.setConfig({ dryRun: false, rules: cfg.rules });
    await env.sorter.tick("config");
    assert.deepEqual(env.inFolder("dev@braunben.de"), ["Schnell"]);
    assert.equal(env.mock.calls.getFull.length, 1);
  });

  it("reads the headers again when a new header is added to the order", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    await env.arrive("Weitergeleitet", { header: "X-Forwarded-To", to: "privat@braunben.de", ago: 60 });
    assert.deepEqual(env.inInbox(), ["Weitergeleitet"]);
    await env.setConfig({ dryRun: false, recipientHeaders: ["X-Forwarded-To", "Delivered-To", "To"] });
    await env.sorter.tick("config");
    assert.equal(env.mock.calls.getFull.length, 2);
    assert.deepEqual(env.inFolder("privat@braunben.de"), ["Weitergeleitet"]);
  });
});

describe("sorter: DRY_RUN", () => {
  it("is on by default, moves nothing and reports each mail once", async () => {
    const env = setup();
    await env.api.storage.local.set({ config: { ...defaultConfig(), accountId: "account1" } });
    await env.arrive("Test", { ago: 50 });
    await env.arrive("Spam", { to: "spam@braunben.de" });
    env.advance(1);
    await env.sorter.tick();
    env.advance(1);
    await env.sorter.tick();
    assert.deepEqual(env.inInbox(), ["Spam", "Test"]);
    assert.equal(env.mock.calls.move.length, 0);
    const { log, status } = await env.stored();
    const dry = log.filter((l) => l.kind === "dryrun").map((l) => `${l.subject} -> ${l.folder}`).sort();
    assert.deepEqual(dry, ["Spam -> INBOX/spam@braunben.de", "Test -> INBOX/dev@braunben.de"]);
    assert.equal(status.dryRun, true);
    assert.equal(env.api.action.badge, "TEST");
  });

  it("moves the reported mails once DRY_RUN is switched off", async () => {
    const env = setup();
    await env.setConfig();
    await env.arrive("Test", { ago: 50 });
    assert.deepEqual(env.inInbox(), ["Test"]);
    await env.setConfig({ dryRun: false });
    await env.sorter.tick("config");
    assert.deepEqual(env.inFolder("dev@braunben.de"), ["Test"]);
    assert.equal(env.api.action.badge, "");
  });

  it("falls back to DRY_RUN when the stored settings are broken", async () => {
    const env = setup();
    await env.api.storage.local.set({ config: { accountId: "account1", dryRun: false, rules: "kaputt" } });
    await env.arrive("Test", { ago: 50 });
    await env.sorter.tick();
    assert.equal(env.mock.calls.move.length, 0);
    const { status } = await env.stored();
    assert.ok(status.configProblems.length > 0);
  });
});

describe("sorter: what stays in the inbox", () => {
  it("keeps mail that matches no address and reads its headers only once, across restarts too", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    await env.arrive("Newsletter", { to: "ben@braunben.de", ago: 500 });
    await env.sorter.tick("manual");
    await env.restart();
    await env.sorter.tick("start");
    env.advance(120);
    await env.sorter.tick();
    assert.deepEqual(env.inInbox(), ["Newsletter"]);
    assert.equal(env.mock.calls.getFull.length, 1);
  });

  it("ignores display names that look like our addresses", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    await env.arrive("Phishing", { header: "To", to: '"dev@braunben.de" <evil@example.org>', ago: 500 });
    assert.deepEqual(env.inInbox(), ["Phishing"]);
  });

  it("only watches the inbox of the chosen account", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    await env.arrive("Anderes Konto", { accountId: "account2", to: "spam@braunben.de" });
    const sub = env.mock.addMessage({ path: "INBOX/dev@braunben.de", subject: "Unterordner", headers: "Delivered-To: spam@braunben.de" });
    await env.sorter.onNewMail(env.mock.folder("account1", "INBOX/dev@braunben.de"), { id: null, messages: [sub] });
    assert.equal(env.mock.calls.getFull.length, 0);
    assert.equal(env.mock.calls.move.length, 0);
  });

  it("does nothing without an account", async () => {
    const env = setup();
    await env.api.storage.local.set({ config: defaultConfig() });
    env.mail("Irgendwas", { ago: 500 });
    await env.sorter.tick("start");
    assert.equal(env.mock.calls.accountsGet, 0);
    assert.equal(env.mock.calls.list, 0);
  });

  it("leaves a mail alone that was moved back into the inbox by hand", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    await env.arrive("Zurück", { ago: 60 });
    assert.deepEqual(env.inFolder("dev@braunben.de"), ["Zurück"]);
    env.advance(5);
    const id = env.mock.findId("Zurück");
    await env.sorter.onMoved(...env.mock.moveByUser(id, "account1", "INBOX"));
    env.advance(120);
    await env.sorter.tick();
    await env.sorter.tick("manual");
    assert.deepEqual(env.inInbox(), ["Zurück"]);
    const { log } = await env.stored();
    assert.match(log[0].text, /Von dir in den Posteingang verschoben/);
  });

  it("leaves a mail alone that the user dragged into the inbox from anywhere", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    env.mock.addMessage({ path: "Sent", subject: "Alt einsortiert", headers: "Delivered-To: dev@braunben.de" });
    await env.sorter.onMoved(...env.mock.moveByUser(env.mock.findId("Alt einsortiert"), "account1", "INBOX"));
    env.advance(120);
    await env.sorter.tick("manual");
    assert.deepEqual(env.inInbox(), ["Alt einsortiert"]);
  });

  it("leaves a mail alone that comes back without a move event (e.g. moved back on the iPhone)", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    await env.arrive("Vom iPhone zurück", { ago: 60 });
    assert.deepEqual(env.inFolder("dev@braunben.de"), ["Vom iPhone zurück"]);
    env.advance(5);
    env.mock.moveByUser(env.mock.findId("Vom iPhone zurück"), "account1", "INBOX"); // no event
    await env.sorter.tick("manual");
    env.advance(120);
    await env.sorter.tick();
    assert.deepEqual(env.inInbox(), ["Vom iPhone zurück"]);
    const { log } = await env.stored();
    assert.match(log[0].text, /schon einmal einsortiert/);
  });

  it("does not stop at an unreadable mail and tries it again later", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    env.mail("Kaputt", { ago: 60 });
    env.mail("Gut", { ago: 60 });
    env.mock.setFailFull("Kaputt");
    await env.sorter.tick("start");
    assert.deepEqual(env.inInbox(), ["Kaputt"]);
    const { log } = await env.stored();
    assert.ok(log.some((l) => l.kind === "error" && /Header nicht lesbar/.test(l.text)));
    env.mock.setFailFull("Kaputt", false);
    env.advance(61);
    await env.sorter.tick();
    assert.deepEqual(env.inInbox(), []);
  });
});

describe("sorter: robustness", () => {
  it("picks up mail that arrived while Thunderbird was closed", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    env.mail("Nachts", { ago: 300 });
    env.mail("Gerade eben", { ago: 2 });
    await env.sorter.tick("start");
    assert.deepEqual(env.inInbox(), ["Gerade eben"]);
    assert.deepEqual(env.inFolder("dev@braunben.de"), ["Nachts"]);
  });

  it("after a restart moves the right mail although the old ids now belong to others", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    await env.arrive("Für dev", { ago: 10 });
    await env.arrive("Unbekannt", { to: "ben@braunben.de" });
    await env.arrive("Für job", { to: "job@braunben.de", ago: 20 });
    await env.restart(); // ids are now reversed: the old id of "Für dev" belongs to another mail
    env.advance(30);
    await env.sorter.tick("start");
    assert.deepEqual(env.inFolder("job@braunben.de"), ["Für job"]);
    assert.deepEqual(env.inInbox(), ["Für dev", "Unbekannt"]);
    env.advance(5);
    await env.sorter.tick();
    assert.deepEqual(env.inFolder("dev@braunben.de"), ["Für dev"]);
    assert.deepEqual(env.inInbox(), ["Unbekannt"]);
    assert.equal(env.mock.calls.getFull.length, 3, "known mails are not read again after the restart");
  });

  it("never moves with a stale id: the alarm right after a restart scans first", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    await env.arrive("A", { ago: 60 * 2, to: "ben@braunben.de" });
    await env.arrive("B", { ago: 44 });
    await env.restart();
    env.advance(1);
    await env.sorter.tick("alarm"); // no onStartup event seen
    assert.deepEqual(env.inInbox(), ["A"]);
    assert.deepEqual(env.inFolder("dev@braunben.de"), ["B"]);
  });

  it("skips a mail that was moved or deleted by hand before it was due", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    await env.arrive("Selbst verschoben");
    await env.arrive("Gelöscht");
    env.mock.moveByUser(env.mock.findId("Selbst verschoben"), "account1", "Sent"); // no event delivered
    env.mock.deleteMessage(env.mock.findId("Gelöscht"));
    env.advance(46);
    await env.sorter.tick();
    assert.equal(env.mock.calls.move.length, 0);
    assert.deepEqual(env.mock.messagesIn("account1", "Sent").map((m) => m.subject), ["Selbst verschoben"]);
    const { index, log } = await env.stored();
    assert.deepEqual(Object.keys(index), []);
    assert.equal(log.filter((l) => l.kind === "info").length, 2);
  });

  it("forgets mails reported by onMoved/onDeleted", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    await env.arrive("Weg");
    await env.arrive("Gelöscht");
    await env.sorter.onMoved(...env.mock.moveByUser(env.mock.findId("Weg"), "account1", "Trash"));
    await env.sorter.onDeleted(env.mock.deleteMessage(env.mock.findId("Gelöscht")));
    const { index } = await env.stored();
    assert.deepEqual(Object.keys(index), []);
  });

  it("retries a failed move with growing pauses and gives up after five attempts, others go on", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    env.mock.failMove("Klemmt");
    env.mail("Klemmt", { ago: 60 });
    env.mail("Läuft", { ago: 60 });
    await env.sorter.tick("start");
    assert.deepEqual(env.inInbox(), ["Klemmt"]);
    assert.deepEqual(env.inFolder("dev@braunben.de"), ["Läuft"]);
    let attempts = 1;
    for (const wait of [1, 5, 15, 60]) {
      env.advance(wait - 0.5);
      await env.sorter.tick();
      assert.equal(env.mock.calls.move.length - 1, attempts, `no retry before ${wait} min`);
      env.advance(0.5);
      await env.sorter.tick();
      attempts++;
      assert.equal(env.mock.calls.move.length - 1, attempts);
    }
    env.advance(600);
    await env.sorter.tick();
    assert.equal(env.mock.calls.move.length - 1, 5);
    const { log, index } = await env.stored();
    assert.match(log[0].text, /Versuch 5.*Kein weiterer Versuch/);
    assert.equal(Object.values(index)[0].gaveUp, true);
    // "Jetzt prüfen" gives it another chance
    await env.sorter.tick("manual");
    assert.equal(env.mock.calls.move.length - 1, 6);
  });

  it("moves at most maxMovesPerRun mails per run, oldest first", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false, maxMovesPerRun: 3 });
    for (let i = 1; i <= 5; i++) env.mail(`Mail ${i}`, { ago: 100 - i });
    await env.sorter.tick("start");
    assert.deepEqual(env.inInbox(), ["Mail 4", "Mail 5"]);
    const { status } = await env.stored();
    assert.deepEqual(status.lastBatch, { moves: 3, deferred: 2 });
    env.advance(1);
    await env.sorter.tick();
    assert.deepEqual(env.inInbox(), []);
  });

  it("reports a missing folder with its siblings and keeps the other rules running", async () => {
    const env = setup({ subfolders: SUBFOLDERS.filter((f) => f !== "gaming@braunben.de") });
    await env.setConfig({ dryRun: false });
    await env.arrive("Spiel", { to: "gaming@braunben.de", ago: 60 });
    await env.arrive("Code", { to: "dev@braunben.de", ago: 60 });
    assert.deepEqual(env.inInbox(), ["Spiel"]);
    assert.deepEqual(env.inFolder("dev@braunben.de"), ["Code"]);
    const { status, log } = await env.stored();
    assert.equal(status.folderProblems.length, 1);
    assert.match(status.folderProblems[0].problem, /"gaming@braunben.de" fehlt unter "Posteingang"\. Vorhanden: finanzen@braunben.de/);
    assert.equal(log.filter((l) => l.kind === "error").length, 1, "the problem is logged once, not every minute");
    env.advance(1);
    await env.sorter.tick();
    assert.equal((await env.stored()).log.filter((l) => l.kind === "error").length, 1);
    assert.equal(env.api.action.badge, "!");
  });

  it("never runs twice at the same time and never moves a mail twice", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    for (let i = 1; i <= 4; i++) env.mail(`Mail ${i}`, { ago: 60 });
    env.mock.setMoveDelay(5);
    const late = env.mail("Spät", { to: "spam@braunben.de" });
    await Promise.all([
      env.sorter.tick("start"),
      env.sorter.tick("alarm"),
      env.sorter.onNewMail(env.inbox(), { id: null, messages: [late] }),
      env.sorter.tick("manual"),
      env.sorter.tick("alarm"),
    ]);
    assert.equal(env.mock.calls.move.length, 5);
    assert.deepEqual(new Set(env.mock.calls.move.map((c) => c.ids[0])).size, 5);
    assert.deepEqual(env.inInbox(), []);
  });

  it("an idle run makes no API calls", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    await env.arrive("Wartet");
    const before = { ...env.mock.calls, getFull: env.mock.calls.getFull.length, get: env.mock.calls.get.length };
    env.advance(1);
    await env.sorter.tick();
    env.advance(1);
    await env.sorter.tick();
    assert.equal(env.mock.calls.accountsGet, before.accountsGet);
    assert.equal(env.mock.calls.list, before.list);
    assert.equal(env.mock.calls.getFull.length, before.getFull);
  });

  it("re-lists the inbox every hour as a safety net", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    await env.sorter.tick("start");
    env.mail("Ohne Event", { ago: 120 }); // e.g. onNewMailReceived did not fire
    env.advance(59);
    await env.sorter.tick();
    assert.deepEqual(env.inInbox(), ["Ohne Event"]);
    env.advance(1);
    await env.sorter.tick();
    assert.deepEqual(env.inInbox(), []);
  });

  it("works through a large inbox in steps, newest first, reading each mail once", async () => {
    const env = setup({ limits: { fetchPerScan: 10, checkpointEvery: 4 } });
    await env.setConfig();
    for (let i = 0; i < 25; i++) env.mail(`Alt ${String(i).padStart(2, "0")}`, { to: "ben@braunben.de", ago: 1000 - i });
    await env.sorter.tick("start");
    let { status, index } = await env.stored();
    assert.equal(status.scan.complete, false);
    assert.equal(status.scan.pending, 15);
    assert.equal(status.scan.inboxCount, 25);
    assert.deepEqual(
      Object.values(index).map((e) => e.subject).sort(),
      Array.from({ length: 10 }, (_, i) => `Alt ${15 + i}`),
    );
    env.advance(1);
    await env.sorter.tick();
    env.advance(1);
    await env.sorter.tick();
    ({ status, index } = await env.stored());
    assert.equal(status.scan.complete, true);
    assert.equal(Object.keys(index).length, 25);
    assert.equal(env.mock.calls.getFull.length, 25);
    env.advance(1);
    await env.sorter.tick();
    assert.equal(env.mock.calls.getFull.length, 25);
  });

  it("tells two copies of one mail apart (one per alias)", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    const date = T0 - 10 * MIN;
    // Same Message-ID and date, so the same key; only the Delivered-To differs.
    const a = env.mail("Kopie an dev", { to: "dev@braunben.de", messageId: "same@example.org", date, ago: 10 });
    const b = env.mail("Kopie an job", { to: "job@braunben.de", messageId: "same@example.org", date, ago: 10 });
    await env.sorter.onNewMail(env.inbox(), { id: null, messages: [a, b] });
    const { index } = await env.stored();
    assert.equal(Object.keys(index).length, 2);
    await env.restart();
    await env.sorter.tick("start");
    assert.equal(env.mock.calls.getFull.length, 4, "ambiguous copies are read again after a restart");
    env.advance(40);
    await env.sorter.tick();
    assert.deepEqual(env.inFolder("dev@braunben.de"), ["Kopie an dev"]);
    assert.deepEqual(env.inFolder("job@braunben.de"), ["Kopie an job"]);
    assert.deepEqual(env.inInbox(), []);
  });

  it("forgets the old inbox when another account is chosen", async () => {
    const env = setup();
    await env.setConfig();
    await env.arrive("Konto 1", { ago: 5 });
    await env.setConfig({ accountId: "account2" });
    env.mail("Konto 2", { accountId: "account2", ago: 5 });
    await env.sorter.tick("config");
    const { index } = await env.stored();
    assert.deepEqual(Object.values(index).map((e) => e.subject), ["Konto 2"]);
  });

  it("follows paginated event lists", async () => {
    const env = setup();
    await env.setConfig({ dryRun: false });
    const msgs = Array.from({ length: 7 }, (_, i) => env.mail(`Spam ${i}`, { to: "spam@braunben.de" }));
    // Thunderbird delivers big lists in pages: first page + continueList()
    const followUps = {
      "evt-1": { id: "evt-2", messages: msgs.slice(3, 6) },
      "evt-2": { id: null, messages: msgs.slice(6) },
    };
    const realContinue = env.api.messages.continueList;
    env.api.messages.continueList = async (id) => followUps[id] ?? realContinue(id);
    await env.sorter.onNewMail(env.inbox(), { id: "evt-1", messages: msgs.slice(0, 3) });
    assert.equal(env.inFolder("spam@braunben.de").length, 7);
  });
});

describe("sorter: commands", () => {
  it("clears the log and rebuilds the index on request", async () => {
    const env = setup();
    await env.setConfig();
    await env.arrive("Eins", { ago: 60 });
    await env.sorter.command({ cmd: "clearLog" });
    assert.deepEqual((await env.stored()).log, []);
    await env.sorter.command({ cmd: "resetIndex" });
    assert.equal(env.mock.calls.getFull.length, 2);
    assert.deepEqual(
      Object.values((await env.stored()).index).map((e) => e.subject),
      ["Eins"],
    );
    assert.equal(await env.sorter.command({ cmd: "nope" }), undefined);
  });
});
