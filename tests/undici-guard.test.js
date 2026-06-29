const assert = require("assert");
const g = require("../core/undici-guard");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

// A realistic undici teardown assertion (the crash Dave hit).
function fakeUndiciAssert(){
  const e = new Error("The expression evaluated to a falsy value:\n\n  assert(!this.paused)\n");
  e.name = "AssertionError";
  e.code = "ERR_ASSERTION";
  e.stack = "AssertionError [ERR_ASSERTION]: ...\n    at Parser.finish (node:internal/deps/undici/undici:7380:9)\n    at TLSSocket.onHttpSocketEnd (node:internal/deps/undici/undici:7819:34)";
  return e;
}

t("recognizes the undici teardown assert by message", () => {
  assert.strictEqual(g.isBenignUndiciTeardown(fakeUndiciAssert()), true);
});
t("recognizes it by stack (undici Parser.finish) even if message differs", () => {
  const e = new Error("falsy value"); e.code = "ERR_ASSERTION";
  e.stack = "at Parser.finish (node:internal/deps/undici/undici:7380:9)\n at TLSSocket.onHttpSocketEnd";
  assert.strictEqual(g.isBenignUndiciTeardown(e), true);
});
t("does NOT swallow a generic Error", () => {
  assert.strictEqual(g.isBenignUndiciTeardown(new Error("boom")), false);
});
t("does NOT swallow a real app AssertionError unrelated to undici", () => {
  const e = new Error("expected 3 to equal 4"); e.name = "AssertionError"; e.code = "ERR_ASSERTION";
  e.stack = "at Object.<anonymous> (D:/app/core/db.js:42:7)";
  assert.strictEqual(g.isBenignUndiciTeardown(e), false);
});
t("null/undefined -> false", () => {
  assert.strictEqual(g.isBenignUndiciTeardown(null), false);
  assert.strictEqual(g.isBenignUndiciTeardown(undefined), false);
});
t("installCrashGuard: benign -> logged & swallowed; genuine -> onFatal", () => {
  // Exercise the decision via the exported handler (no real process events).
  const logged = [], fatal = [];
  const handle = g._makeHandler({ log: (m)=>logged.push(m), onFatal: (e)=>fatal.push(e) });
  handle(fakeUndiciAssert());
  assert.strictEqual(logged.length, 1, "benign should be logged");
  assert.strictEqual(fatal.length, 0, "benign must NOT go fatal");
  const real = new Error("real bug");
  handle(real);
  assert.strictEqual(fatal.length, 1, "genuine should go to onFatal");
  assert.strictEqual(fatal[0], real);
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
