// tests/pwa-sync-runcycle.test.js — runSyncCycle() used to let a peer-read or
// publish failure propagate as an unhandled rejection with no classification,
// and separately carried this session's temporary deviceIdsFound/peerErrors
// diagnostic fields. This locks in the permanent contract: always resolve,
// classify failures via {ok:false, code, reason}.
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

const body = grab(src, "runSyncCycle");

t("runSyncCycle no longer returns the temporary deviceIdsFound/peerErrors fields", () => {
  assert.ok(body.indexOf("TEMPORARY DIAGNOSTIC") === -1, "temporary diagnostic comment must be removed");
  assert.ok(!/deviceIdsFound/.test(body), "deviceIdsFound must be removed (was diagnostic-only)");
  assert.ok(!/peerErrors/.test(body), "peerErrors must be removed (replaced by partialFailures)");
});

t("runSyncCycle wraps the readPeers call in try/catch and returns ok:false with the error's code", () => {
  const tryIdx = body.indexOf("try {");
  assert.ok(tryIdx >= 0, "must have a try block around readPeers");
  const catchSlice = body.slice(body.indexOf("catch (e) {", tryIdx));
  assert.ok(/code:\s*\(e\s*&&\s*e\.code\)\s*\|\|\s*"OTHER"/.test(catchSlice), "must classify the caught error's code, defaulting to OTHER");
  assert.ok(/ok:\s*false/.test(catchSlice), "must return ok:false on a caught readPeers failure");
});

t("runSyncCycle's success return includes ok:true and partialFailures", () => {
  const returnIdx = body.lastIndexOf("return {");
  const returnBlock = body.slice(returnIdx);
  assert.ok(/ok:\s*true/.test(returnBlock), "success path must set ok:true");
  assert.ok(/partialFailures/.test(returnBlock), "success path must include partialFailures");
});

t("runSyncCycle wraps publishSnapshot in try/catch too (a publish-time 401 must also classify, not throw raw)", () => {
  const publishIdx = body.indexOf("publishSnapshot(");
  assert.ok(publishIdx >= 0, "publishSnapshot must still be called");
  const around = body.slice(Math.max(0, publishIdx - 200), publishIdx + 400);
  assert.ok(/try\s*\{/.test(around), "publishSnapshot call must be inside a try block");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
