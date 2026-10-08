// Header parsing: just enough of RFC 5322 to find recipient addresses reliably.

/**
 * Parses header lines (as returned by BODY[HEADER.FIELDS (...)]) into a map of
 * lower-cased field name -> values, in the order they appear (topmost first).
 */
export function parseHeaderFields(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let name: string | null = null;
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

/**
 * Extracts the addr-specs from an address list such as
 * `"Dev, Team" <dev@example.org>, other@example.org (comment), group: a@x.y, b@x.y;`.
 * Display names and comments are ignored, so `"dev@example.org" <x@y.z>` yields only x@y.z.
 * Returns lower-cased addresses.
 */
export function parseAddressList(value: string): string[] {
  const out: string[] = [];
  let bare = "";
  let angle: string | null = null;
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
    const c = value[i]!;
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
