// The files that go into the .xpi. Everything else (tests, scripts, reference) stays out.

import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

const INCLUDE = ["manifest.json", "background.js", "src", "options", "icons"];

function walk(path) {
  if (statSync(path).isDirectory()) return readdirSync(path).sort().flatMap((name) => walk(join(path, name)));
  return [path];
}

/** Paths relative to the repo root, with "/" separators, manifest.json first. */
export function addonFiles() {
  return INCLUDE.flatMap((p) => walk(join(ROOT, p))).map((abs) => relative(ROOT, abs).split(sep).join("/"));
}
