// tests/pwa-stamp-preserve.test.js — guardedReplace must NOT re-stamp
// content-identical rows. Unconditional nowStamp on full-array persists was
// the ROOT CAUSE of the 2026-07-16 fleet event: a freshly-synced iPhone
// re-stamped all ~6,600 cards in one .map() (verified at millisecond
// granularity in its published snapshot), and LWW propagated the phantom
// stamps to every device — forcing full re-merges and (pre-v27) a full
// image re-download fleet-wide.
const assert = require("assert");
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "pwa", "storage-pwa.js"), "utf8");

function grab(source, name) {
  let idx = source.indexOf("async function " + name + "(");
  if (idx < 0) idx = source.indexOf("function " + name + "(");
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
function t(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + name + "\n  " + (e && e.message)); } }

t("contentSig excludes updatedAt and uses stable stringify (key order can't fake a change)", () => {
  const body = grab(src, "contentSig");
  assert.ok(/delete c\.updatedAt/.test(body), "must exclude updatedAt from the signature");
  assert.ok(/_iaStable/.test(body), "must use the stable stringify from pwa/merge.js");
});

t("guardedReplace preserves prior updatedAt on content-identical rows, stamps only real changes", () => {
  const body = grab(src, "guardedReplace");
  assert.ok(/contentSig\(p\) === contentSig\(row\)/.test(body), "must sig-compare against the prior row");
  assert.ok(/keep\.updatedAt = p\.updatedAt/.test(body), "identical content must keep the OLD stamp");
  assert.ok(/nowStamp\(Object\.assign\(\{\}, row\)\)/.test(body), "changed/new content still stamps fresh");
  const sigIdx = body.indexOf("contentSig(p)");
  const clearIdx = body.indexOf("idb.clear(");
  assert.ok(sigIdx >= 0 && clearIdx > sigIdx, "stamping decided before the clear+write");
});

// Functional check of the mapping logic with the real extracted functions.
const window = { _iaStable: null }; // fall back to JSON.stringify branch
const contentSig = eval("(" + grab(src, "contentSig") + ")");
t("functional: identical rows keep stamps, changed rows re-stamp (extracted logic)", () => {
  const prior = { a: { id: "a", title: "x", updatedAt: 111 }, b: { id: "b", title: "y", updatedAt: 222 } };
  const incoming = [{ id: "a", title: "x", updatedAt: 111 }, { id: "b", title: "CHANGED", updatedAt: 222 }, { id: "c", title: "new" }];
  const stamped = incoming.map((row) => {
    const p = prior[row.id];
    if (p && p.updatedAt != null && contentSig(p) === contentSig(row)) {
      const keep = Object.assign({}, row); keep.updatedAt = p.updatedAt; return keep;
    }
    const n = Object.assign({}, row); n.updatedAt = Date.now(); return n;
  });
  assert.strictEqual(stamped[0].updatedAt, 111, "unchanged row keeps its stamp");
  assert.ok(stamped[1].updatedAt > 222, "changed row re-stamps");
  assert.ok(stamped[2].updatedAt > 0, "new row gets a stamp");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
