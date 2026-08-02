# Left-Sidebar Category Pills in Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing "Categories in a left sidebar" Settings toggle (`S.catSidebar`), today Saved-only, to also apply to the Tabs section's category pills.

**Architecture:** `catSidebarOn()` is already platform-agnostic; only `catSideActive` (inside `renderCatBar()`) scopes the setting to `curTab==="saved"`. Widen that gate, generalize `catSideHTML()` to accept the item list to count over (defaulting to `saved`, preserving Saved's exact current behavior), and — since `renderTabsView()` already rebuilds its content wholesale on every render like Imported does, not like Saved's static-element approach — embed the sidebar inline in `renderTabsView()`'s generated HTML, mirroring `tagSideHTML()`/Imported's `.imp-body` pattern.

**Tech Stack:** Vanilla JS, inline in `web/index.html` and `pwa/index.html` (must stay byte-identical for every touched function).

## Global Constraints

- One shared setting — no new/separate toggle for Tabs (spec: `docs/superpowers/specs/2026-08-02-tabs-catsidebar-design.md`).
- `catSideHTML()`'s existing call site for Saved (`web/index.html:1353`-equivalent) must need zero changes — the generalized function defaults to `saved` when called with no argument.
- Imported's own tag sidebar / `impSidebarOn()` / `S.tagSidebar` are untouched.
- Every function touched in `web/index.html` must be edited identically in `pwa/index.html` — byte-for-byte.
- Tests are plain Node `assert` scripts (`node tests/<name>.test.js`); `node tests/run.js` runs the syntax gate + all `*.test.js`.
- If any `pwa/index.html` edit lands, bump `pwa/sw.js`'s `SHELL_CACHE`.
- Commit trailer must be exactly `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Widen the sidebar setting to cover Tabs

**Files:**
- Modify: `web/index.html:1206` (`catSideActive` in `renderCatBar()`), `:3216-3224` (`catSideHTML`), `:3615-3668` (`renderTabsView`), `:3043` (resize handler), `:573` (Settings label).
- Modify: `pwa/index.html` at the mirrored lines — `:1245`, `:3291-3299`, `:3690-3743`, `:3118`, `:612`.
- Test: a new test file `tests/tabs-catsidebar.test.js`.

**Interfaces:**
- Produces: `catSideHTML(list)` — `list` optional, defaults to `saved`. No other function's signature changes.

- [ ] **Step 1: Write the failing tests**

Create `tests/tabs-catsidebar.test.js`:

```js
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
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `node tests/tabs-catsidebar.test.js`
Expected: FAIL on every case — none of the changes exist yet.

- [ ] **Step 3: Edit `web/index.html`**

Change `renderCatBar`'s `catSideActive` line (`web/index.html:1206`) from:

```js
  const catSideActive = curTab==="saved" && catSidebarOn();
```

to:

```js
  const catSideActive = (curTab==="saved" || curTab==="tabs") && catSidebarOn();
```

Change `catSideHTML` (`web/index.html:3216-3224`) from:

```js
function catSideHTML(){
  const counts = {};
  saved.forEach(s=>{ const c = catByName(String(s.category||"")); if(c) counts[c.key] = (counts[c.key]||0) + 1; });
  const rows = CATS.filter(c=>counts[c.key]).sort((a,b)=>counts[b.key]-counts[a.key]);   // populated cats, most first — like tags
  const activeName = filterCat ? ((CATS.find(c=>c.key===filterCat)||{}).name || filterCat) : "";
  return `<div class="tag-side-h">Categories</div>`
    + (filterCat ? `<span class="tg on" onclick="setFilter('')">&#10005; ${esc(activeName)}</span>` : "")
    + rows.map(c=> filterCat===c.key ? "" : `<span class="tg" onclick="setFilter('${c.key}')">${esc(c.name)} <b>${counts[c.key]}</b></span>`).join("");
}
```

to:

```js
function catSideHTML(list){
  const items = list || saved;
  const counts = {};
  items.forEach(s=>{ const c = catByName(String(s.category||"")); if(c) counts[c.key] = (counts[c.key]||0) + 1; });
  const rows = CATS.filter(c=>counts[c.key]).sort((a,b)=>counts[b.key]-counts[a.key]);   // populated cats, most first — like tags
  const activeName = filterCat ? ((CATS.find(c=>c.key===filterCat)||{}).name || filterCat) : "";
  return `<div class="tag-side-h">Categories</div>`
    + (filterCat ? `<span class="tg on" onclick="setFilter('')">&#10005; ${esc(activeName)}</span>` : "")
    + rows.map(c=> filterCat===c.key ? "" : `<span class="tg" onclick="setFilter('${c.key}')">${esc(c.name)} <b>${counts[c.key]}</b></span>`).join("");
}
```

Change `renderTabsView`'s grid-building section (`web/index.html:3634-3658`, from `} else {` through the closing of that block) from:

```js
  } else {
    const list = tabsFilteredList(t.tag);
    // filterCat alone isn't enough — a brand-new/genuinely-empty tab with an
    // unrelated category filter active elsewhere would wrongly claim the
    // filter is hiding cards. Use the tab's TRUE (unfiltered) count instead.
    const narrowed = filterCat && tabCardCount(t.tag) > 0;
    gridHtml = !list.length
      ? `<div class="empty"><h2>Nothing in "${esc(t.name)}"${narrowed?" in this category":" yet"}</h2><p>${narrowed?"Clear the category filter above to see everything in this tab.":"Add cards from Saved or Imported using the tag picker's Tabs section."}</p></div>`
      : `<div class="${gridClass()}">${list.map(r=>{
          // Imported identity is the card's stable id, NOT its array index — a pick
          // made now must still resolve to the right card even if something else
          // (a delete, a background capture-drain) splices `imported` before the
          // pick is acted on, which would silently shift every later index. Assign
          // BEFORE rendering the card, or impCardHTML bakes in a blank data-id/
          // _hoverCardId for this pass (self-heals next render, but no reason to).
          if(r.kind==="imported" && !r.it.id){ r.it.id=newId(); Store.putCards(imported); }
          let inner = r.kind==="saved" ? cardHTML(r.it,"saved",t.tag) : impCardHTML(r.it,r.idx,t.tag);
          // Wrapped together (not just concatenated) so the two stay one unit in the
          // multi-column masonry grid — a bare sibling div can otherwise land in the
          // NEXT column, visually detaching the panel from its own card.
          if(t.reserved) inner = `<div class="research-unit">${inner}${researchPanelHTML(r.kind, r.it)}</div>`;
          const identity = r.it.id;
          return tabCardWrapper(inner, r.kind, identity, tabSelPicks.has(r.kind+":"+identity));
        }).join("")}</div>`;
  }
```

to:

```js
  } else {
    const list = tabsFilteredList(t.tag);
    // filterCat alone isn't enough — a brand-new/genuinely-empty tab with an
    // unrelated category filter active elsewhere would wrongly claim the
    // filter is hiding cards. Use the tab's TRUE (unfiltered) count instead.
    const narrowed = filterCat && tabCardCount(t.tag) > 0;
    const innerHtml = !list.length
      ? `<div class="empty"><h2>Nothing in "${esc(t.name)}"${narrowed?" in this category":" yet"}</h2><p>${narrowed?"Clear the category filter above to see everything in this tab.":"Add cards from Saved or Imported using the tag picker's Tabs section."}</p></div>`
      : `<div class="${gridClass()}">${list.map(r=>{
          // Imported identity is the card's stable id, NOT its array index — a pick
          // made now must still resolve to the right card even if something else
          // (a delete, a background capture-drain) splices `imported` before the
          // pick is acted on, which would silently shift every later index. Assign
          // BEFORE rendering the card, or impCardHTML bakes in a blank data-id/
          // _hoverCardId for this pass (self-heals next render, but no reason to).
          if(r.kind==="imported" && !r.it.id){ r.it.id=newId(); Store.putCards(imported); }
          let inner = r.kind==="saved" ? cardHTML(r.it,"saved",t.tag) : impCardHTML(r.it,r.idx,t.tag);
          // Wrapped together (not just concatenated) so the two stay one unit in the
          // multi-column masonry grid — a bare sibling div can otherwise land in the
          // NEXT column, visually detaching the panel from its own card.
          if(t.reserved) inner = `<div class="research-unit">${inner}${researchPanelHTML(r.kind, r.it)}</div>`;
          const identity = r.it.id;
          return tabCardWrapper(inner, r.kind, identity, tabSelPicks.has(r.kind+":"+identity));
        }).join("")}</div>`;
    // Sidebar counts must reflect the tab's TRUE (tag-only) membership, not
    // `list` (already category-narrowed by tabsFilteredList) — otherwise the
    // active category would appear to have fewer members than it really does,
    // and every OTHER category would show its correct count while the active
    // one alone was wrong. Recomputed here rather than widening
    // tabsFilteredList's contract, matching this file's existing preference
    // for small local duplication over reshaping an already-tested function.
    gridHtml = catSidebarOn()
      ? `<div class="imp-body"><aside class="tag-side cat-side">${catSideHTML(imported.filter(it=>cardHasTag(it,t.tag)).concat(saved.filter(it=>it&&cardHasTag(it,t.tag))))}</aside>${innerHtml}</div>`
      : innerHtml;
  }
```

Change the resize handler (`web/index.html:3043`) from:

```js
window.addEventListener("resize", ()=>{ setStickyOffsets(); if(curTab==="imported"){ clearTimeout(_impResizeTimer); _impResizeTimer=setTimeout(renderImported,120); } else if(curTab==="saved" && S.catSidebar){ clearTimeout(_impResizeTimer); _impResizeTimer=setTimeout(renderSaved,120); } else if(curTab==="stumble"){ clearTimeout(_impResizeTimer); _impResizeTimer=setTimeout(()=>{ renderCatBar(); renderStumble(); },120); } });
```

to:

```js
window.addEventListener("resize", ()=>{ setStickyOffsets(); if(curTab==="imported"){ clearTimeout(_impResizeTimer); _impResizeTimer=setTimeout(renderImported,120); } else if(curTab==="saved" && S.catSidebar){ clearTimeout(_impResizeTimer); _impResizeTimer=setTimeout(renderSaved,120); } else if(curTab==="tabs" && S.catSidebar){ clearTimeout(_impResizeTimer); _impResizeTimer=setTimeout(renderTabsView,120); } else if(curTab==="stumble"){ clearTimeout(_impResizeTimer); _impResizeTimer=setTimeout(()=>{ renderCatBar(); renderStumble(); },120); } });
```

Change the Settings label (`web/index.html:573`) from:

```html
          <input type="checkbox" id="catSideToggle" style="width:auto"> Categories in a left sidebar (Saved view)
```

to:

```html
          <input type="checkbox" id="catSideToggle" style="width:auto"> Categories in a left sidebar (Saved &amp; Tabs)
```

- [ ] **Step 4: Mirror Step 3 into `pwa/index.html`**

Apply the identical before/after edits at `pwa/index.html`'s mirrored locations: `catSideActive` at `:1245`, `catSideHTML` at `:3291-3299`, `renderTabsView`'s grid section within `:3690-3743`, the resize handler at `:3118`, the Settings label at `:612`. Every edit must be byte-identical text to what you just wrote in `web/index.html` — copy-paste, don't retype.

- [ ] **Step 5: Run the test file to verify it passes**

Run: `node tests/tabs-catsidebar.test.js`
Expected: PASS, all cases, both `web` and `pwa`.

- [ ] **Step 6: Run the full suite**

Run: `node tests/syntax-check.js && node tests/run.js`
Expected: green. Pay particular attention to any existing test that asserted the OLD `catSideActive`/`catSideHTML`/Settings-label text verbatim (e.g. a parity or Settings test) — if any exists and now fails because it pinned the exact pre-change string, update it to match the new correct behavior (don't loosen its intent, just its literal text), the same way earlier plans this session handled an equivalent collision.

- [ ] **Step 7: Bump `pwa/sw.js`'s `SHELL_CACHE`**

Find the current value and increment it by 1 — `pwa/index.html` changed in this task.

- [ ] **Step 8: Commit**

```bash
git add web/index.html pwa/index.html pwa/sw.js tests/tabs-catsidebar.test.js
git commit -m "$(cat <<'EOF'
Extend the left-sidebar category setting to the Tabs section

catSideHTML(list) now accepts the item list to count over (defaults
to `saved`, Saved's own call site unchanged). Tabs embeds the sidebar
inline (imp-body + aside), matching Imported's pattern rather than
Saved's static-element one, since renderTabsView already rebuilds
wholesale. Sidebar counts use the tab's full tag-matched membership,
not the category-narrowed display list.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 9: Manual smoke test (document the checklist; run it live if a browser is available)**

1. Turn on "Categories in a left sidebar" in Settings. Open Saved — confirm the sidebar still works exactly as before (regression check).
2. Open a Tabs tab with cards spanning 2+ categories — confirm a left sidebar now appears (not the top-row pills) with correct per-category counts reflecting the WHOLE tab, not a filtered subset.
3. Click a category in the sidebar — confirm the grid narrows and the active category shows an "✕ CategoryName" clear-chip at the top of the sidebar, same as Saved.
4. While a category filter is active, switch to a genuinely different, empty-of-that-category tab — confirm the empty-state message and sidebar counts still make sense together.
5. Turn the setting back off — confirm Tabs reverts to the top-row pills, Saved does too.
6. Resize the window across the 760px breakpoint while on a Tabs tab with the setting on — confirm it switches between sidebar and top-row layout correctly (matching Saved's existing responsive behavior).
