// tests/tabs-catsidebar.test.js — extends the existing Saved-only
// "Categories in a left sidebar" setting (S.catSidebar) to the Tabs
// section, per docs/superpowers/plans/2026-08-02-tabs-catsidebar.md.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }
function fn(src, name) { const m = extractFn(src, name); assert.ok(m, name + " not found in source"); return m; }
const escFn = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": renderCatBar's catSideActive is true for both saved and tabs when the sidebar setting is on", () => {
    const body = fn(src, "renderCatBar");
    assert.match(body, /const catSideActive\s*=\s*\(curTab===["']saved["']\s*\|\|\s*curTab===["']tabs["']\)\s*&&\s*catSidebarOn\(\)/);
  });

  t(label + ": catSideHTML defaults to `saved` when called with no argument (Saved's existing behavior unchanged)", () => {
    const savedArr = [{category:"Personal projects & hobbies"}, {category:"Work initiatives"}, {category:"Personal projects & hobbies"}];
    const CATS = [{key:"personal", name:"Personal projects & hobbies"}, {key:"work", name:"Work initiatives"}];
    const factory = new Function(
      "saved", "CATS", "filterCat", "esc",
      fn(src, "catByName") + "\n" + fn(src, "catSideHTML") + "\nreturn catSideHTML;"
    );
    const catSideHTML = factory(savedArr, CATS, "", escFn);
    const out = catSideHTML();
    assert.match(out, /Personal projects &amp; hobbies <b>2<\/b>/);
    assert.match(out, /Work initiatives <b>1<\/b>/);
  });

  t(label + ": catSideHTML counts over an explicitly passed list instead of `saved`", () => {
    const savedArr = [{category:"Personal projects & hobbies"}];   // must be ignored when a list is passed
    const CATS = [{key:"personal", name:"Personal projects & hobbies"}, {key:"work", name:"Work initiatives"}];
    const factory = new Function(
      "saved", "CATS", "filterCat", "esc",
      fn(src, "catByName") + "\n" + fn(src, "catSideHTML") + "\nreturn catSideHTML;"
    );
    const catSideHTML = factory(savedArr, CATS, "", escFn);
    const out = catSideHTML([{category:"Work initiatives"}, {category:"Work initiatives"}]);
    assert.match(out, /Work initiatives <b>2<\/b>/);
    assert.doesNotMatch(out, /Personal projects/);
  });

  t(label + ": renderTabsView embeds the sidebar (imp-body + aside.cat-side) when the setting is on", () => {
    const body = fn(src, "renderTabsView");
    assert.match(body, /catSidebarOn\(\)/);
    assert.match(body, /imp-body/);
    assert.match(body, /aside class=["']tag-side cat-side["']/);
  });

  t(label + ": renderTabsView's sidebar count list is tag-matched but NOT narrowed by the active category filter", () => {
    const body = fn(src, "renderTabsView");
    // The raw counting list must come from a fresh tag match (cardHasTag), not
    // from `list`/tabsFilteredList's own (already category-narrowed) result —
    // catSideHTML must never be called with the narrowed `list` variable.
    assert.doesNotMatch(body, /catSideHTML\(list\)/);
  });

  t(label + ": the resize handler re-renders Tabs when curTab is tabs and the sidebar setting is on", () => {
    assert.match(src, /curTab===["']tabs["']\s*&&\s*S\.catSidebar.*renderTabsView/);
  });

  t(label + ": the Settings label no longer claims Saved-only", () => {
    assert.doesNotMatch(src, /Categories in a left sidebar \(Saved view\)/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
