# Left-sidebar category pills in Tabs — design

## Goal

Extend the existing "Categories in a left sidebar" Settings toggle
(`S.catSidebar`) — today Saved-only — so it also applies to the Tabs
section's category pills (added in `docs/superpowers/plans/2026-08-02-tabs-filtering.md`).
One shared setting: on, both Saved and Tabs show a left sidebar; off, both
show the top-row pills they show today.

Entirely a **web/pwa client-side feature**. No `core/` changes.

## Current state (context, not being changed)

- `catSidebarOn()` (`web/index.html:3189`) is already platform-agnostic:
  `!!S.catSidebar && window.innerWidth >= 760`.
- `catSideActive` (`web/index.html:1206`, inside `renderCatBar()`) is
  `curTab==="saved" && catSidebarOn()` — this is the only place scoping the
  setting to Saved specifically; when true, `renderCatBar()`'s top-row
  pills are suppressed (`catSideActive ? "" : ...`).
- Saved's sidebar uses a **static DOM element**: `#catSide`
  (`web/index.html:550`, an `<aside class="tag-side cat-side">` sibling of
  `#savedGrid`), shown/hidden and populated by `renderSaved()`
  (`web/index.html:1348-1358`) via `getElementById` + `.innerHTML =
  catSideHTML()`.
- `catSideHTML()` (`web/index.html:3216-3224`) computes category counts by
  iterating `saved` directly (hardcoded), and renders the same `setFilter()`
  click handlers the top-row pills use — it's a display alternative, not a
  different filtering mechanism.
- Imported has an analogous but **differently-built** sidebar
  (`tagSideHTML()`, `web/index.html:3178-3187`): unlike `catSideHTML`, it
  returns its own `<aside class="tag-side">...</aside>` wrapper and is
  embedded inline inside a `.imp-body` flex wrapper
  (`web/index.html:3136`) as part of `renderImported()`'s per-render
  innerHTML rebuild — because Imported has no static aside element the way
  Saved does.
- `renderTabsView()` already rebuilds `#view-tabs`'s content wholesale on
  every render (`v.innerHTML = ...`), matching Imported's approach, not
  Saved's — `#view-tabs` itself is an empty static `<div>`
  (`web/index.html:552`) with no fixed children.
- The resize handler (`web/index.html:2985`) already re-renders Saved when
  `S.catSidebar` is on and the window resizes; Tabs has no equivalent
  branch today (nor did it need one, having no sidebar).

## What changes

- **`catSideActive`**: widen from `curTab==="saved"` to
  `(curTab==="saved" || curTab==="tabs") && catSidebarOn()`, so the Tabs
  top-row pills correctly disappear when the sidebar is active, matching
  Saved's existing behavior.
- **`catSideHTML(list)`**: generalize to accept the item array to count
  categories over, defaulting to `saved` so Saved's existing call site
  (`web/index.html:1353`) needs no change and its behavior is byte-for-byte
  identical to today. The function's return shape is unchanged (inner
  content only, no `<aside>` wrapper) — Saved keeps injecting it into its
  static `#catSide` element exactly as today.
- **`renderTabsView()`**: since it already rebuilds inline (Imported's
  pattern, not Saved's), follow `tagSideHTML`'s convention rather than
  adding a new static aside element to the Tabs shell — wrap the tab's
  card grid in `.imp-body` and embed
  `<aside class="tag-side cat-side">${catSideHTML(tabCards)}</aside>`
  directly in the generated HTML when `catSideActive` is true, where
  `tabCards` is the tab's full tag-matched membership (both imported- and
  saved-origin, sourced the same way `tabsFilteredList` matches on tag) —
  but **not** narrowed by the active category filter, so the sidebar's
  counts stay meaningful (a category with 3 members doesn't vanish from
  the list just because it's the one currently selected). This means
  computing that raw list separately from `tabsFilteredList`'s own
  (category-narrowed) result, inside `renderTabsView()` — a few lines,
  mirroring `tabsFilteredList`'s tag-matching without its category-filter
  tail, matching this codebase's established preference for small local
  duplication over widening an already-tested function's contract (the
  same call made for `tabsFilteredList` itself when it was built, and for
  the three `open*BulkTagPicker` wrappers before that).
- **Resize handler**: add a `curTab==="tabs" && S.catSidebar` branch
  alongside the existing Saved one, re-rendering `renderTabsView` the same
  way.
- **Settings label** (`web/index.html:573`): update the copy from
  "Categories in a left sidebar (Saved view)" to reflect it now covers
  both Saved and Tabs.

## Out of scope (confirmed)

- No new/separate setting for Tabs — one shared toggle, per the approved
  scope decision.
- No change to Imported's own tag sidebar or its independent
  `impSidebarOn()`/`S.tagSidebar` setting.

## Testing

- Plain-`assert` tests covering: `catSideActive`'s widened condition;
  `catSideHTML(list)` defaults to `saved` when called with no argument
  (Saved's exact existing behavior preserved) and counts correctly against
  an arbitrary passed-in list; `renderTabsView`'s inline sidebar embed
  (present when the setting is on, absent when off, counts reflecting the
  tab's full membership rather than the post-filter subset); the resize
  handler's new Tabs branch.
- Byte-identity check between the touched functions in `web/index.html`
  and `pwa/index.html` — required project convention.
