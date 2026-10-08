// Header parsing: just enough of RFC 5322 to find recipient addresses reliably.
// Ported from the mail-mover worker (reference/headers.ts).

/**
 * Parses a raw header block into a map of lower-cased field name -> values, in the
 * order they appear (topmost first). Stops at the first empty line.
 * @param {string} text
 * @returns {Map<string, string[]>}
 */
export function parseHeaderFields(text) {
  const out = new Map();
  let name = null;
  let value = "";
  const flush = () => {
    if (name === null) return;
    const list = out.get(name);
    if (list) list.push(value.trim());
    else out.set(name, [value.trim()]);
    name = null;
  };
  for (const line of text.split(/\r?\n/)) {
    if (line === "") {
      flush();
      break; // end of the header block
    }
    if (line[0] === " " || line[0] === "\t") {
      if (name !== null) value += " " + line.trim(); // unfold
      continue;
    }
    flush();
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    name = line.slice(0, colon).trim().toLowerCase();
    value = line.slice(colon + 1);
  }
  flush();
  return out;
}

/** Joins folded header lines ("a,\r\n\t b" -> "a, b"). */
export function unfold(value) {
  return String(value)
    .replace(/\r?\n[ \t]+/g, " ")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

/**
 * Turns the header dictionary of messages.getFull() into the same shape as
 * parseHeaderFields(): lower-cased names, unfolded values, topmost first.
 * Prefers rawHeaders (not RFC 2047 decoded, TB 133+) and falls back to headers.
 * @param {{rawHeaders?: Record<string, string[]>, headers?: Record<string, string[]>}} part
 * @returns {Map<string, string[]>}
 */
export function headersFromPart(part) {
  const dict = (part && (part.rawHeaders || part.headers)) || {};
  const out = new Map();
  for (const [name, values] of Object.entries(dict)) {
    const list = (Array.isArray(values) ? values : [values]).filter((v) => typeof v === "string").map(unfold);
    if (list.length === 0) continue;
    const key = name.toLowerCase();
    const prev = out.get(key);
    if (prev) prev.push(...list);
    else out.set(key, list);
  }
  return out;
}

/**
 * Extracts the addr-specs from an address list such as
 * `"Dev, Team" <dev@example.org>, other@example.org (comment), group: a@x.y, b@x.y;`.
 * Display names and comments are ignored, so `"dev@example.org" <x@y.z>` yields only x@y.z.
 * Returns lower-cased addresses.
 * @param {string} value
 * @returns {string[]}
 */
export function parseAddressList(value) {
  const out = [];
  let bare = "";
  let angle = null;
  const flush = () => {
    let candidate = angle ?? bare;
    if (angle !== null) {
      const route = candidate.lastIndexOf(":"); // obsolete source route "<@a,@b:user@host>"
      if (route >= 0) candidate = candidate.slice(route + 1);
    } else {
      // Without <...> only the token that looks like an address counts.
      const tokens = candidate.trim().split(/\s+/).filter((t) => t.includes("@"));
      candidate = tokens[tokens.length - 1] ?? "";
    }
    candidate = candidate.trim().toLowerCase();
    if (candidate.includes("@")) out.push(candidate);
    bare = "";
    angle = null;
  };
  let i = 0;
  while (i < value.length) {
    const c = value[i];
    if (c === '"') {
      let j = i + 1;
      let q = "";
      while (j < value.length && value[j] !== '"') {
        if (value[j] === "\\") j++;
        q += value[j] ?? "";
        j++;
      }
      bare += '"' + q + '"';
      i = j + 1;
    } else if (c === "(") {
      let depth = 1;
      let j = i + 1;
      while (j < value.length && depth > 0) {
        if (value[j] === "\\") j++;
        else if (value[j] === "(") depth++;
        else if (value[j] === ")") depth--;
        j++;
      }
      bare += " ";
      i = j;
    } else if (c === "<") {
      const close = value.indexOf(">", i + 1);
      angle = value.slice(i + 1, close < 0 ? value.length : close);
      i = close < 0 ? value.length : close + 1;
    } else if (c === "," || c === ";") {
      flush();
      i++;
    } else if (c === ":") {
      bare = ""; // "group-name:" starts a group, the name is no address
      i++;
    } else {
      bare += c;
      i++;
    }
  }
  flush();
  return out;
}

/** Removes RFC 5322 comments "(...)", nested ones included. Quoted strings are kept. */
export function stripComments(value) {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === "\\" && (quoted || depth > 0)) {
      if (depth === 0) out += c + (value[i + 1] ?? "");
      i++;
    } else if (depth === 0 && c === '"') {
      quoted = !quoted;
      out += c;
    } else if (!quoted && c === "(") {
      depth++;
      if (depth === 1) out += " ";
    } else if (!quoted && c === ")" && depth > 0) {
      depth--;
    } else if (depth === 0) {
      out += c;
    }
  }
  return out;
}
