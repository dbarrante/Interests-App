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

  // ---- count/filter agreement: what catSideHTML COUNTS into a category must be
  // exactly what tabsFilteredList RETURNS when that category is filtered on. Both
  // predicates are built from the REAL source in one scope so the comparison is
  // real rather than against a hand-written mock of either side.
  //
  // Fixtures are deliberately MIXED-SHAPE. Imported-origin cards carry their
  // category in `.cat`; saved cards in `.category`. Every earlier test in this
  // file used {category:...} only — which is precisely why the .cat bug survived
  // both the feature's own review and the tabs-filtering feature before it.
  const AGREE_CATS = [{key:"personal", name:"Personal projects & hobbies"}, {key:"work", name:"Work initiatives"}];
  const AGREE_IMPORTED = [
    {tags:["x"], cat:"Work initiatives"},                      // imported-shaped: .cat
    {tags:["x"], cat:""},                                      // genuinely untagged — belongs to NO category
    {tags:["other"], cat:"Work initiatives"}                    // wrong tag: never in this tab at all
  ];
  const AGREE_SAVED = [{id:"s0", tags:["x"], category:"Personal projects & hobbies"}];   // saved-shaped: .category
  // The exact list renderTabsView hands catSideHTML: tag-matched, NOT category-narrowed.
  const AGREE_TABCARDS = [AGREE_IMPORTED[0], AGREE_IMPORTED[1], AGREE_SAVED[0]];
  function loadPair(filterCat){
    const factory = new Function(
      "imported", "saved", "filterCat", "CATS", "save", "esc",
      fn(src, "catByName") + "\n" + fn(src, "cardHasTag") + "\n" +
      fn(src, "catSideHTML") + "\n" + fn(src, "tabsFilteredList") +
      "\nreturn { catSideHTML, tabsFilteredList };"
    );
    return factory(AGREE_IMPORTED, AGREE_SAVED, filterCat, AGREE_CATS, () => {}, escFn);
  }

  t(label + ": catSideHTML counts an IMPORTED-shaped card (.cat) into its real category", () => {
    const out = loadPair("").catSideHTML(AGREE_TABCARDS);
    assert.match(out, /Work initiatives <b>1<\/b>/, "the .cat card must be counted — imported cards never carry .category");
    assert.match(out, /Personal projects &amp; hobbies <b>1<\/b>/, "the saved-shaped .category card must still be counted");
  });

  t(label + ": catSideHTML counts an untagged card into NO category (no catByName CATS[0] fallback)", () => {
    // catByName("") returns CATS[0], so the lenient version silently inflated the
    // first category by every untagged card — cards that clicking that category
    // would then never show. Exact match keeps counts and filter in agreement.
    const counted = [...loadPair("").catSideHTML(AGREE_TABCARDS).matchAll(/<b>(\d+)<\/b>/g)].map(m => Number(m[1]));
    assert.strictEqual(counted.reduce((a, b) => a + b, 0), 2, "3 cards in the tab, but only 2 have a real category");
    assert.deepStrictEqual(counted.slice().sort(), [1, 1]);
  });

  t(label + ": count and filter AGREE for an imported-shaped card (matching + non-matching category)", () => {
    const workList = loadPair("work").tabsFilteredList("x");
    assert.strictEqual(workList.length, 1, "Work initiatives counted 1 — clicking it must return exactly that 1");
    assert.strictEqual(workList[0].it.cat, "Work initiatives");
    // Non-matching: the imported .cat card must NOT leak into the other category.
    const personalList = loadPair("personal").tabsFilteredList("x");
    assert.ok(!personalList.some(r => r.it.cat === "Work initiatives"), "a Work card must not appear under Personal");
  });

  t(label + ": count and filter AGREE for a saved-shaped card (matching + non-matching category)", () => {
    const personalList = loadPair("personal").tabsFilteredList("x");
    assert.strictEqual(personalList.length, 1, "Personal counted 1 — clicking it must return exactly that 1");
    assert.strictEqual(personalList[0].kind, "saved");
    assert.strictEqual(personalList[0].it.id, "s0");
    const workList = loadPair("work").tabsFilteredList("x");
    assert.ok(!workList.some(r => r.kind === "saved"), "the saved Personal card must not appear under Work");
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
