// tests/pwa-sync-settings-wiring.test.js — the PWA side of key sync must match
// core/db.js: publish keys+oprKey (strip only updateToken), apply via the shared
// mergeSyncedSettings union instead of force-preserving local credentials.
const assert = require("assert");
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "pwa", "sync-pwa.js"), "utf8");

function grab(source, name) {
  const idx = source.indexOf("function " + name + "(");
  if (idx < 0) throw new Error("not found: " + name);
  const open = source.indexOf("{", idx);
  let depth = 0, i = open;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return source.slice(idx, i);
}

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error("FAIL: " + name + "\n  " + (e && e.message)); }
}

t("stripSecrets strips ONLY updateToken now — keys and oprKey sync", () => {
  const body = grab(src, "stripSecrets");
  assert.ok(/delete clean\.updateToken/.test(body), "must still strip updateToken");
  assert.ok(!/delete clean\.keys/.test(body), "keys must sync (2026-07-16 decision)");
  assert.ok(!/delete clean\.oprKey/.test(body), "oprKey must sync (2026-07-16 decision)");
});

t("applyMergeToLocal merges settings via mergeSyncedSettings, not blanket local-key preservation", () => {
  const body = grab(src, "applyMergeToLocal");
  assert.ok(/mergeSyncedSettings\(\s*local\s*,\s*plan\.settings\.data\s*\)/.test(body),
    "must call mergeSyncedSettings(local, plan.settings.data)");
  assert.ok(!/keys:\s*local\.keys/.test(body), "old force-preserve of local.keys must be gone");
});

t("applyMergeToLocal stamps via settingsEnrichedByLocal (fresh when local enriched the union, incoming otherwise)", () => {
  const body = grab(src, "applyMergeToLocal");
  assert.ok(/settingsEnrichedByLocal\(\s*merged\s*,\s*plan\.settings\.data\s*\)\s*\?\s*Date\.now\(\)/.test(body),
    "must re-stamp fresh when the union is richer than the incoming blob — else local-only keys never propagate outward");
});

t("applyMergeToLocal rejects an oversized settings blob BEFORE writing (mirrors core/db.js's 256KiB guard, fail closed)", () => {
  const body = grab(src, "applyMergeToLocal");
  assert.ok(/262144/.test(body), "must carry the 262144-byte limit");
  const guardIdx = body.indexOf("262144");
  const writeIdx = body.indexOf('kvSet("ia_settings"');
  assert.ok(writeIdx >= 0 && guardIdx >= 0 && guardIdx < writeIdx, "the size guard must run before the ia_settings write");
  assert.ok(/let oversized = true/.test(body), "unstringifiable must count as oversized (fail closed)");
});

t("index.html loads merge.js before sync-pwa.js (bare-global dependency order)", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");
  const mergeIdx = html.indexOf("merge.js");
  const syncIdx = html.indexOf("sync-pwa.js");
  assert.ok(mergeIdx >= 0 && syncIdx >= 0 && mergeIdx < syncIdx, "merge.js must load before sync-pwa.js");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
