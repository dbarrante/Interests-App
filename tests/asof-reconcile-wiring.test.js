// tests/asof-reconcile-wiring.test.js — the renderer half of the asOf
// staleness-preserve fix (2026-07-18 data-safety HIGH). Source-scan: the PUT
// responses carry `preserved`, storage.js folds them in BEFORE advancing _asOf,
// and index.html registers reconcile hooks that merge by id into the live
// globals. If any link breaks, a concurrently-merged card is silently deleted.
const assert = require("assert");
const fs = require("fs"), path = require("path");
const R = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + name + "\n  " + (e && e.message)); } }

const server = R("core/server.js");
t("PUT /api/cards + /api/saved return `preserved` in the response", () => {
  assert.ok(/replaceCards\(ctx\.db, cards, \{ asOf \}\)[\s\S]{0,400}preserved:\s*\(r && r\.preserved\)/.test(server), "cards PUT must return preserved");
  assert.ok(/replaceSaved\(ctx\.db, saved, \{ asOf \}\)[\s\S]{0,400}preserved:\s*\(r && r\.preserved\)/.test(server), "saved PUT must return preserved");
});

const storage = R("web/storage.js");
t("storage.js folds preserved rows in BEFORE advancing _asOf (order is load-bearing)", () => {
  for (const [kind, asVar] of [["Cards", "_asOfCards"], ["Saved", "_asOfSaved"]]) {
    const fn = storage.slice(storage.indexOf("put" + kind + ": function"), storage.indexOf("put" + kind + ": function") + 600);
    const recIdx = fn.indexOf("_reconcile" + kind);
    const asIdx = fn.indexOf(asVar + " = Date.now()");
    assert.ok(recIdx >= 0 && asIdx >= 0 && recIdx < asIdx,
      "put" + kind + ": reconcile must run before " + asVar + " advances");
  }
  assert.ok(/setReconcileHooks: function/.test(storage), "exposes setReconcileHooks");
});

const web = R("web/index.html");
t("web/index.html registers reconcile hooks that merge preserved rows by id into the live globals", () => {
  assert.ok(/Store\.setReconcileHooks\(/.test(web), "must register the hooks");
  assert.ok(/function _reconcileById\(arr, rows\)/.test(web), "by-id merge helper present");
  assert.ok(/_reconcileById\(imported, rows\)/.test(web) && /_reconcileById\(saved, rows\)/.test(web),
    "both imported and saved are reconciled");
  // dedup guard: only adds rows whose id isn't already present
  const helper = web.slice(web.indexOf("function _reconcileById"), web.indexOf("function _reconcileById") + 260);
  assert.ok(/have\.has\(r\.id\)/.test(helper), "must skip ids already in the array (no duplicates)");
});

console.log("asof-reconcile-wiring: " + passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
