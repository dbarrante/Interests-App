// tests/store-op-indicator.test.js — Task 5: the small "operation in
// progress" spinner shown while a backup/restore/store-move is in flight,
// reusing the existing sync indicator's spin/sync-chip CSS pattern. Backup/
// restore/move are async now (Tasks 2-4), so their triggering buttons need an
// explicit in-flight state instead of relying on the old freeze to prevent
// double-submission.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }
function fn(src, name) { const m = extractFn(src, name); assert.ok(m, name + " not found in source"); return m; }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": storeOpIndicatorHTML renders nothing when no operation is in flight", () => {
    const factory = new Function("_storeOpInFlight", fn(src, "storeOpIndicatorHTML") + "\nreturn storeOpIndicatorHTML;");
    const storeOpIndicatorHTML = factory(null);
    assert.strictEqual(storeOpIndicatorHTML(), "");
  });

  t(label + ": storeOpIndicatorHTML shows a spinning indicator naming the in-flight operation", () => {
    const factory = new Function("_storeOpInFlight", fn(src, "storeOpIndicatorHTML") + "\nreturn storeOpIndicatorHTML;");
    const storeOpIndicatorHTML = factory("backup");
    const out = storeOpIndicatorHTML();
    assert.match(out, /spin/);
    assert.match(out, /[Bb]ack(ing)? ?up/);
  });

  t(label + ": storeOpIndicatorHTML names restore and move too", () => {
    const factory = new Function("_storeOpInFlight", fn(src, "storeOpIndicatorHTML") + "\nreturn storeOpIndicatorHTML;");
    assert.match(factory("restore")(), /[Rr]estor/);
    assert.match(factory("move")(), /[Mm]ov/);
  });

  t(label + ": backupNow sets and clears _storeOpInFlight around its work", () => {
    assert.match(fn(src, "backupNow"), /_storeOpInFlight\s*=\s*"backup"/);
    assert.match(fn(src, "backupNow"), /finally/);
  });

  t(label + ": restoreFromList sets and clears _storeOpInFlight around its work", () => {
    assert.match(fn(src, "restoreFromList"), /_storeOpInFlight\s*=\s*"restore"/);
    assert.match(fn(src, "restoreFromList"), /finally/);
  });

  t(label + ": moveDataLocation sets and clears _storeOpInFlight around its work", () => {
    assert.match(fn(src, "moveDataLocation"), /_storeOpInFlight\s*=\s*"move"/);
    assert.match(fn(src, "moveDataLocation"), /finally/);
  });

  t(label + ": restoreLatest also sets _storeOpInFlight (covers the listBackups() await before restoreFromList runs)", () => {
    assert.match(fn(src, "restoreLatest"), /_storeOpInFlight\s*=\s*"restore"/);
    assert.match(fn(src, "restoreLatest"), /finally/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
