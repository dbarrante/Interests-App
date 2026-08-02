# Carry views into Tabs — design

## Goal

While browsing an open Custom Tab, let the user filter by category and
change the grid/list display mode — both already exist for Saved/Stumble
(category) and Saved/Imported (display mode), but are completely hidden
today while viewing a Tab, even though the display-mode *setting* already
silently carries over once changed elsewhere.

Entirely a **web/pwa client-side feature**. No `core/` or `core/db.js`
changes — this switches on existing shared state and existing rendering
logic for one more section; no new state, no new UI components.

## Current state (context, not being changed)

- `filterCat` is one app-wide category filter, already shared between Saved
  and Stumble (`applyFilter(list)`, `web/index.html:1243-1248`) — picking a
  category in one carries over to the other.
- `viewMode` is one app-wide grid/list display setting, already shared
  between Saved and Imported (`gridClass()`) — already silently applied
  wherever `gridClass()` is used, including inside the Tabs grid.
- Both are surfaced through one shared bar, `#catBar`
  (`web/index.html:1191-1223`, `renderCatBar()`): a ternary that renders
  source pills for Imported, category pills for Stumble/Saved (and, as an
  incidental side effect of the ternary's structure, for any *other*
  `curTab` value too — including `"tabs"`), plus a row of view-mode toggle
  buttons appended for every `curTab` except Stumble (which has none).
- `renderCatBar()` is already called on every tab switch
  (`showTab(t)`, `web/index.html:1060`) — including switching to `"tabs"`.
- The only reason none of this is visible today while browsing a Tab: line
  `web/index.html:1059` explicitly sets `#catBar`'s `display` to `"none"`
  whenever `curTab` is `"settings"` **or `"tabs"`**.
- `tabsFilteredList(tag)` (`web/index.html:3497-3502`) currently filters
  only by tag membership across `imported`+`saved`, with no category check.
- `setFilter(k)` and `setView(v)` (`web/index.html:1224-1229`, `1044-1049`)
  each only call the render function for the `curTab` values they were
  written against at the time (`"saved"`/`"stumble"` for the former,
  `"saved"`/`"imported"` for the latter) — neither re-renders
  `renderTabsView()`, so even if the bar were visible, picking a filter or
  view while inside a Tab wouldn't visibly update anything yet.

## What changes

**One visibility flip, two added re-render branches, one added filter
check — all reusing existing app-wide state and existing rendering code:**

- `web/index.html:1059`: change the catBar-hide condition from
  `t==="settings"||t==="tabs"` to just `t==="settings"`. `renderCatBar()`
  itself needs no changes — its existing ternary already produces the right
  output for `curTab==="tabs"` (falls through past the Imported/Stumble
  branches to the same category-pills branch Saved uses, and the
  view-toggle row already renders for every non-Stumble `curTab`).
- `setFilter(k)`: add `else if(curTab==="tabs") renderTabsView();` so
  picking a category while inside a Tab actually re-renders it.
- `setView(v)`: add `else if(curTab==="tabs") renderTabsView();` — same
  reasoning, for the display-mode toggle.
- `tabsFilteredList(tag)`: apply the same category-name match
  `applyFilter()` already does for Saved/Stumble, to the function's own
  `{kind, it, idx}` result shape:
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
  (Duplicated rather than reshaping `applyFilter`'s signature to accept a
  key-extractor — matches this codebase's existing preference for small
  local duplication over widening an already-tested shared function's
  contract, same call made for the three `open*BulkTagPicker` wrappers.)

**Out of scope (confirmed):**
- No source/platform filter for a Tab's Imported-origin cards — category
  only, matching Saved's existing scope.
- No per-Tab-independent filter or view-mode state — both stay the single
  shared app-wide values they already are everywhere else.
- No changes to `renderCatBar()`'s branching logic itself, or to
  `applyFilter()`'s signature.

## Data flow

```
user picks a category pill or view-mode button while curTab==="tabs"
  → setFilter(k) / setView(v)   // existing functions, one added branch each
  → filterCat / viewMode updated + persisted (existing save() calls, unchanged)
  → renderTabsView()            // newly reached for this curTab
  → tabsFilteredList(tag)       // now also applies the category check
  → gridClass()                 // already viewMode-aware, unchanged
```

## Testing

- Plain-`assert` tests (`node tests/<name>.test.js`) covering: `showTab`'s
  catBar visibility no longer excludes `"tabs"`; `setFilter`/`setView` each
  call `renderTabsView()` when `curTab==="tabs"` (and still call the
  existing Saved/Stumble/Imported branches unchanged); `tabsFilteredList`
  narrows its result by category when `filterCat` is set, leaves it
  unfiltered when empty, and self-clears an invalid/stale `filterCat` the
  same way `applyFilter` does.
- Byte-identity check between the touched functions in `web/index.html` and
  `pwa/index.html` — required project convention.
