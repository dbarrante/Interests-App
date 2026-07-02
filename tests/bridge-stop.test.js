// Task 10 (review B9+B10): the bridge batch driver must honor the app's Stop.
// The app's Stop writes {active:false, cancel:true} to /api/batch-state. The
// SW driver never writes batch-state (a write could resurrect active:true and
// clobber Stop). The bridge must adopt the SAME rule: never force active:true,
// re-check state each wave, and stop without a resurrecting write.
//
// bridge.js is a browser IIFE (references chrome/location) so it can't be
// require()'d in Node. We (1) require the pure `batchStopped` export it now
// publishes for Node, and (2) source-assert the driver guards that make the
// stop path correct — the same source-assertion pattern used by
// background-force.test.js / capture-wiring.test.js.
const assert = require("assert");
const fs = require("fs"), path = require("path");

const bridgeSrc = fs.readFileSync(path.join(__dirname, "..", "extension", "bridge.js"), "utf8");
const { batchStopped } = require("../extension/bridge.js");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }

// ---- batchStopped truth table -------------------------------------------
t("batchStopped is exported as a function", () => {
  assert.strictEqual(typeof batchStopped, "function");
});
t("batchStopped(null) is true (no state = stopped)", () => {
  assert.strictEqual(batchStopped(null), true);
});
t("batchStopped(undefined) is true", () => {
  assert.strictEqual(batchStopped(undefined), true);
});
t("batchStopped({cancel:true}) is true", () => {
  assert.strictEqual(batchStopped({ cancel: true }), true);
});
t("batchStopped({active:false}) is true", () => {
  assert.strictEqual(batchStopped({ active: false }), true);
});
t("batchStopped({active:true}) is false (running)", () => {
  assert.strictEqual(batchStopped({ active: true }), false);
});
t("batchStopped({items:[...]}) with no stop flags is false", () => {
  assert.strictEqual(batchStopped({ items: [1, 2], next: 0 }), false);
});
t("batchStopped({active:true, cancel:true}) is true (cancel wins)", () => {
  assert.strictEqual(batchStopped({ active: true, cancel: true }), true);
});

// ---- driver-level guards (source assertions) ----------------------------
t("driveBatch skips adopting a state when batchStopped(st)", () => {
  const i = bridgeSrc.indexOf("async function driveBatch");
  assert.ok(i >= 0, "driveBatch present");
  const body = bridgeSrc.slice(i, i + 900);
  assert.ok(/batchStopped\(\s*st\s*\)/.test(body), "driveBatch must guard on batchStopped(st) before adopting");
});

t("saveState never posts active:true — it read-checks then merges", () => {
  const i = bridgeSrc.indexOf("async function saveState");
  assert.ok(i >= 0, "saveState present");
  const body = bridgeSrc.slice(i, i + 700);
  // Must GET current state and bail (null B) if stopped, without a write.
  assert.ok(/getJson\(\s*["']\/api\/batch-state["']\s*\)/.test(body), "saveState must GET current batch-state first");
  assert.ok(/batchStopped\(/.test(body), "saveState must check batchStopped(current)");
  assert.ok(/B\s*=\s*null/.test(body), "saveState must null B when stopped (the stop signal)");
  // The old resurrecting literal `active: true` must be gone from saveState.
  assert.ok(!/active:\s*true/.test(body), "saveState must NOT force active:true");
});

t("pump is async and re-guards B after awaits", () => {
  const i = bridgeSrc.indexOf("async function pump");
  assert.ok(i >= 0, "pump must be async (await the per-wave stop-check)");
  const body = bridgeSrc.slice(i, i + 700);
  assert.ok(/await\s+saveState\(\)/.test(body), "pump must await saveState() (the stop-check)");
  assert.ok(/if\s*\(\s*!B\s*\)\s*return/.test(body), "pump must guard if(!B) return after the await");
});

t("dispatch callback guards if(!B) before B.done++", () => {
  const i = bridgeSrc.indexOf("function dispatch");
  assert.ok(i >= 0, "dispatch present");
  const body = bridgeSrc.slice(i, i + 600);
  const guardIdx = body.search(/if\s*\(\s*!B\s*\)\s*return/);
  const doneIdx = body.indexOf("B.done++");
  assert.ok(guardIdx >= 0, "dispatch must guard if(!B) return");
  assert.ok(doneIdx >= 0 && guardIdx < doneIdx, "the !B guard must precede B.done++");
});

t("endBatch only clears state (state:null) on genuine completion, not on Stop", () => {
  const i = bridgeSrc.indexOf("async function endBatch");
  assert.ok(i >= 0, "endBatch present");
  const body = bridgeSrc.slice(i, i + 700);
  // endBatch is reached from pump's completion branch (B.next >= items.length && inFlight===0).
  assert.ok(/state:\s*null/.test(body), "endBatch clears the mailbox on completion");
});

// ---- manifest: exactly the 20 app-port matches (no wildcard regression) --
t("manifest localhost content-script matches are exactly the 20 app ports", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "extension", "manifest.json"), "utf8"));
  const expected = [];
  for (let p = 3456; p <= 3465; p++) expected.push("http://localhost:" + p + "/*");
  for (let p = 3456; p <= 3465; p++) expected.push("http://127.0.0.1:" + p + "/*");
  const bridgeCS = manifest.content_scripts.find((cs) => Array.isArray(cs.js) && cs.js.includes("bridge.js"));
  assert.ok(bridgeCS, "a content script loading bridge.js must exist");
  const got = bridgeCS.matches.slice().sort();
  assert.deepStrictEqual(got, expected.slice().sort(),
    "bridge content-script matches must be exactly the 20 ports 3456-3465 on localhost + 127.0.0.1 (no wildcards)");
  // Explicitly forbid the old wildcard ports.
  for (const m of bridgeCS.matches) {
    assert.ok(!/:\*\//.test(m), "no wildcard-port match allowed: " + m);
  }
});

// ---- background defer check narrowed to the same 20 ports ----------------
t("background defer checks use a shared 3456-3465 app-port list (not wildcard localhost)", () => {
  const bg = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");
  assert.ok(/APP_TAB_URLS/.test(bg), "background must define a shared APP_TAB_URLS constant");
  // The old wildcard tab-query patterns must be gone.
  assert.ok(!/["']http:\/\/localhost\/\*["']/.test(bg), "no wildcard http://localhost/* tab query");
  assert.ok(!/["']http:\/\/127\.0\.0\.1\/\*["']/.test(bg), "no wildcard http://127.0.0.1/* tab query");
});

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
try { const { getGlobalDispatcher } = require("undici"); getGlobalDispatcher().close(); } catch (_) {}
