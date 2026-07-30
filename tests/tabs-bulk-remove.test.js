// tests/tabs-bulk-remove.test.js — Task 5: the tab-detail view's own bulk-select
// (composite scope:identity keys, since a tab mixes imported+saved cards) and its
// one bulk action, "Remove from tab" — which strips just the tab's own tag, not
// the whole tags array.
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
  t(label + ": toggleTabPick adds/removes the composite scope:identity key", () => {
    const factory = new Function(
      "tabSelPicks", "renderTabsView",
      fn(src, "toggleTabPick") + "\nreturn toggleTabPick;"
    );
    const picks = new Set();
    const toggleTabPick = factory(picks, () => {});
    toggleTabPick("imported", 4);
    assert.ok(picks.has("imported:4"));
    toggleTabPick("imported", 4);
    assert.ok(!picks.has("imported:4"));
  });

  t(label + ": tabCardWrapper leaves the card untouched when tabSelMode is off", () => {
    const factory = new Function("tabSelMode", fn(src, "tabCardWrapper") + "\nreturn tabCardWrapper;");
    const tabCardWrapper = factory(false);
    assert.strictEqual(tabCardWrapper("<div>card</div>", "imported", 4, false), "<div>card</div>");
  });

  t(label + ": tabCardWrapper adds a pick overlay reflecting the picked state when tabSelMode is on", () => {
    const factory = new Function("tabSelMode", fn(src, "tabCardWrapper") + "\nreturn tabCardWrapper;");
    const tabCardWrapper = factory(true);
    const wrapped = tabCardWrapper("<div>card</div>", "saved", "s0", true);
    assert.match(wrapped, /toggleTabPick\('saved','s0'\)/);
    assert.match(wrapped, /&#10003;/);
    const unpicked = tabCardWrapper("<div>card</div>", "saved", "s1", false);
    assert.doesNotMatch(unpicked, /&#10003;/);
  });

  t(label + ": removeTabPicksFromTab strips only the open tab's tag, from both imported and saved picks", () => {
    const importedArr = [{ tags: ["stl files", "other"] }, { tags: ["stl files"] }];
    const savedArr = [{ id: "s0", tags: ["stl files"] }];
    const calls = [];
    const body = [fn(src, "removeTabPicksFromTab")].join("\n");
    const factory = new Function(
      "tabs", "openTabId", "tabSelPicks", "tabSelMode", "imported", "saved", "Store", "toast", "renderTabsView",
      body + "\nreturn removeTabPicksFromTab;"
    );
    const removeTabPicksFromTab = factory(
      [{ id: "t1", name: "STL files", tag: "stl files", reserved: false }], "t1",
      new Set(["imported:0", "saved:s0"]), true,
      importedArr, savedArr,
      { putCards: (arr) => calls.push(["putCards", arr]), putSaved: (arr) => calls.push(["putSaved", arr]) },
      () => calls.push("toast"), () => calls.push("render")
    );
    removeTabPicksFromTab();
    assert.deepStrictEqual(importedArr[0].tags, ["other"]);
    assert.deepStrictEqual(importedArr[1].tags, ["stl files"]);   // not picked — untouched
    assert.deepStrictEqual(savedArr[0].tags, []);
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === "putCards"));
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === "putSaved"));
  });

  t(label + ": entering the Tabs view ALSO clears Saved's own select mode, not just Imported's — fixes a double-overlay bug where a saved card shown inside a tab could render both cardHTML's own pick overlay (savedSelMode) and tabCardWrapper's", () => {
    const body = fn(src, "showTab");
    assert.match(body, /if\(t===["']tabs["']\)\{[^}]*savedSelMode=false;[^}]*savedSelPicks\.clear\(\);[^}]*savedAddTabMenuOpen=false;[^}]*renderTabsView\(\)/);
  });

  t(label + ": renderTabsView wires a Select toggle and, when active, the Remove-from-tab bar", () => {
    const body = fn(src, "renderTabsView");
    assert.match(body, /toggleTabSelMode/);
    assert.match(body, /removeTabPicksFromTab/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
