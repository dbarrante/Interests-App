// tests/tabs-view.test.js — Task 2: the pure list-building logic behind the Tabs
// nav view (tabsFilteredList — critically, it must preserve each imported card's
// REAL index into `imported`, not a compacted 0..n index, since impCardHTML's
// buttons are all wired to that real index), plus showTab's wiring (nav array +
// catBar visibility) and openTab's state transition. Full DOM rendering
// (renderTabsView's innerHTML) is exercised by a manual smoke check per this
// repo's convention for innerHTML-heavy view functions (see tag-editing-render's
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
  const factory = new Function(
    "imported", "saved", "cardHasTag",
    fn(src,"tabsFilteredList") + "\nreturn tabsFilteredList;"
  );
  return factory(importedArr, savedArr, (it,tag)=>!!(it&&it.tags&&it.tags.includes(tag)));
}

function loadOpenTab(src, initialOpenTabId, log){
  const factory = new Function(
    "openTabId", "window", "renderTabsView",
    fn(src, "openTab") + "\nreturn { openTab, get: () => openTabId };"
  );
  return factory(initialOpenTabId, { scrollTo: () => {} }, () => log.push("rendered"));
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

  t(label + ": showTab wiring includes the new tabs view (nav array + catBar hidden + selMode clear + render call)", () => {
    const body = fn(src, "showTab");
    assert.match(body, /\[\s*"stumble"\s*,\s*"saved"\s*,\s*"imported"\s*,\s*"settings"\s*,\s*"tabs"\s*\]/);
    assert.match(body, /t===["']settings["']\s*\|\|\s*t===["']tabs["']/);
    assert.match(body, /if\(t===["']tabs["']\)\{\s*selMode=false;\s*selPicks\.clear\(\);.*renderTabsView\(\)/);
  });

  t(label + ": the desktop nav and mobile nav both gained a Tabs button", () => {
    const navMatches = src.match(/data-tab="tabs"/g) || [];
    assert.strictEqual(navMatches.length, 2, "expected exactly 2 data-tab=\"tabs\" buttons (desktop + mobile)");
  });

  t(label + ": a #view-tabs container exists", () => {
    assert.match(src, /id="view-tabs"/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
