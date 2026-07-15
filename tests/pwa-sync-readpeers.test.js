// tests/pwa-sync-readpeers.test.js — readPeers() used to swallow ANY failure
// from Dbx.dbxListFolder into an identical-looking empty peer list (the root
// cause of a 2-day-long silent sync failure diagnosed 2026-07-15 — see
// docs/superpowers/specs/2026-07-15-sync-reliability-design.md). This locks
// in the permanent replacement: propagate AUTH_EXPIRED and genuinely
// unexpected errors, keep only the benign "nobody has ever synced" case
// (Dropbox's path/not_found) as a soft empty return, and report per-peer
// failures via partialFailures instead of silently dropping them.
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

const body = grab(src, "readPeers");

t("readPeers no longer has the temporary diagnostic errors/deviceIdsFound fields", () => {
  assert.ok(body.indexOf("TEMPORARY DIAGNOSTIC") === -1, "temporary diagnostic comment must be removed");
  assert.ok(!/deviceIdsFound/.test(body), "deviceIdsFound must be removed (was diagnostic-only)");
});

t("readPeers propagates an AUTH_EXPIRED error from dbxListFolder instead of swallowing it", () => {
  assert.ok(/if\s*\(e\s*&&\s*e\.code\s*===\s*"AUTH_EXPIRED"\)\s*throw e;/.test(body),
    "must re-throw an AUTH_EXPIRED error from the list_folder catch block");
});

t("readPeers still soft-returns empty peers for the benign path/not_found case", () => {
  assert.ok(/path\\\/not_found/.test(body), "must check for Dropbox's path/not_found error");
  assert.ok(/return \{ ?peers: \[\], ?skewSkipped: 0, ?partialFailures: \[\] ?\}/.test(body.replace(/\s+/g, " ")),
    "must return an empty-but-valid result for path/not_found");
});

t("readPeers propagates any OTHER unexpected list_folder error (no longer silently swallowed)", () => {
  // after the AUTH_EXPIRED check and the path/not_found check, anything else must fall through to a throw
  const catchBlock = body.slice(body.indexOf("catch (e) {", body.indexOf("dbxListFolder")));
  assert.ok(/throw e;/.test(catchBlock.slice(0, catchBlock.indexOf("}"))), "unexpected errors must propagate, not be swallowed");
});

t("a per-peer AUTH_EXPIRED also aborts the whole cycle (not just that one peer)", () => {
  const loopStart = body.indexOf("for (const deviceId of deviceIds)");
  const loopBody = body.slice(loopStart);
  assert.ok(/if\s*\(e\s*&&\s*e\.code\s*===\s*"AUTH_EXPIRED"\)\s*throw e;/.test(loopBody),
    "the per-peer catch must re-throw an AUTH_EXPIRED error rather than `continue`");
});

t("a per-peer non-auth failure is recorded in partialFailures and the loop continues", () => {
  assert.ok(/partialFailures\.push\(\{\s*deviceId,\s*reason:/.test(body), "must push {deviceId, reason} on a per-peer failure");
  assert.ok(/return \{ ?peers, ?skewSkipped, ?partialFailures ?\}/.test(body.replace(/\s+/g, " ")),
    "the final return must include partialFailures");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
