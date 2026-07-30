// tests/tabs-final-review-fixes.test.js — regressions for the whole-branch
// final review's findings on the Custom Tabs plan (docs/superpowers/plans/
// 2026-07-30-custom-tabs-core.md), not attributable to any single task:
//
// 1. (Critical) impDrop/impSave/impLike must re-render the Tabs view (not the
//    hidden Imported view) when curTab==="tabs" — otherwise a splice inside
//    imported reshuffles every later card's real index under a STALE,
//    index-bound tab grid, and the next click on a different card acts on
//    the wrong one (impDrop even frees the wrong stored image).
// 2. (Important) renderTabsView's auto-promote-to-first-tab path (reached
//    when the previously-open tab vanished, e.g. was just deleted) must
//    reset tabSelMode/tabSelPicks/_tabSug — otherwise picks/suggestions made
//    against the OLD tab silently carry over and get applied to whichever
//    tab the view lands on next.
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
  t(label + ": impDrop renders the Tabs view (not the hidden Imported view) when curTab is 'tabs'", () => {
    const calls = [];
    const importedArr = [{ id: "i0" }, { id: "i1" }];
    const factory = new Function(
      "imported", "curTab", "window", "document", "Store", "renderImported", "renderTabsView",
      "restoreImpScrollSettle", "updateCounts", "_impScrollY", "_impAnchorId", "_impAnchorTop",
      fn(src, "impDrop") + "\nreturn impDrop;"
    );
    const impDrop = factory(
      importedArr, "tabs",
      { scrollY: 0 }, { querySelector: () => null },
      { putCards: () => {}, imgDel: () => {} },
      () => calls.push("renderImported"), () => calls.push("renderTabsView"),
      () => calls.push("restoreImpScrollSettle"), () => {}, 0, "", 0
    );
    impDrop(0);
    assert.deepStrictEqual(calls, ["renderTabsView"], "must call renderTabsView, never renderImported, while a tab is open");
  });

  t(label + ": impSave renders the Tabs view (not the hidden Imported view) when curTab is 'tabs'", () => {
    const calls = [];
    const importedArr = [{ title: "A", url: "https://a.example" }];
    const factory = new Function(
      "imported", "saved", "curTab", "Store", "persistAll", "renderImportedKeepFocus", "renderTabsView",
      "updateCounts", "toast", "domain", "guessCat", "cleanDesc", "impThumb",
      fn(src, "impSave") + "\nreturn impSave;"
    );
    const impSave = factory(
      importedArr, [], "tabs",
      { putCards: () => {} }, () => {},
      () => calls.push("renderImportedKeepFocus"), () => calls.push("renderTabsView"),
      () => {}, () => {}, () => "example.com", () => "misc", (d) => d, () => null
    );
    impSave(0);
    assert.deepStrictEqual(calls, ["renderTabsView"], "must call renderTabsView, never renderImportedKeepFocus, while a tab is open");
  });

  t(label + ": impLike renders the Tabs view (not the hidden Imported view) when curTab is 'tabs'", () => {
    const calls = [];
    const importedArr = [{ title: "A" }];
    const factory = new Function(
      "imported", "curTab", "likes", "Store", "persistAll", "renderImportedKeepFocus", "renderTabsView",
      "toast", "guessCat",
      fn(src, "impLike") + "\nreturn impLike;"
    );
    const impLike = factory(
      importedArr, "tabs", [],
      { putCards: () => {} }, () => {},
      () => calls.push("renderImportedKeepFocus"), () => calls.push("renderTabsView"),
      () => {}, () => "misc"
    );
    impLike(0);
    assert.deepStrictEqual(calls, ["renderTabsView"], "must call renderTabsView, never renderImportedKeepFocus, while a tab is open");
  });

  t(label + ": renderTabsView's auto-promote-to-first-tab path resets tabSelMode/tabSelPicks/_tabSug", () => {
    const body = fn(src, "renderTabsView");
    // The auto-promote branch is the one that reassigns openTabId when the
    // previously-open tab no longer exists in `tabs` — assert its reset
    // statements are inside THAT branch (scoped so it can't accidentally
    // match some other unrelated block in the function).
    assert.match(
      body,
      /openTabId\s*=\s*tabs\[0\]\.id;[^}]*tabSelMode\s*=\s*false;[^}]*tabSelPicks\.clear\(\);[^}]*_tabSug\s*=\s*\[\];[^}]*_tabSugErr\s*=\s*"";[^}]*_tabSugLoading\s*=\s*false;/
    );
  });

  t(label + ": readerRemove renders the Tabs view (not the hidden Imported view) when curTab is 'tabs' — same splice-then-stale-index risk as impDrop", () => {
    const calls = [];
    const importedArr = [{ id: "i0" }, { id: "i1" }];
    const factory = new Function(
      "readerSnapshot", "readerPos", "imported", "curTab",
      "snapshotBeforeDestructive", "removeCards", "renderImported", "renderTabsView", "closeReader", "renderReader", "toast",
      fn(src, "readerRemove") + "\nreturn readerRemove;"
    );
    const readerRemove = factory(
      ["i0", "i1"], 0, importedArr, "tabs",
      () => {}, () => { importedArr.splice(0,1); },
      () => calls.push("renderImported"), () => calls.push("renderTabsView"),
      () => {}, () => {}, () => {}
    );
    readerRemove();
    assert.deepStrictEqual(calls, ["renderTabsView"], "must call renderTabsView, never renderImported, while a tab is open");
  });

  t(label + ": _afterTagEdit routes BOTH scopes to renderTabsView (not renderSaved/renderImported) when curTab is 'tabs'", () => {
    const calls = [];
    const factory = new Function(
      "imported", "saved", "Store", "window", "document", "requestAnimationFrame", "tagRow",
      "renderSaved", "renderImported", "curTab", "renderTabsView",
      fn(src, "_afterTagEdit") + "\nreturn _afterTagEdit;"
    );
    const make = () => factory(
      [{ id: "i0", tags: ["a"] }], [{ id: "s0", tags: ["a"] }],
      { putSaved: () => {}, putCards: () => {} },
      { scrollY: 0, scrollTo: () => {} },
      { querySelector: () => calls.push("querySelector") && null, createElement: () => ({}) },
      (cb) => {}, () => "<div></div>",
      () => calls.push("renderSaved"), () => calls.push("renderImported"),
      "tabs", () => calls.push("renderTabsView")
    );
    const afterSaved = make();
    afterSaved("saved", "s0");
    const afterImported = make();
    afterImported("imported", 0);
    assert.deepStrictEqual(calls, ["renderTabsView", "renderTabsView"], "both scopes must short-circuit to renderTabsView, and the imported scope must not even attempt the unscoped document.querySelector patch");
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
