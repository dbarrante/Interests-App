// tests/tag-editing-crud.test.js — Task 2: cardAddTag/cardRemoveTag work on
// EITHER `imported` (by index) or `saved` (by id), and route through
// _afterTagEdit with the right (scope, identity) — the generalization this
// whole plan exists for. _afterTagEdit itself is stubbed (it's DOM/Store
// glue, exercised for real in Task 3's tests) so this stays a pure logic test.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }
function fn(src, name) { const m = extractFn(src, name); assert.ok(m, name + " not found in source"); return m; }

function load(src, state, afterTagEditSpy) {
  const body = [
    fn(src, "allTags"), fn(src, "_tagPickItem"),
    fn(src, "cardAddTag"), fn(src, "cardRemoveTag"),
  ].join("\n");
  const factory = new Function(
    "imported", "saved", "_tagPickScope", "_tagPickIdx", "_tagPickId",
    "tsRec", "tsSave", "_afterTagEdit",
    body + "\nreturn { cardAddTag, cardRemoveTag };"
  );
  return factory(
    state.imported, state.saved, state.scope, state.idx, state.id,
    () => {}, () => {}, afterTagEditSpy
  );
}

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": cardAddTag mutates the SAVED item's tags when scope is saved, not imported", () => {
    const importedArr = [{ id: "i0", tags: [] }];
    const savedArr = [{ id: "s0", tags: [] }];
    let afterArgs = null;
    const { cardAddTag } = load(src, { imported: importedArr, saved: savedArr, scope: "saved", idx: -1, id: "s0" },
      (scope, identity) => { afterArgs = [scope, identity]; });
    cardAddTag("stl files");
    assert.deepStrictEqual(savedArr[0].tags, ["stl files"]);
    assert.deepStrictEqual(importedArr[0].tags, []);
    assert.deepStrictEqual(afterArgs, ["saved", "s0"]);
  });

  t(label + ": cardAddTag mutates the IMPORTED item's tags when scope is imported (unchanged behavior)", () => {
    const importedArr = [{ id: "i0", tags: [] }];
    let afterArgs = null;
    const { cardAddTag } = load(src, { imported: importedArr, saved: [], scope: "imported", idx: 0, id: null },
      (scope, identity) => { afterArgs = [scope, identity]; });
    cardAddTag("3d printing");
    assert.deepStrictEqual(importedArr[0].tags, ["3d printing"]);
    assert.deepStrictEqual(afterArgs, ["imported", 0]);
  });

  t(label + ": cardAddTag is a case-insensitive no-op if the tag is already present", () => {
    const importedArr = [{ id: "i0", tags: ["Recipes"] }];
    const { cardAddTag } = load(src, { imported: importedArr, saved: [], scope: "imported", idx: 0, id: null }, () => {});
    cardAddTag("recipes");
    assert.deepStrictEqual(importedArr[0].tags, ["Recipes"]);
  });

  t(label + ": cardRemoveTag removes from `saved` by id, independent of any open picker state", () => {
    const savedArr = [{ id: "s0", tags: ["a", "b"] }];
    let afterArgs = null;
    const { cardRemoveTag } = load(src, { imported: [], saved: savedArr, scope: "imported", idx: -1, id: null },
      (scope, identity) => { afterArgs = [scope, identity]; });
    cardRemoveTag("saved", "s0", "a");
    assert.deepStrictEqual(savedArr[0].tags, ["b"]);
    assert.deepStrictEqual(afterArgs, ["saved", "s0"]);
  });

  t(label + ": cardRemoveTag removes from `imported` by index (unchanged behavior)", () => {
    const importedArr = [{ id: "i0", tags: ["a", "b"] }];
    const { cardRemoveTag } = load(src, { imported: importedArr, saved: [], scope: "imported", idx: -1, id: null }, () => {});
    cardRemoveTag("imported", 0, "b");
    assert.deepStrictEqual(importedArr[0].tags, ["a"]);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
