// Static checks before building: manifest sane, referenced files present, syntax OK,
// relative imports resolvable, no network, no experiments, and only the WebExtension
// API calls that were checked against webextension-api.thunderbird.net.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { ROOT, addonFiles } from "./files.mjs";

const problems = [];
const fail = (msg) => problems.push(msg);

// Every messenger.* call the add-on makes. Checked against the Thunderbird MV3 docs
// (release 157 and ESR 153). A new call has to be checked there and added here.
const KNOWN_API = new Set([
  "accounts.get",
  "accounts.list",
  "action.onClicked",
  "action.setBadgeBackgroundColor",
  "action.setBadgeText",
  "alarms.clear",
  "alarms.create",
  "alarms.get",
  "alarms.onAlarm",
  "folders.onCreated",
  "folders.onDeleted",
  "folders.onMoved",
  "folders.onRenamed",
  "messages.abortList",
  "messages.continueList",
  "messages.get",
  "messages.getFull",
  "messages.list",
  "messages.move",
  "messages.onDeleted",
  "messages.onMoved",
  "messages.onNewMailReceived",
  "runtime.id",
  "runtime.onInstalled",
  "runtime.onMessage",
  "runtime.onStartup",
  "runtime.openOptionsPage",
  "runtime.sendMessage",
  "storage.local",
  "storage.onChanged",
  "storage.session",
]);
const ALLOWED_PERMISSIONS = new Set(["accountsRead", "messagesRead", "messagesMove", "storage", "alarms"]);

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const files = new Set(addonFiles());

if (manifest.manifest_version !== 3) fail("manifest_version must be 3");
const gecko = manifest.browser_specific_settings?.gecko;
if (!gecko?.id) fail("browser_specific_settings.gecko.id is missing");
if (!gecko?.strict_min_version) fail("strict_min_version is missing");
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) fail(`version "${manifest.version}" should look like 1.2.3`);
if (manifest.experiment_apis) fail("experiment_apis are not allowed");
for (const p of manifest.permissions ?? []) if (!ALLOWED_PERMISSIONS.has(p)) fail(`Unexpected permission: ${p}`);
if (manifest.host_permissions?.length) fail("host_permissions are not needed");
const referenced = [
  ...(manifest.background?.scripts ?? []),
  manifest.options_ui?.page,
  manifest.action?.default_icon,
  ...Object.values(manifest.icons ?? {}),
].filter(Boolean);
for (const f of referenced) if (!files.has(f)) fail(`manifest.json points to ${f}, which is not in the package`);

const used = new Set();
for (const file of files) {
  if (!file.endsWith(".js")) continue;
  const abs = join(ROOT, file);
  try {
    execFileSync(process.execPath, ["--check", abs], { stdio: "pipe" });
  } catch (e) {
    fail(`Syntax error in ${file}: ${e.stderr?.toString().trim()}`);
  }
  const text = readFileSync(abs, "utf8");
  for (const m of text.matchAll(/\bfrom\s+"(\.{1,2}\/[^"]+)"/g)) {
    const target = posix.normalize(posix.join(posix.dirname(file), m[1]));
    if (!files.has(target)) fail(`${file}: import ${m[1]} points to ${target}, which is not in the package`);
  }
  for (const m of text.matchAll(/\b(?:messenger|api)\.([a-zA-Z]+)\.([a-zA-Z]+)/g)) used.add(`${m[1]}.${m[2]}`);
  if (/(?<![\w.])(fetch|XMLHttpRequest|WebSocket|EventSource)\(/.test(text) || /\bnew\s+(XMLHttpRequest|WebSocket|EventSource)\b/.test(text)) {
    fail(`${file}: network access found`);
  }
  if (/\beval\s*\(|new\s+Function\s*\(/.test(text)) fail(`${file}: eval/new Function found`);
}
for (const html of [...files].filter((f) => f.endsWith(".html"))) {
  const text = readFileSync(join(ROOT, html), "utf8");
  for (const m of text.matchAll(/\b(?:src|href)="([^"]+)"/g)) {
    if (/^[a-z]+:/i.test(m[1])) fail(`${html}: external resource ${m[1]}`);
    else if (!files.has(posix.normalize(posix.join(posix.dirname(html), m[1])))) fail(`${html}: ${m[1]} is missing`);
  }
  if (/<script(?![^>]*\bsrc=)[^>]*>/.test(text)) fail(`${html}: inline script (not allowed by the CSP)`);
}
const unknown = [...used].filter((u) => !KNOWN_API.has(u)).sort();
for (const u of unknown) fail(`API call ${u} is not in the checked list (check it against the docs and add it to scripts/check.mjs)`);

if (problems.length) {
  console.error("Check failed:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`Check ok: ${files.size} files, ${used.size} API calls, permissions ${manifest.permissions.join(", ")}`);
