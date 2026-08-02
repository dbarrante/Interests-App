// tests/tabs-view.test.js — Task 2: the pure list-building logic behind the Tabs
// nav view (tabsFilteredList — critically, it must preserve each imported card's
// REAL index into `imported`, not a compacted 0..n index, since impCardHTML's
// buttons are all wired to that real index), plus showTab's wiring (nav array +
// catBar visibility) and openTab's state transition. renderTabsView's empty-state
// branch is exercised by a real functional invocation (loadRenderTabsView, below —
// stubs out the DOM/card-render dependencies since list.length===0 never reaches
// them); its populated card-grid branch is still left to manual smoke-testing per
// this repo's convention for innerHTML-heavy view functions (see tag-editing-render's
// sibling scope — pure logic gets unit tests, DOM string-building gets smoke-tested).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }
function fn(src, name) { const m = extractFn(src, name); assert.ok(m, name + " not found in source"); return m; }

function loadFilteredList(src, importedArr, savedArr){
  // Extract the REAL cardHasTag from source rather than hand-mocking its
  // matching rule — a hand-written mock can silently drift from the actual
  // implementation (e.g. case-sensitivity) and hide a real regression.
  // filterCat/CATS/save are params tabsFilteredList now reads for category
  // narrowing (task 1) — default to "no filter set" so these pre-existing
  // callers keep exercising the unfiltered path unchanged.
  const factory = new Function(
    "imported", "saved", "filterCat", "CATS", "save",
    fn(src,"cardHasTag") + "\n" + fn(src,"tabsFilteredList") + "\nreturn tabsFilteredList;"
  );
  return factory(importedArr, savedArr, "", [], () => {});
}

function loadOpenTab(src, initialOpenTabId, log){
  const factory = new Function(
    "openTabId", "window", "renderTabsView", "tabSelMode", "tabSelPicks",
    fn(src, "openTab") + "\nreturn { openTab, get: () => openTabId };"
  );
  return factory(initialOpenTabId, { scrollTo: () => {} }, () => log.push("rendered"), false, new Set());
}

// Full functional invocation of renderTabsView (not just a source-shape regex) so the
// empty-state tests below actually exercise the real narrowed/tabCardCount logic against
// real data, the same way tests/tabs-final-review-fixes.test.js drives impDrop/impSave/etc.
// list.length===0 in both scenarios below, so list.map's per-card body (cardHTML,
// impCardHTML, researchPanelHTML, tabCardWrapper, newId, Store) is never reached and
// deliberately isn't stubbed — if it ever executes, that itself is a bug.
// catSidebarOn is stubbed to always-off here — neither call site below exercises
// the sidebar-embedding branch (task 1), only the pre-existing empty-state wording,
// so gridHtml always takes the `innerHtml` (non-sidebar) path and catSideHTML is
// never reached / never needs its own catByName/CATS/esc scope wired up.
function loadRenderTabsView(src, { tabs, openTabId, filterCat, imported, saved, CATS }){
  const factory = new Function(
    "document", "tabs", "openTabId", "filterCat", "tabSelMode", "tabSelPicks",
    "imported", "saved", "CATS", "save", "esc", "tabSuggestPanelHTML", "attachCardImages", "catSidebarOn",
    fn(src, "tabCardCount") + "\n" +
    fn(src, "cardHasTag") + "\n" +
    fn(src, "tabsFilteredList") + "\n" +
    fn(src, "renderTabsView") + "\nreturn renderTabsView;"
  );
  const view = { innerHTML: "" };
  const documentMock = { getElementById: (id) => id === "view-tabs" ? view : null };
  const esc = (s) => s == null ? "" : String(s); // fixture names below need no HTML-escaping
  const renderTabsView = factory(
    documentMock, tabs, openTabId, filterCat, false, new Set(),
    imported || [], saved || [], CATS || [], () => {}, esc,
    () => "", () => {}, () => false
  );
  renderTabsView();
  return view.innerHTML;
}

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": tabsFilteredList returns imported entries WITH their real array index", () => {
    const importedArr = [{tags:["x"]}, {tags:["stl files"]}, {tags:["x"]}, {tags:["stl files"]}];
    const tabsFilteredList = loadFilteredList(src, importedArr, []);
    const list = tabsFilteredList("stl files");
    assert.deepStrictEqual(list.map(r=>r.idx), [1,3]);
    assert.ok(list.every(r=>r.kind==="imported"));
  });

  t(label + ": tabsFilteredList includes matching saved entries (kind='saved', no idx)", () => {
    const savedArr = [{id:"s0",tags:["stl files"]}, {id:"s1",tags:["other"]}];
    const tabsFilteredList = loadFilteredList(src, [], savedArr);
    const list = tabsFilteredList("stl files");
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].kind, "saved");
    assert.strictEqual(list[0].it.id, "s0");
    assert.strictEqual(list[0].idx, undefined);
  });

  t(label + ": tabsFilteredList tolerates a null hole in saved without throwing", () => {
    const savedArr = [null, {id:"s1",tags:["stl files"]}];
    const tabsFilteredList = loadFilteredList(src, [], savedArr);
    const list = tabsFilteredList("stl files");
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].it.id, "s1");
  });

  t(label + ": openTab sets openTabId and triggers a re-render", () => {
    const log = [];
    const api = loadOpenTab(src, null, log);
    api.openTab("t1");
    assert.strictEqual(api.get(), "t1");
    assert.deepStrictEqual(log, ["rendered"]);
  });

  t(label + ": showTab wiring includes the tabs view (nav array + selMode clear + render call)", () => {
    const body = fn(src, "showTab");
    assert.match(body, /\[\s*"stumble"\s*,\s*"saved"\s*,\s*"imported"\s*,\s*"settings"\s*,\s*"tabs"\s*\]/);
    assert.match(body, /if\(t===["']tabs["']\)\{\s*selMode=false;\s*selPicks\.clear\(\);.*renderTabsView\(\)/);
  });

  t(label + ": showTab only hides catBar for settings, not tabs", () => {
    const body = fn(src, "showTab");
    assert.match(body, /catBar["']\)\.style\.display\s*=\s*\(?t===["']settings["']/);
    assert.doesNotMatch(body, /t===["']settings["']\s*\|\|\s*t===["']tabs["']/);
  });

  function loadSetFilter(src, curTab, tabSelMode, tabSelPicks, log){
    const factory = new Function(
      "curTab", "filterCat", "mobileFilterOpen", "save", "renderCatBar", "renderSaved", "renderStumble", "renderTabsView",
      "tabSelMode", "tabSelPicks",
      fn(src, "setFilter") + "\nreturn { setFilter, getSelMode: () => tabSelMode, getSelPicks: () => tabSelPicks };"
    );
    return factory(curTab, "", false, () => {}, () => {}, () => log.push("saved"), () => log.push("stumble"), () => log.push("tabs"), tabSelMode, tabSelPicks);
  }

  t(label + ": setFilter re-renders the Tabs view when curTab is tabs", () => {
    const log = [];
    const { setFilter } = loadSetFilter(src, "tabs", false, new Set(), log);
    setFilter("personal");
    assert.deepStrictEqual(log, ["tabs"]);
  });

  t(label + ": setFilter still only renders Saved for curTab=saved, Stumble for curTab=stumble (unchanged)", () => {
    const log = [];
    loadSetFilter(src, "saved", false, new Set(), log).setFilter("personal");
    loadSetFilter(src, "stumble", false, new Set(), log).setFilter("personal");
    assert.deepStrictEqual(log, ["saved", "stumble"]);
  });

  t(label + ": setFilter clears an active Tabs selection (mode + picks) when the category filter changes — a stale pick count on the destructive 'Remove from tab' button would otherwise act on cards no longer visible", () => {
    const log = [];
    const picks = new Set(["saved:s0", "imported:5"]);
    const api = loadSetFilter(src, "tabs", true, picks, log);
    api.setFilter("personal");
    assert.strictEqual(api.getSelMode(), false, "tabSelMode must be cleared");
    assert.strictEqual(api.getSelPicks().size, 0, "tabSelPicks must be cleared");
    assert.deepStrictEqual(log, ["tabs"], "must still re-render the Tabs view");
  });

  t(label + ": setFilter does NOT touch tabSelMode/tabSelPicks for curTab=saved or curTab=stumble (unchanged)", () => {
    const log = [];
    const savedPicks = new Set(["x"]);
    const savedApi = loadSetFilter(src, "saved", true, savedPicks, log);
    savedApi.setFilter("personal");
    assert.strictEqual(savedApi.getSelMode(), true);
    assert.strictEqual(savedApi.getSelPicks().size, 1);
  });

  t(label + ": setView re-renders the Tabs view when curTab is tabs", () => {
    const log = [];
    const factory = new Function(
      "curTab", "viewMode", "save", "renderCatBar", "renderSaved", "renderImported", "renderTabsView",
      fn(src, "setView") + "\nreturn setView;"
    );
    const setView = factory("tabs", "g4", () => {}, () => {}, () => log.push("saved"), () => log.push("imported"), () => log.push("tabs"));
    setView("list");
    assert.deepStrictEqual(log, ["tabs"]);
  });

  t(label + ": setView still only renders Saved/Imported for those curTabs (unchanged)", () => {
    const log = [];
    const factory = new Function(
      "curTab", "viewMode", "save", "renderCatBar", "renderSaved", "renderImported", "renderTabsView",
      fn(src, "setView") + "\nreturn setView;"
    );
    const setViewSaved = factory("saved", "g4", () => {}, () => {}, () => log.push("saved"), () => log.push("imported"), () => log.push("tabs"));
    setViewSaved("list");
    const setViewImported = factory("imported", "g4", () => {}, () => {}, () => log.push("saved"), () => log.push("imported"), () => log.push("tabs"));
    setViewImported("list");
    assert.deepStrictEqual(log, ["saved", "imported"]);
  });

  t(label + ": tabsFilteredList narrows by category when filterCat is set", () => {
    const importedArr = [{tags:["x"], category:"Personal projects & hobbies"}, {tags:["x"], category:"Work initiatives"}];
    const savedArr = [{id:"s0", tags:["x"], category:"Personal projects & hobbies"}, {id:"s1", tags:["x"], category:"Work initiatives"}];
    const CATS = [{key:"personal", name:"Personal projects & hobbies"}, {key:"work", name:"Work initiatives"}];
    const factory = new Function(
      "imported", "saved", "filterCat", "CATS", "save",
      fn(src,"cardHasTag") + "\n" + fn(src,"tabsFilteredList") + "\nreturn tabsFilteredList;"
    );
    const tabsFilteredList = factory(importedArr, savedArr, "personal", CATS, () => {});
    const list = tabsFilteredList("x");
    assert.strictEqual(list.length, 2);
    assert.ok(list.every(r => r.it.category === "Personal projects & hobbies"));
  });

  t(label + ": tabsFilteredList returns everything (no category narrowing) when filterCat is empty", () => {
    const importedArr = [{tags:["x"], category:"Personal projects & hobbies"}, {tags:["x"], category:"Work initiatives"}];
    const factory = new Function(
      "imported", "saved", "filterCat", "CATS", "save",
      fn(src,"cardHasTag") + "\n" + fn(src,"tabsFilteredList") + "\nreturn tabsFilteredList;"
    );
    const tabsFilteredList = factory(importedArr, [], "", [], () => {});
    const list = tabsFilteredList("x");
    assert.strictEqual(list.length, 2);
  });

  t(label + ": tabsFilteredList self-clears a stale/invalid filterCat instead of returning nothing", () => {
    const importedArr = [{tags:["x"], category:"Personal projects & hobbies"}];
    const saveCalls = [];
    const factory = new Function(
      "imported", "saved", "filterCat", "CATS", "save",
      fn(src,"cardHasTag") + "\n" + fn(src,"tabsFilteredList") + "\nreturn tabsFilteredList;"
    );
    const tabsFilteredList = factory(importedArr, [], "deleted-category-key", [], (k,v) => saveCalls.push([k,v]));
    const list = tabsFilteredList("x");
    assert.strictEqual(list.length, 1, "an unrecognized filterCat must not silently hide everything");
    assert.deepStrictEqual(saveCalls, [["fcat", ""]]);
  });

  t(label + ": the desktop nav and mobile nav both gained a Tabs button", () => {
    const navMatches = src.match(/data-tab="tabs"/g) || [];
    assert.strictEqual(navMatches.length, 2, "expected exactly 2 data-tab=\"tabs\" buttons (desktop + mobile)");
  });

  t(label + ": a #view-tabs container exists", () => {
    assert.match(src, /id="view-tabs"/);
  });

  t(label + ": renderTabsView's empty state ternary is keyed on a narrowed flag, not bare filterCat", () => {
    // A tab narrowed to zero cards by the active category filter must not tell
    // the user the tab itself is empty (renderSaved already sets this precedent
    // at "Nothing saved${filterCat?\" in this category\":\" yet\"}") — but bare
    // filterCat is truthy even when the tab is GENUINELY empty (zero cards
    // total), so the ternary must key off a derived "narrowed" flag instead.
    const body = fn(src, "renderTabsView");
    assert.match(body, /Nothing in ["'`].*narrowed\?["'] in this category["']:["'] yet["']/);
  });

  t(label + ": renderTabsView empty state — genuinely empty tab (zero total cards) with an active filterCat shows the 'yet'/add-cards message, not 'in this category'", () => {
    // The bug: a brand-new tab (or any tab with zero cards, period) while some
    // OTHER category filter happens to be active must not blame the filter —
    // clearing it would reveal nothing, and the user never learns the real
    // fix (add cards via the tag picker's Tabs section).
    const tabs = [{ id: "t1", name: "Empty Tab", tag: "empty-tag", reserved: false }];
    const CATS = [{ key: "personal", name: "Personal projects & hobbies" }];
    const rendered = loadRenderTabsView(src, { tabs, openTabId: "t1", filterCat: "personal", imported: [], saved: [], CATS });
    assert.match(rendered, /Nothing in "Empty Tab" yet/, "must use the 'yet' wording when the tab has zero cards, regardless of the active filter");
    assert.doesNotMatch(rendered, /in this category/, "must not blame the category filter when the tab is genuinely empty");
    assert.match(rendered, /Add cards from Saved or Imported using the tag picker's Tabs section\./);
  });

  t(label + ": renderTabsView empty state — tab has cards but the active filterCat excludes all of them shows 'in this category'", () => {
    // Pinning the other branch: a tab that DOES have cards, all just outside
    // the active category filter, must still point the user at clearing the
    // filter (the message this task's fix must not have broken).
    const tabs = [{ id: "t2", name: "Some Tab", tag: "some-tag", reserved: false }];
    const CATS = [{ key: "personal", name: "Personal projects & hobbies" }, { key: "work", name: "Work initiatives" }];
    const imported = [{ tags: ["some-tag"], category: "Work initiatives" }];
    const rendered = loadRenderTabsView(src, { tabs, openTabId: "t2", filterCat: "personal", imported, saved: [], CATS });
    assert.match(rendered, /Nothing in "Some Tab" in this category/, "must blame the filter when the tab genuinely has cards outside it");
    assert.match(rendered, /Clear the category filter above to see everything in this tab\./);
    assert.doesNotMatch(rendered, /Some Tab" yet/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
