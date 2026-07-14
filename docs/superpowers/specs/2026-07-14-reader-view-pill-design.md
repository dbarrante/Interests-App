# Reader view pill (Imported view selector) — design

## Problem

The single-card reader view (shipped earlier this session) is only reachable
via a small 📖 icon on each Imported card. There's no way to jump straight
into reading mode without first finding a specific card's icon.

## Starting state

- `VIEWS` (`web/index.html:873`) is the array of grid-density pills
  (1×1/2×2/4×4/Detail/List), rendered by `renderCatBar()`
  (`web/index.html:1035-1037`) and shared across both the Saved and
  Imported tabs.
- `setView(v)` (`web/index.html:874-879`) sets the persisted `viewMode`
  global (`save("view", v)`) and re-renders whichever tab is active.
  `gridClass()` (`web/index.html:880`) turns `viewMode` directly into a CSS
  class (`masonry m-<viewMode>`) — every value in `VIEWS` MUST have a
  corresponding `.m-<value>` CSS rule, since `viewMode` is reloaded from
  storage on every app boot and immediately fed into `gridClass()`.
- `openReader(idx)` (added this session) opens the reader at the `imported`
  array index passed in, building `readerSnapshot` (the current
  filtered/sorted Imported view, as item ids) and positioning at the
  clicked item within it.

## Scope

Imported tab only (confirmed with the user) — matches the reader view's
own existing scope; Saved is not touched.

## Architecture

**Not a new `viewMode` value.** The reader is a full-page overlay, not a
grid layout — if `"reader"` were added to `VIEWS` and became a persisted
`viewMode`, reloading the app later would feed `"reader"` into
`gridClass()` (`"masonry m-reader"`, no matching CSS) and silently break
grid rendering. Instead, the new pill is a one-shot **trigger**: tapping it
opens the reader at the first item in the current filtered/sorted Imported
view, without touching `viewMode`, without being saved, and without ever
showing an "active/selected" state itself (unlike the other view pills,
which are mutually-exclusive persistent choices). The underlying grid mode
is untouched — closing the reader returns to exactly the grid you had.

**`openReader(idx)` gains an optional `idx`.** Rather than duplicating the
filter/sort chain a third time (it already exists in `renderImported()`'s
`list` computation and in `openReader`'s own snapshot-building), `idx`
becomes optional: when omitted (the new pill's call), `openReader` still
builds the same `readerSnapshot` it always does, then defaults `readerPos`
to `0` (the first item) instead of looking up a specific clicked item's
position. When the resulting snapshot is empty (e.g. an active search/
filter currently matches nothing), `openReader` toasts a message and does
not open the modal — this guard is new; today the empty-snapshot case is
only handled inside `renderReader()` (which would otherwise let the modal
flash open and immediately auto-close via that existing check, a real but
minor UX artifact worth closing off at the source).

**Pill markup.** Appended after the existing `VIEWS.map(...)` output in
`renderCatBar()`, gated on `curTab==="imported"` (the pill row is
otherwise tab-agnostic) — reuses the existing `.catpill` styling, no
`.on`/active state, `onclick="openReader()"` (no argument).

## Data flow

Tap pill → `openReader()` (no `idx`) → same snapshot-building path as
today → `readerPos=0` → modal opens showing the first card in the current
view → paging/Remove/close all behave exactly as they already do, since
none of that logic changes.

## Error handling

Empty current view (e.g. a search with zero matches) → toast, no modal —
avoids the flash-open-then-auto-close artifact described above. This is
the only new error path; everything else is unchanged existing reader
behavior.

## Explicitly out of scope

- Saved tab — no reader support added there, per explicit user scope
  decision (mirrors the original reader-view spec's own scope boundary).
- Any change to `viewMode` persistence, `gridClass()`, or the existing
  five `VIEWS` entries.
- Any visual "active" state for the new pill — it's a trigger, not a
  selectable mode.

## Testing

Manual only, matching this project's convention. Concretely: on Imported,
confirm the new "📖 Reader" pill appears only on Imported (not Saved);
tapping it opens the reader at the first card in the CURRENT view (apply a
search/tag filter first and confirm it respects that, matching the
filtered order); confirm the underlying grid's view mode (g1/g2/g4/Detail/
List) is unchanged before and after using the pill; confirm tapping the
pill with an active filter that matches nothing shows a toast and does not
open a blank/flashing modal; confirm the per-card 📖 icon still works
exactly as before (its `idx`-provided call path is unchanged); reload the
app after using the pill and confirm `viewMode`/grid rendering are
unaffected (proving the pill never touched persisted state).
