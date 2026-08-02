# Carry Views Into Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While browsing an open Custom Tab, surface the category filter and grid/list view-mode toggle that already exist for Saved/Stumble/Imported, by un-hiding the shared bar that hosts them and teaching three functions to actually respond when `curTab==="tabs"`.

**Architecture:** No new state, no new UI. `filterCat` and `viewMode` are already app-wide shared variables; `renderCatBar()` already produces the right pills/buttons for any `curTab` that isn't `"imported"`/`"stumble"` (including `"tabs"`, incidentally, via its existing ternary fallthrough). The only things missing are: (1) the bar is explicitly hidden for `"tabs"`, (2) `setFilter`/`setView` don't re-render the Tabs view, (3) `tabsFilteredList` doesn't apply the category check `applyFilter` already does elsewhere.

**Tech Stack:** Vanilla JS, inline in `web/index.html` and `pwa/index.html` (must stay byte-identical for every touched function — enforced by `tests/tabs-parity.test.js`). No `core/` or `core/db.js` changes.

## Global Constraints

- Category filter and view mode stay the single shared app-wide values they already are — no per-Tab-independent state (spec: `docs/superpowers/specs/2026-08-02-tabs-filtering-design.md`).
- No source/platform filter for Tabs — category only.
- `renderCatBar()`'s branching logic and `applyFilter()`'s signature are NOT changed — only `showTab`, `setFilter`, `setView`, and `tabsFilteredList` are touched.
- Every function touched in `web/index.html` must be edited identically in `pwa/index.html` — byte-for-byte.
- Tests are plain Node `assert` scripts (`node tests/<name>.test.js`); `node tests/run.js` runs the syntax gate + all `*.test.js`. This project's `tests/_extract.js` `extractFn(src, name)` pulls one named top-level function's source for isolated `new Function(...)` execution.
- If any `pwa/index.html` edit lands, bump `pwa/sw.js`'s `SHELL_CACHE` (check current value, increment).
- Commit trailer must be exactly `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Un-hide and wire the shared filter/view bar for Tabs

This is one task, not several — un-hiding the bar without wiring `setFilter`/`setView`/`tabsFilteredList` to respond would ship a visible-but-broken control (pills that appear to do nothing), so all four edits ship together.

**Files:**
- Modify: `web/index.html:1059` (`showTab`'s catBar-hide condition), `:1224-1229` (`setFilter`), `:1044-1049` (`setView`), `:3497-3502` (`tabsFilteredList`).
- Modify: `pwa/index.html` at the mirrored lines — `:1098` (`showTab`), `:1262-1268` (`setFilter`), `:1083-1088` (`setView`), `:3572-3577` (`tabsFilteredList`).
- Test: `tests/tabs-view.test.js` (extend/fix — it currently has a test asserting the OLD hidden-for-tabs behavior, which this task inverts).

**Interfaces:**
- Consumes: existing `filterCat`, `CATS`, `viewMode`, `save()`, `renderTabsView()`, `renderCatBar()` — no new globals.
- Produces: no new functions. `tabsFilteredList(tag)` gains a second, optional-effect behavior (category narrowing) on its existing signature; `setFilter`/`setView` gain one additional `else if` branch each.

- [ ] **Step 1: Write the failing tests**

`tests/tabs-view.test.js:75-80` currently has this test, which asserts the behavior this task removes:

```js
  t(label + ": showTab wiring includes the new tabs view (nav array + catBar hidden + selMode clear + render call)", () => {
    const body = fn(src, "showTab");
    assert.match(body, /\[\s*"stumble"\s*,\s*"saved"\s*,\s*"imported"\s*,\s*"settings"\s*,\s*"tabs"\s*\]/);
    assert.match(body, /t===["']settings["']\s*\|\|\s*t===["']tabs["']/);
    assert.match(body, /if\(t===["']tabs["']\)\{\s*selMode=false;\s*selPicks\.clear\(\);.*renderTabsView\(\)/);
  });
```

Replace it with (drops the now-wrong catBar-hidden assertion, adds one asserting the bar is hidden for `"settings"` only, keeps the other two assertions unchanged):

```js
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
```

Add these new tests to the same file, inside the existing `for (const [label, src] of [["web", html], ["pwa", pwaHtml]])` loop:

```js
  t(label + ": setFilter re-renders the Tabs view when curTab is tabs", () => {
    const log = [];
    const factory = new Function(
      "curTab", "filterCat", "mobileFilterOpen", "save", "renderCatBar", "renderSaved", "renderStumble", "renderTabsView",
      fn(src, "setFilter") + "\nreturn setFilter;"
    );
    const setFilter = factory("tabs", "", false, () => {}, () => {}, () => log.push("saved"), () => log.push("stumble"), () => log.push("tabs"));
    setFilter("personal");
    assert.deepStrictEqual(log, ["tabs"]);
  });

  t(label + ": setFilter still only renders Saved for curTab=saved, Stumble for curTab=stumble (unchanged)", () => {
    const log = [];
    const factory = new Function(
      "curTab", "filterCat", "mobileFilterOpen", "save", "renderCatBar", "renderSaved", "renderStumble", "renderTabsView",
      fn(src, "setFilter") + "\nreturn setFilter;"
    );
    const setFilterSaved = factory("saved", "", false, () => {}, () => {}, () => log.push("saved"), () => log.push("stumble"), () => log.push("tabs"));
    setFilterSaved("personal");
    const setFilterStumble = factory("stumble", "", false, () => {}, () => {}, () => log.push("saved"), () => log.push("stumble"), () => log.push("tabs"));
    setFilterStumble("personal");
    assert.deepStrictEqual(log, ["saved", "stumble"]);
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
```

- [ ] **Step 2: Run the test file to verify the new/changed tests fail**

Run: `node tests/tabs-view.test.js`
Expected: FAIL — the new catBar-hidden-for-tabs-only-not test fails against current source; `setFilter`/`setView` tests fail (no `renderTabsView` branch yet); `tabsFilteredList` category tests fail (no category check yet).

- [ ] **Step 3: Edit `web/index.html`**

Change `showTab`'s catBar line (`web/index.html:1059`) from:

```js
  document.getElementById("catBar").style.display = (t==="settings"||t==="tabs")?"none":"";
```

to:

```js
  document.getElementById("catBar").style.display = t==="settings"?"none":"";
```

Change `setFilter` (`web/index.html:1224-1229`) from:

```js
function setFilter(k){
  filterCat = k;
  save("fcat", k);
  mobileFilterOpen = false;
  renderCatBar();
  if(curTab==="saved") renderSaved(); else if(curTab==="stumble") renderStumble();
}
```

to:

```js
function setFilter(k){
  filterCat = k;
  save("fcat", k);
  mobileFilterOpen = false;
  renderCatBar();
  if(curTab==="saved") renderSaved(); else if(curTab==="stumble") renderStumble(); else if(curTab==="tabs") renderTabsView();
}
```

Change `setView` (`web/index.html:1044-1049`) from:

```js
function setView(v){
  viewMode = v; save("view", v);
  renderCatBar();
  if(curTab==="saved") renderSaved();
  else if(curTab==="imported") renderImported();
}
```

to:

```js
function setView(v){
  viewMode = v; save("view", v);
  renderCatBar();
  if(curTab==="saved") renderSaved();
  else if(curTab==="imported") renderImported();
  else if(curTab==="tabs") renderTabsView();
}
```

Change `tabsFilteredList` (`web/index.html:3497-3502`) from:

```js
function tabsFilteredList(tag){
  const list = [];
  imported.forEach((it,idx)=>{ if(cardHasTag(it,tag)) list.push({kind:"imported", it, idx}); });
  saved.forEach(it=>{ if(it && cardHasTag(it,tag)) list.push({kind:"saved", it}); });
  return list;
}
```

to:

```js
function tabsFilteredList(tag){
  const list = [];
  imported.forEach((it,idx)=>{ if(cardHasTag(it,tag)) list.push({kind:"imported", it, idx}); });
  saved.forEach(it=>{ if(it && cardHasTag(it,tag)) list.push({kind:"saved", it}); });
  if(!filterCat) return list;
  const c = CATS.find(c=>c.key===filterCat);
  if(!c){ filterCat=""; save("fcat",""); return list; }
  return list.filter(r=>r.it.category===c.name);
}
```

- [ ] **Step 4: Mirror Step 3 into `pwa/index.html`**

Apply the identical before/after edits at `pwa/index.html`'s mirrored locations: `showTab`'s catBar line at `:1098`, `setFilter` at `:1262-1268`, `setView` at `:1083-1088`, `tabsFilteredList` at `:3572-3577`. Every edit must be byte-identical text to what you just wrote in `web/index.html` — copy-paste, don't retype.

- [ ] **Step 5: Run the test file to verify it passes**

Run: `node tests/tabs-view.test.js`
Expected: PASS, all cases (existing + new/changed), both `web` and `pwa`.

- [ ] **Step 6: Run the full suite**

Run: `node tests/syntax-check.js && node tests/run.js`
Expected: green, including `tests/tabs-parity.test.js` (confirms `showTab`/`setFilter`/`setView`/`tabsFilteredList` are still byte-identical web/pwa — none of them needs adding to any `FNS` list since they're presumably already covered; if any is missing from `tests/tabs-parity.test.js`'s `FNS` list, add it).

- [ ] **Step 7: Bump `pwa/sw.js`'s `SHELL_CACHE`**

Find the current value in `pwa/sw.js` and increment it by 1 — `pwa/index.html` changed in this task.

- [ ] **Step 8: Commit**

```bash
git add web/index.html pwa/index.html pwa/sw.js tests/tabs-view.test.js
git commit -m "$(cat <<'EOF'
Carry the category filter and view toggle into the Tabs section

Un-hides the shared catBar for curTab==="tabs" (it already rendered the
right pills/buttons for that case — only its container was hidden) and
teaches setFilter/setView/tabsFilteredList to actually respond, reusing
the existing app-wide filterCat/viewMode state.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 9: Manual smoke test (document the checklist; run it live if a browser is available)**

1. Open a Custom Tab with cards spanning at least two categories. Confirm the category pill row and the grid/1x1/2x2/list/Detail view buttons are now visible above the tab's cards.
2. Click a category pill — confirm the tab's card grid narrows to just that category, without leaving the Tabs section.
3. Switch to Saved — confirm the SAME category is still selected there (shared state), then switch back to the Tab — confirm it's still applied there too.
4. Click a different view-mode button (e.g. List) while inside the Tab — confirm the layout changes immediately, without leaving the Tabs section.
5. Switch to Imported — confirm the same view mode carried over (already worked before this change; confirm it still does).
6. Pick "All" to clear the category filter inside the Tab — confirm every card in the tab reappears.
7. Confirm Settings' catBar is still hidden (unaffected by this change) and Stumble's category sidebar/pill behavior is unchanged.
