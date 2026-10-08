// A small in-memory stand-in for the parts of Thunderbird's messenger API the add-on
// uses. It mimics the behaviour that matters: message ids are only valid for one
// session and change when a message is moved, lists are paginated, storage returns
// copies, folder ids look like "account1://INBOX/dev".

const SPECIAL = { INBOX: ["inbox"], Sent: ["sent"], Trash: ["trash"], Drafts: ["drafts"], Junk: ["junk"] };

/**
 * Builds a MailFolder tree. spec: {INBOX: ["dev", {name: "archiv", children: ["2025"]}], Sent: []}
 */
export function buildTree(accountId, spec) {
  const make = (name, path, specialUse, children) => {
    const folder = {
      id: `${accountId}:/${path}`,
      accountId,
      name,
      path,
      specialUse,
      isRoot: false,
      isFavorite: false,
      isTag: false,
      isUnified: false,
      isVirtual: false,
      subFolders: [],
    };
    folder.subFolders = children.map((c) => {
      const child = typeof c === "string" ? { name: c, children: [] } : c;
      return make(child.name, `${path}/${child.name}`, [], child.children ?? []);
    });
    return folder;
  };
  const root = make("Root", "", [], []);
  root.id = `${accountId}://`;
  root.path = "/";
  root.isRoot = true;
  root.subFolders = Object.entries(spec).map(([name, children]) =>
    make(name === "INBOX" ? "Posteingang" : name, `/${name}`, SPECIAL[name] ?? [], children),
  );
  return root;
}

function storageArea() {
  let data = {};
  const area = {
    /** Keys asked for by each get(), keys written by each set(). */
    reads: [],
    writes: [],
    async get(keys) {
      const list = keys == null ? Object.keys(data) : typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      area.reads.push([...list]);
      const out = {};
      for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) {
      area.writes.push(Object.keys(obj));
      for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v);
    },
    async clear() {
      data = {};
    },
    raw: () => data,
  };
  return area;
}

/** Header text ("Name: value" lines, folded lines kept) -> rawHeaders dictionary like getFull(). */
function rawHeaderDict(text) {
  const dict = {};
  let last = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if ((line[0] === " " || line[0] === "\t") && last) {
      last.list[last.list.length - 1] += "\r\n" + line;
      continue;
    }
    const colon = line.indexOf(":");
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    dict[name] ??= [];
    dict[name].push(value);
    last = { list: dict[name] };
  }
  return dict;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createMockMessenger() {
  const accounts = new Map();
  const folders = new Map();
  const messages = new Map();
  const lists = new Map();
  let nextId = 1;
  let listSeq = 0;
  let moveDelayMs = 0;
  const failMoves = new Map(); // subject -> remaining failures (Infinity = always)
  const calls = { getFull: [], get: [], move: [], list: 0, accountsGet: 0, abortList: [] };
  const alarms = new Map();
  const PAGE = 3;

  const folderInfo = (f) => {
    const { subFolders, ...rest } = f;
    return structuredClone(rest);
  };

  const header = (m) => ({
    id: m.id,
    date: new Date(m.date),
    headerMessageId: m.messageId,
    subject: m.subject,
    author: m.author,
    recipients: [],
    ccList: [],
    bccList: [],
    read: m.read,
    new: true,
    flagged: false,
    junk: false,
    junkScore: 0,
    headersOnly: false,
    external: false,
    size: 1000,
    tags: [],
    folder: folderInfo(folders.get(m.folderId)),
  });

  const page = (items) => {
    if (items.length <= PAGE) return { id: null, messages: items };
    const id = `list-${++listSeq}`;
    lists.set(id, items.slice(PAGE));
    return { id, messages: items.slice(0, PAGE) };
  };

  const register = (folder) => {
    folders.set(folder.id, folder);
    for (const c of folder.subFolders) register(c);
  };

  const api = {
    accounts: {
      async list() {
        return [...accounts.values()].map((a) => ({ ...structuredClone(a), rootFolder: folderInfo(a.rootFolder) }));
      },
      async get(id, includeSubFolders = false) {
        calls.accountsGet++;
        const a = accounts.get(id);
        if (!a) return null;
        return includeSubFolders ? structuredClone(a) : { ...structuredClone(a), rootFolder: folderInfo(a.rootFolder) };
      },
    },
    messages: {
      async list(folderId) {
        calls.list++;
        if (!folders.has(folderId)) throw new Error(`Folder not found: ${folderId}`);
        return page([...messages.values()].filter((m) => m.folderId === folderId).map(header));
      },
      async continueList(id) {
        const rest = lists.get(id);
        if (!rest) throw new Error(`Unknown list ${id}`);
        lists.delete(id);
        return page(rest);
      },
      async abortList(id) {
        calls.abortList.push(id);
        lists.delete(id);
      },
      async get(id) {
        calls.get.push(id);
        const m = messages.get(id);
        if (!m) throw new Error(`Message not found: ${id}.`);
        return header(m);
      },
      async getFull(id, options = {}) {
        calls.getFull.push(id);
        const m = messages.get(id);
        if (!m) throw new Error(`Message not found: ${id}.`);
        if (m.failFull) throw new Error("Server nicht erreichbar");
        const key = options.decodeHeaders === false ? "rawHeaders" : "headers";
        return { contentType: "message/rfc822", partName: "", size: 1000, [key]: structuredClone(m.rawHeaders), parts: [] };
      },
      async move(ids, folderId) {
        calls.move.push({ ids: [...ids], folderId });
        if (moveDelayMs) await sleep(moveDelayMs);
        if (!folders.has(folderId)) throw new Error(`Folder not found: ${folderId}`);
        for (const id of ids) {
          const m = messages.get(id);
          if (!m) throw new Error(`Message not found: ${id}.`);
          const left = failMoves.get(m.subject) ?? 0;
          if (left > 0) {
            failMoves.set(m.subject, left - 1);
            throw new Error("IMAP: NO [SERVERBUG] Move failed");
          }
        }
        for (const id of ids) {
          const m = messages.get(id);
          messages.delete(id);
          m.id = nextId++;
          m.folderId = folderId;
          messages.set(m.id, m);
        }
      },
    },
    storage: { local: storageArea(), session: storageArea() },
    alarms: {
      async create(name, info) {
        alarms.set(name, { name, ...info });
      },
      async clear(name) {
        return alarms.delete(name);
      },
      async get(name) {
        return alarms.get(name);
      },
    },
    action: {
      badge: "",
      async setBadgeText({ text }) {
        api.action.badge = text;
      },
      async setBadgeBackgroundColor() {},
    },
  };

  const folderId = (accountId, path) => `${accountId}://${path}`;

  return {
    api,
    calls,
    alarms,
    folderId,
    /** Creates a folder like the user would; returns it (as folders.onCreated would). */
    addFolder(accountId, parentPath, name) {
      const parent = folders.get(folderId(accountId, parentPath));
      const folder = {
        id: `${parent.id}/${name}`,
        accountId,
        name,
        path: `${parent.path}/${name}`,
        specialUse: [],
        isRoot: false,
        isFavorite: false,
        isTag: false,
        isUnified: false,
        isVirtual: false,
        subFolders: [],
      };
      parent.subFolders.push(folder);
      register(folder);
      return folderInfo(folder);
    },
    addAccount(id, spec, name = "IONOS") {
      const rootFolder = buildTree(id, spec);
      accounts.set(id, { id, name, type: "imap", rootFolder, identities: [] });
      register(rootFolder);
      return rootFolder;
    },
    folder(accountId, path) {
      const f = folders.get(folderId(accountId, path));
      if (!f) throw new Error(`no folder ${path}`);
      return folderInfo(f);
    },
    /** Adds a message without any event, like one that arrived while Thunderbird was off. */
    addMessage({ accountId = "account1", path = "INBOX", subject, headers, date, messageId, read = false }) {
      const m = {
        id: nextId++,
        folderId: folderId(accountId, path),
        subject,
        author: "Absender <absender@example.org>",
        messageId: messageId ?? `${subject.replace(/\W+/g, "-")}@example.org`,
        date: date ?? Date.UTC(2026, 9, 6, 10, 0, 0),
        rawHeaders: rawHeaderDict(headers),
        read,
      };
      if (!folders.has(m.folderId)) throw new Error(`no folder ${path}`);
      messages.set(m.id, m);
      return header(m);
    },
    /** Moves a message like the user would; returns the onMoved arguments. */
    moveByUser(id, accountId, path) {
      const m = messages.get(id);
      const original = header(m);
      messages.delete(id);
      m.id = nextId++;
      m.folderId = folderId(accountId, path);
      messages.set(m.id, m);
      return [{ id: null, messages: [original] }, { id: null, messages: [header(m)] }];
    },
    deleteMessage(id) {
      const m = messages.get(id);
      messages.delete(id);
      return { id: null, messages: [header(m)] };
    },
    setFailFull(subject, value = true) {
      for (const m of messages.values()) if (m.subject === subject) m.failFull = value;
    },
    failMove(subject, times = Infinity) {
      failMoves.set(subject, times);
    },
    setMoveDelay(ms) {
      moveDelayMs = ms;
    },
    /** All messages in a folder: [{id, subject, read}]. */
    messagesIn(accountId, path) {
      const fid = folderId(accountId, path);
      return [...messages.values()].filter((m) => m.folderId === fid).map((m) => ({ id: m.id, subject: m.subject, read: m.read }));
    },
    findId(subject) {
      return [...messages.values()].find((m) => m.subject === subject)?.id;
    },
    /**
     * Thunderbird restart: new session, ids start at 1 again. Messages are numbered in
     * reverse order, so an old id now belongs to a different message.
     */
    async restart() {
      await api.storage.session.clear();
      lists.clear();
      alarms.clear(); // Thunderbird does not keep alarms across a restart
      const all = [...messages.values()].reverse();
      messages.clear();
      nextId = 1;
      for (const m of all) {
        m.id = nextId++;
        messages.set(m.id, m);
      }
    },
  };
}
