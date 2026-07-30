// tests/tag-editing-afterinit.test.js — Task 2 final-review fix: _afterTagEdit's
// scope routing was previously only exercised via a stub (tag-editing-crud.test.js)
// or not reached at all (tag-editing-render/parity). This tests the REAL function:
// scope="saved" must persist via Store.putSaved + re-render via renderSaved, never
// touching Store.putCards/renderImported, and vice versa for the imported fallback
// (card not present in the DOM) path.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }
function fn(src, name) { const m = extractFn(src, name); assert.ok(m, name + " not found in source"); return m; }

function loadAfterTagEdit(src, log) {
  const factory = new Function(
    "imported", "saved", "Store", "window", "document", "requestAnimationFrame", "tagRow",
    "renderSaved", "renderImported", "curTab", "renderTabsView",
    fn(src, "refreshTabsViewIfShowing") + "\n" + fn(src, "_afterTagEdit") + "\nreturn _afterTagEdit;"
  );
  const win = { scrollY: 0, scrollTo: () => {} };
  return factory(
    log.imported, log.saved,
    { putSaved: (arr) => log.calls.push(["putSaved", arr]), putCards: (arr) => log.calls.push(["putCards", arr]) },
    win,
    { querySelector: () => null, createElement: () => ({}) },   // card never found in the DOM -> imported branch falls through
    (cb) => {},
    () => "<div></div>",
    () => log.calls.push(["renderSaved"]),
    () => log.calls.push(["renderImported"]),
    "saved",   // curTab: neither "tabs" scenario is under test here — that's tests/tabs-final-review-fixes.test.js's job
    () => log.calls.push(["renderTabsView"])
  );
}

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": _afterTagEdit(scope='saved') calls Store.putSaved + renderSaved, never putCards/renderImported", () => {
    const savedArr = [{ id: "s0", tags: ["a"] }];
    const log = { imported: [], saved: savedArr, calls: [] };
    const _afterTagEdit = loadAfterTagEdit(src, log);
    _afterTagEdit("saved", "s0");
    assert.deepStrictEqual(log.calls.map(c => c[0]), ["putSaved", "renderSaved"]);
    assert.strictEqual(log.calls[0][1], savedArr);
  });

  t(label + ": _afterTagEdit(scope='imported', card not in DOM) calls Store.putCards + renderImported, never putSaved/renderSaved", () => {
    const importedArr = [{ id: "i0", tags: ["a"] }];
    const log = { imported: importedArr, saved: [], calls: [] };
    const _afterTagEdit = loadAfterTagEdit(src, log);
    _afterTagEdit("imported", 0);
    assert.deepStrictEqual(log.calls.map(c => c[0]), ["putCards", "renderImported"]);
    assert.strictEqual(log.calls[0][1], importedArr);
  });

  t(label + ": cardHTML's saved-mode branch calls tagRow(item.tags, item.id, \"saved\") literally", () => {
    const body = fn(src, "cardHTML");
    assert.match(body, /tagRow\(item\.tags,\s*item\.id,\s*"saved"\)/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
