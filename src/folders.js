// Folder lookup in the account's real folder tree (accounts.get(id, true)). Configured
// paths use folder names separated by "/", the first level "INBOX" stands for the
// account's inbox whatever Thunderbird calls it ("Posteingang", "Inbox").

function children(folder) {
  return Array.isArray(folder?.subFolders) ? folder.subFolders : [];
}

function isInbox(folder) {
  return Array.isArray(folder?.specialUse) && folder.specialUse.includes("inbox");
}

/** The inbox of an account: a direct child of the root with specialUse "inbox". */
export function findInbox(root) {
  const direct = children(root).find(isInbox);
  if (direct) return direct;
  const stack = [...children(root)];
  while (stack.length) {
    const f = stack.shift();
    if (isInbox(f)) return f;
    stack.push(...children(f));
  }
  return null;
}

/** Whether `folder` is the inbox `inbox`, compared by id and, as a fallback, by account and path. */
export function sameFolder(folder, inbox) {
  if (!folder || !inbox) return false;
  if (folder.id !== undefined && inbox.id !== undefined) return folder.id === inbox.id;
  return folder.accountId === inbox.accountId && folder.path === inbox.path;
}

function topLevelName(folder) {
  return isInbox(folder) ? "INBOX" : folder.name;
}

/**
 * All real folders of the account below the root, depth first, as
 * {path: "INBOX/dev@braunben.de", label: "Posteingang/dev@braunben.de", folder}.
 */
export function listFolders(root) {
  const out = [];
  const walk = (folder, path, label) => {
    for (const child of children(folder)) {
      if (child.isVirtual || child.isTag || child.isUnified) continue;
      const name = path ? child.name : topLevelName(child);
      const childPath = path ? `${path}/${name}` : name;
      const childLabel = label ? `${label}/${child.name}` : child.name;
      out.push({ path: childPath, label: childLabel, folder: child });
      walk(child, childPath, childLabel);
    }
  };
  walk(root, "", "");
  return out;
}

/**
 * Looks up a configured path exactly. On failure the problem names the folders that
 * exist on the same level, so a typo is easy to spot.
 * @returns {{folder: object} | {problem: string}}
 */
export function resolveFolder(root, path) {
  const segments = String(path).split("/");
  let current = root;
  const labels = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const kids = children(current).filter((f) => !f.isVirtual && !f.isTag && !f.isUnified);
    let next;
    if (i === 0 && /^inbox$/i.test(seg)) next = kids.find(isInbox);
    else next = kids.find((f) => (i === 0 ? topLevelName(f) : f.name) === seg);
    if (!next) {
      const names = kids.map((f) => (i === 0 ? topLevelName(f) : f.name));
      const similar = names.find((n) => n.toLowerCase() === seg.toLowerCase());
      const where = labels.length ? ` unter "${labels.join("/")}"` : " auf oberster Ebene";
      let problem = `Ordner "${path}" nicht gefunden: "${seg}" fehlt${where}.`;
      if (similar) problem += ` Meintest du "${similar}"? (Groß-/Kleinschreibung zählt)`;
      problem += names.length ? ` Vorhanden: ${names.slice(0, 40).join(", ")}` : " Dort gibt es keine Unterordner.";
      return { problem };
    }
    labels.push(next.name);
    current = next;
  }
  if (current === root) return { problem: `Ordner "${path}" ist ungültig` };
  return { folder: current };
}

/**
 * Resolves the folders of all rules. Missing ones end up in `problems`, the others keep
 * working.
 * @returns {{targets: Map<string, object>, problems: {folder: string, problem: string}[]}}
 */
export function resolveTargets(root, rules) {
  const targets = new Map();
  const problems = [];
  for (const rule of rules) {
    const r = resolveFolder(root, rule.folder);
    if ("folder" in r) targets.set(rule.folder, r.folder);
    else problems.push({ folder: rule.folder, problem: r.problem });
  }
  return { targets, problems };
}
