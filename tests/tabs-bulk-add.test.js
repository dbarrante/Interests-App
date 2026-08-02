// tests/tabs-bulk-add.test.js — bulkAddTag's pure mutation logic, plus the
// Saved/Imported/Tabs wiring that opens the shared bulk tag picker
// (docs/superpowers/plans/2026-08-01-bulk-retag.md). cardHTML's/the bulk
// bar's innerHTML is covered by a manual smoke check (same convention as
// tabs-view).
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
  t(label + ": bulkAddTag adds the tag to every item missing it and counts only those changed", () => {
    const factory = new Function(fn(src, "bulkAddTag") + "\nreturn bulkAddTag;");
    const bulkAddTag = factory();
    const items = [{ tags: [] }, { tags: ["stl files"] }, { tags: ["other"] }];
    const n = bulkAddTag(items, "stl files");
    assert.strictEqual(n, 2);
    assert.deepStrictEqual(items[0].tags, ["stl files"]);
    assert.deepStrictEqual(items[1].tags, ["stl files"]);   // already had it — untouched, not duplicated
    assert.deepStrictEqual(items[2].tags, ["other", "stl files"]);
  });

  t(label + ": bulkAddTag is case-insensitive when checking for an existing tag", () => {
    const factory = new Function(fn(src, "bulkAddTag") + "\nreturn bulkAddTag;");
    const bulkAddTag = factory();
    const items = [{ tags: ["STL Files"] }];
    const n = bulkAddTag(items, "stl files");
    assert.strictEqual(n, 0);
    assert.deepStrictEqual(items[0].tags, ["STL Files"]);
  });

  t(label + ": addImportedPicksToTab applies the tab's tag to every picked imported index and persists", () => {
    const importedArr = [{ tags: [] }, { tags: [] }];
    const calls = [];
    const body = [fn(src, "bulkAddTag"), fn(src, "addImportedPicksToTab")].join("\n");
    const factory = new Function(
      "imported", "tabs", "selPicks", "Store", "toast", "renderImportedKeepFocus",
      body + "\nreturn addImportedPicksToTab;"
    );
    const addImportedPicksToTab = factory(
      importedArr, [{ id: "t1", name: "STL files", tag: "stl files", reserved: false }], new Set([1]),
      { putCards: (arr) => calls.push(["putCards", arr]) },
      () => calls.push("toast"), () => calls.push("render")
    );
    addImportedPicksToTab("t1");
    assert.deepStrictEqual(importedArr[0].tags, []);
    assert.deepStrictEqual(importedArr[1].tags, ["stl files"]);
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === "putCards"));
  });

  t(label + ": cardHTML's saved-mode branch supports a pick-overlay when savedSelMode is on", () => {
    const body = fn(src, "cardHTML");
    assert.match(body, /savedSelMode/);
    assert.match(body, /toggleSavedPick/);
  });

  t(label + ": Imported's existing select-mode bulk bar gained an Add-to-tab control", () => {
    assert.match(src, /toggleImpAddTabMenu/);
    assert.match(src, /addImportedPicksToTab/);
  });

  t(label + ": a #savedBulkBar container exists in the static shell (both files, not just web)", () => {
    assert.match(src, /id="savedBulkBar"/);
  });

  t(label + ": impAddTabMenuHTML closes itself once the backing selection empties, even if left 'open'", () => {
    const factory = new Function(
      "impAddTabMenuOpen", "selPicks", "tabs", "esc",
      fn(src, "impAddTabMenuHTML") + "\nreturn impAddTabMenuHTML;"
    );
    const menu = factory(true, new Set(), [{ id: "t1", name: "STL files", tag: "stl files", reserved: false }], (s) => s);
    assert.strictEqual(menu(), "");
  });

  t(label + ": openSavedBulkTagPicker opens the shared bulk picker with every picked saved item", () => {
    const savedArr = [{ id: "s0", tags: [] }, { id: "s1", tags: [] }, { id: "s2", tags: [] }];
    let openedWith = null;
    const factory = new Function(
      "saved", "savedSelPicks", "openBulkTagPicker",
      fn(src, "openSavedBulkTagPicker") + "\nreturn openSavedBulkTagPicker;"
    );
    const openSavedBulkTagPicker = factory(savedArr, new Set(["s0", "s2"]), (items) => { openedWith = items; });
    openSavedBulkTagPicker({});
    assert.deepStrictEqual(openedWith, [savedArr[0], savedArr[2]]);
  });

  t(label + ": openSavedBulkTagPicker does nothing when nothing is picked", () => {
    let called = false;
    const factory = new Function(
      "saved", "savedSelPicks", "openBulkTagPicker",
      fn(src, "openSavedBulkTagPicker") + "\nreturn openSavedBulkTagPicker;"
    );
    const openSavedBulkTagPicker = factory([], new Set(), () => { called = true; });
    openSavedBulkTagPicker({});
    assert.strictEqual(called, false);
  });

  t(label + ": openSavedBulkTagPicker's onDone persists, tags the toast with the applied tag, and exits select mode", () => {
    const savedArr = [{ id: "s0", tags: [] }];
    const calls = [];
    const factory = new Function(
      "saved", "savedSelPicks", "savedSelMode", "openBulkTagPicker", "Store", "toast", "renderSaved",
      fn(src, "openSavedBulkTagPicker") + "\nreturn openSavedBulkTagPicker;"
    );
    const openSavedBulkTagPicker = factory(
      savedArr, new Set(["s0"]), true,
      (items, onDone) => onDone(1, "travel"),
      { putSaved: (arr) => calls.push(["putSaved", arr]) },
      (msg) => calls.push(["toast", msg]),
      () => calls.push("render")
    );
    openSavedBulkTagPicker({});
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === "putSaved"));
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === "toast" && /travel/.test(c[1])));
    assert.ok(calls.includes("render"));
  });

  t(label + ": the Saved bulk toolbar's tag button is an Apply-tag trigger, not the old tab-only menu", () => {
    const body = fn(src, "renderSaved");
    assert.match(body, /openSavedBulkTagPicker\(event\)/);
    assert.match(body, /bulk-tag-btn/);
    assert.doesNotMatch(body, /toggleSavedAddTabMenu/);
  });

  t(label + ": the old Custom-Tab-only Saved bulk-add mechanism is fully removed", () => {
    assert.strictEqual(extractFn(src, "addSavedPicksToTab"), null);
    assert.strictEqual(extractFn(src, "savedAddTabMenuHTML"), null);
    assert.strictEqual(extractFn(src, "toggleSavedAddTabMenu"), null);
    assert.doesNotMatch(src, /savedAddTabMenuOpen/);
  });

  t(label + ": entering the Tabs view still resets Saved's select mode (savedAddTabMenuOpen reference removed)", () => {
    const body = fn(src, "showTab");
    assert.match(body, /if\(t===["']tabs["']\)\{\s*selMode=false;\s*selPicks\.clear\(\);.*savedSelMode=false;\s*savedSelPicks\.clear\(\);.*renderTabsView\(\)/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
