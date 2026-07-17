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

t("runSyncCycle wraps the readPeers call in try/catch and returns ok:false, classifying the error via classifySyncError", () => {
  const readPeersIdx = body.indexOf("readPeers(");
  assert.ok(readPeersIdx >= 0, "readPeers must still be called");
  const tryIdx = body.lastIndexOf("try {", readPeersIdx);
  assert.ok(tryIdx >= 0, "must have a try block around readPeers");
  const catchSlice = body.slice(body.indexOf("catch (e) {", tryIdx));
  assert.ok(/classifySyncError\(e\)/.test(catchSlice), "must classify the caught error via classifySyncError(e)");
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
  // Window widened 200 -> 500: an explanatory comment (Finding 2b — forced
  // publish when the self folder vanished) now sits between the try and the call.
  const around = body.slice(Math.max(0, publishIdx - 500), publishIdx + 400);
  assert.ok(/try\s*\{/.test(around), "publishSnapshot call must be inside a try block");
});

t("runSyncCycle wraps its ENTIRE body in one outer try/catch, not just readPeers/publishSnapshot (regression: a prior version only wrapped 2 of 5 throwable segments — ensureDeviceIdentity/buildLocal/mergeSnapshots/applyMergeToLocal could still reject the whole promise)", () => {
  const tryOpenIdx = body.indexOf("try {", body.indexOf('opts = opts || {};'));
  assert.ok(tryOpenIdx >= 0, "must have an outer try immediately after opts = opts || {}");
  const catchCount = (body.match(/catch \(e\) \{/g) || []).length;
  assert.ok(catchCount >= 3, "must have at least 3 catch blocks: the outer safety-net plus the readPeers and publishSnapshot inner ones");
  const lastCatchIdx = body.lastIndexOf("catch (e) {");
  assert.ok(lastCatchIdx > tryOpenIdx, "the outermost catch (the safety net) must be the LAST catch block in the function, at the outer nesting level");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
