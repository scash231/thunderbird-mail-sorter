import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findInbox, listFolders, resolveFolder, resolveTargets, sameFolder } from "../src/folders.js";
import { buildTree } from "./support/mock-messenger.js";

const root = buildTree("account1", {
  INBOX: ["dev@braunben.de", "apple@brauben.de", "Job@braunben.de", { name: "archiv", children: ["2025"] }],
  Sent: [],
  Trash: [],
});

describe("findInbox", () => {
  it("finds the folder with specialUse inbox, whatever its name", () => {
    const inbox = findInbox(root);
    assert.equal(inbox.name, "Posteingang");
    assert.equal(inbox.path, "/INBOX");
  });

  it("returns null when there is none", () => {
    assert.equal(findInbox({ subFolders: [{ name: "x", specialUse: [] }] }), null);
  });
});

describe("listFolders", () => {
  it("lists real folders with config paths and display labels", () => {
    const list = listFolders(root).map((f) => [f.path, f.label]);
    assert.deepEqual(list, [
      ["INBOX", "Posteingang"],
      ["INBOX/dev@braunben.de", "Posteingang/dev@braunben.de"],
      ["INBOX/apple@brauben.de", "Posteingang/apple@brauben.de"],
      ["INBOX/Job@braunben.de", "Posteingang/Job@braunben.de"],
      ["INBOX/archiv", "Posteingang/archiv"],
      ["INBOX/archiv/2025", "Posteingang/archiv/2025"],
      ["Sent", "Sent"],
      ["Trash", "Trash"],
    ]);
  });

  it("skips virtual, tag and unified folders", () => {
    const r = { subFolders: [{ name: "Suche", isVirtual: true, subFolders: [] }, { name: "Tag", isTag: true }, { name: "ok", specialUse: [] }] };
    assert.deepEqual(listFolders(r).map((f) => f.path), ["ok"]);
  });
});

describe("resolveFolder", () => {
  it("finds folders exactly, INBOX in any case", () => {
    assert.equal(resolveFolder(root, "INBOX/dev@braunben.de").folder.id, "account1://INBOX/dev@braunben.de");
    assert.equal(resolveFolder(root, "inbox/apple@brauben.de").folder.name, "apple@brauben.de");
    assert.equal(resolveFolder(root, "INBOX/archiv/2025").folder.name, "2025");
    assert.equal(resolveFolder(root, "Sent").folder.name, "Sent");
  });

  it("does not guess: the apple folder with n does not exist, the siblings are listed", () => {
    const r = resolveFolder(root, "INBOX/apple@braunben.de");
    assert.ok("problem" in r);
    assert.match(r.problem, /"apple@braunben.de" fehlt unter "Posteingang"/);
    assert.match(r.problem, /Vorhanden: dev@braunben.de, apple@brauben.de, Job@braunben.de, archiv/);
  });

  it("points at a case mismatch", () => {
    assert.match(resolveFolder(root, "INBOX/job@braunben.de").problem, /Meintest du "Job@braunben.de"/);
  });

  it("says when a level has no subfolders", () => {
    assert.match(resolveFolder(root, "INBOX/dev@braunben.de/x").problem, /keine Unterordner/);
    assert.match(resolveFolder(root, "Nope").problem, /auf oberster Ebene/);
  });
});

describe("resolveTargets", () => {
  it("resolves what exists and reports the rest", () => {
    const rules = [{ folder: "INBOX/dev@braunben.de" }, { folder: "INBOX/gaming@braunben.de" }];
    const { targets, problems } = resolveTargets(root, rules);
    assert.deepEqual([...targets.keys()], ["INBOX/dev@braunben.de"]);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].folder, "INBOX/gaming@braunben.de");
  });
});

describe("sameFolder", () => {
  it("compares ids, or account and path", () => {
    assert.equal(sameFolder({ id: "a" }, { id: "a" }), true);
    assert.equal(sameFolder({ id: "a" }, { id: "b" }), false);
    assert.equal(sameFolder({ accountId: "x", path: "/INBOX" }, { accountId: "x", path: "/INBOX" }), true);
    assert.equal(sameFolder(undefined, { id: "a" }), false);
  });
});
