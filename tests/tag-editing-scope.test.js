// tests/tag-editing-scope.test.js — Task 1: scope-aware tag-picker state
// (allTags/_tagPickItem) generalized to work across imported AND saved.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

function fn(src, name) {
  const m = extractFn(src, name);
  assert.ok(m, name + " not found in source");
  return m;
}

// Wires allTags/_tagPickItem against scripted `imported`/`saved` arrays and
// picker state, mirroring loadRowRenderers' technique in image-dupes-ui.test.js.
function load(src, state) {
  const factory = new Function(
    "imported", "saved", "_tagPickScope", "_tagPickIdx", "_tagPickId",
    fn(src, "allTags") + "\n" + fn(src, "_tagPickItem") + "\nreturn { allTags, _tagPickItem };"
  );
  return factory(state.imported, state.saved, state.scope, state.idx, state.id);
}

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": allTags merges tags from imported AND saved, exact-string deduped, sorted case-insensitively", () => {
    // allTags is a plain Set keyed by exact string — same as the original
    // allImportedTags it replaces, it does NOT case-fold two differently-cased
    // spellings of the same tag into one entry (that fuzzy matching is
    // canonicalTag's job, applied at the point a NEW tag is being added, not
    // here). "3d printing" appears in BOTH arrays and must collapse to one
    // entry; "Recipes"/"stl files" are each unique and both survive as-is.
    const { allTags } = load(src, {
      imported: [{ tags: ["3d printing", "Recipes"] }],
      saved: [{ tags: ["stl files", "3d printing"] }],
      scope: "imported", idx: -1, id: null,
    });
    assert.deepStrictEqual(allTags(), ["3d printing", "Recipes", "stl files"]);
  });

  t(label + ": _tagPickItem resolves by INDEX into `imported` when scope is imported", () => {
    const importedArr = [{ id: "i0" }, { id: "i1", tags: ["x"] }];
    const { _tagPickItem } = load(src, { imported: importedArr, saved: [], scope: "imported", idx: 1, id: null });
    assert.strictEqual(_tagPickItem(), importedArr[1]);
  });

  t(label + ": _tagPickItem resolves by ID into `saved` when scope is saved", () => {
    const savedArr = [{ id: "s0" }, { id: "s1", tags: ["x"] }];
    const { _tagPickItem } = load(src, { imported: [], saved: savedArr, scope: "saved", idx: -1, id: "s1" });
    assert.strictEqual(_tagPickItem(), savedArr[1]);
  });

  t(label + ": _tagPickItem returns undefined for a saved id that no longer exists", () => {
    const { _tagPickItem } = load(src, { imported: [], saved: [{ id: "s0" }], scope: "saved", idx: -1, id: "gone" });
    assert.strictEqual(_tagPickItem(), undefined);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
