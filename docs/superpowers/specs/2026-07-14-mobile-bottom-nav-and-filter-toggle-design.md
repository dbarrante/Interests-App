# Mobile bottom tab bar + collapsible filter bar — design

## Problem

On a real iPhone (PWA, standalone display mode, `pwa/index.html`), the sticky
header nav and the category/tag pill bar together can consume the entire
screen height before a single card is visible.

Two things compound:

- `<header>`'s `.bar` (`pwa/index.html:392-404`) holds the logo, the 4 section
  tabs (Stumble/Saved/Imported/Settings), and the Help/Open-in-browser
  buttons in one flex row. At `≤640px` it's allowed to wrap
  (`.bar{flex-wrap:wrap}`, `nav{flex-wrap:wrap;flex:1 1 100%}` —
  `pwa/index.html:70-72`), pushing the tabs onto their own row.
- Below `≤760px`, the category/tag sidebar (`.tag-side`) that normally sits
  beside the cards on wide screens is hidden entirely
  (`pwa/index.html:181`), and its content falls back into the sticky
  `#catBar` (`renderCatBar()`, `pwa/index.html:946-968`) instead. `.catbar`
  is `flex-wrap:wrap` (`pwa/index.html:172`) with no row limit, so with
  10-30+ categories/tags it can wrap into many rows. Imported adds a second
  such row (`.imp-sticky`, the tag/search bar, `pwa/index.html:174-175`)
  stacked directly below the first.

Confirmed with the user: this happens on every tab (Stumble/Saved/Imported),
and the user's library has 10-30+ categories/tags, so the pill bar alone can
already be several rows tall before the header is even counted.

## Starting state

- `pwa/index.html` and `web/index.html` are the same file by convention —
  `pwa/README.md`'s Phase 4 note describes `pwa/index.html` as "a full copy
  of `web/index.html`... with only its `<script>` tags... edited." A diff
  ignoring `<script>` tags confirms the CSS/markup is currently identical.
  This bug lives entirely in that shared layer, not in anything PWA-specific.
- The existing `760px` breakpoint (`pwa/index.html:181`) is where the wide
  layout already gives way to the narrow one (sidebar hidden, pills fall
  back to the top bar). No new breakpoint is being introduced.
- `renderCatBar()` already branches on which tab is active and whether the
  wide-screen sidebar is showing (`stSidebarOn()`, `catSidebarOn()`) to
  decide what to put in `#catBar`. This design adds one more axis to that
  same function: whether the mobile pill row is collapsed or expanded.
- The manifest (`pwa/manifest.webmanifest`) already sets
  `"display": "standalone"`, so the app runs full-screen with no browser
  chrome on iPhone — meaning the fixed bottom bar this design adds must
  clear the home-indicator gesture area itself; nothing else will draw
  around it. There is no `viewport-fit=cover` in the current
  `<meta name="viewport">` (`pwa/index.html:5`), so
  `env(safe-area-inset-*)` currently resolves to `0` everywhere.

## Architecture

All changes below apply identically to `pwa/index.html` and `web/index.html`
(everything outside the `<script>` tags block), to keep the two copies from
drifting per the existing convention. All new CSS is scoped under the
existing `@media(max-width:760px)` breakpoint — desktop/wide-screen layout,
including the tag/category sidebars, is untouched.

**1. Bottom tab bar (mobile only)**

- `<meta name="viewport">` gets `viewport-fit=cover` added.
- At `≤760px`, `header nav` (the 4 section tabs) is hidden via CSS. The top
  header keeps only the logo + Help(?) + Open-in-browser button, one row,
  no wrap risk since the only wrap-prone element (the tab list) is gone.
- A new fixed-to-bottom bar is added (rendered once, always in the DOM, CSS
  visible only `≤760px`) containing the same 4 tab buttons, calling the
  existing `showTab('stumble'|'saved'|'imported'|'settings')` and reflecting
  `.active`/`.cnt` state exactly like today's `<nav>` does — the buttons are
  a second set of triggers for the same existing function and state, not a
  parallel implementation.
- The bar is padded with `max(8px, env(safe-area-inset-bottom))` so it
  clears the iPhone home-indicator area in standalone mode. `main`/body gets
  matching bottom padding at this breakpoint so the last row of cards isn't
  hidden behind the fixed bar.

**2. Collapsible filter bar (mobile only)**

- New module-level state, e.g. `let mobileFilterOpen = false;` — not
  persisted (always starts collapsed on load/tab-switch).
- `renderCatBar()` (`pwa/index.html:946`) gets one more branch: at `≤760px`
  and `!mobileFilterOpen`, render a single summary pill instead of the full
  pill list — `Filter: All ▾` when unfiltered, or `Filter: <name> ▾` when a
  filter is active (Stumble/Saved: current category name; Imported: current
  source label). Tapping it sets `mobileFilterOpen = true` and re-renders,
  showing the full original pill row(s).
- Every pill's existing selection handler (`setFilter()`, `setImpSrc()`)
  additionally sets `mobileFilterOpen = false` before re-rendering, so
  picking a filter auto-collapses back to the summary pill (confirmed
  behavior) — no separate "close" affordance needed.
- **Imported** is the one case with two stacked sticky blocks today: `#catBar`
  (source-platform pills) and `.imp-sticky` (`pwa/index.html:174-175`, built by
  `renderImported()` — confirmed on inspection to be a full toolbar: search
  box, sort toggle, Unreviewed/Failed/Couldn't-capture filters, the "Get
  pictures & info" capture button, Library health, tag menu, Select mode,
  *and* the tag pill row). Confirmed with the user: the toggle hides this
  entire combined block (both `#catBar` and all of `.imp-sticky`, actions
  included), not just the filter-ish parts — simplest behavior, consistent
  with every other tab where "expand filters" reveals everything that today
  lives in that sticky area.
- This is purely a presentation change to the already-existing narrow-screen
  fallback path. It doesn't touch `S.catSidebar`/`S.tagSidebar` (the
  wide-screen sidebar-vs-topbar settings) or add a new Settings entry.

## Data flow

No data/state changes — `filterCat`, `impSrc`, and the underlying
category/tag lists are exactly what they are today. The only new piece of
state is the ephemeral, unpersisted `mobileFilterOpen` boolean, read by
`renderCatBar()` (and Imported's tag-row render path) alongside the
existing `curTab`/`filterCat`/`impSrc` state it already reads.

## Error handling

Nothing here is a failure-prone operation (no network/storage calls) — the
only "error" case worth naming is a zero-category or zero-tag library: the
summary pill still renders (`Filter: All ▾`), and tapping it just expands to
an empty/near-empty row, which is already how `renderCatBar()` behaves today
in that scenario.

## Explicitly out of scope

- Any change to the wide-screen (`>760px`) layout, including the `.tag-side`
  sidebars and their Settings toggles.
- Moving the Help(?) / Open-in-browser buttons — they stay in the top
  header as-is, per explicit user choice.
- Persisting `mobileFilterOpen` across tab switches or reloads — it always
  starts collapsed.
- Changing `.imp-sticky`'s search input behavior itself — only its
  visibility is gated by the new toggle.
- Any change to `web/`'s other files or to `pwa/`'s PWA-specific files
  (`idb.js`, `oauth.js`, `sync-pwa.js`, etc.) — this is CSS/markup/small-JS
  only, in the shared `index.html` layer.

## Testing

Manual only, matching the rest of this project's browser-UI code (no
automated harness for `index.html`'s inline script). Concretely: load the
PWA/dev server in a browser at `≤760px` width (or on a real iPhone) and
confirm — bottom bar shows all 4 tabs with correct active/count state and
clears the home-indicator area; top header no longer wraps; the filter pill
starts collapsed on every tab, expands on tap, and auto-collapses after
picking a category (Stumble/Saved) or a source (Imported, along with the tag
row hiding together with it); `>760px` (desktop/wide window) is pixel-for-
pixel unchanged from before this change.

Remember (`pwa/HANDOFF.md`'s shell-cache gotcha): bump `pwa/sw.js`'s
`SHELL_CACHE` when this ships, or an already-installed iPhone PWA will keep
serving the old layout with no visible error.
