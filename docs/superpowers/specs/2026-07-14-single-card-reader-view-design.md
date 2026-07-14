# Single-card reader view (Imported) — design

## Problem

Triaging the Imported library today means scanning a masonry grid — there's
no way to focus on one item at a time and decide keep/remove without either
scrolling the grid or clicking through to the external article (which
navigates away from the app entirely; `openItem()`/`impOpen()` both just
call `openLink(it.url)`, per `web/index.html`). The backlog's "single-card
reader" request asks for a page-sized view of the card's own content — one
at a time, with paging and a way to remove — for focused triage of a large
pile.

## Starting state

- No existing detail/expanded view of a single card exists. The `"detail"`
  entry in `VIEWS` (`web/index.html:842`) is a grid density option (2-column
  masonry, larger fonts) — still multiple cards per screen, not a per-card
  view.
- The app already has a full-page overlay pattern: `#modal`/`#healthModal`/
  `#getpicModal`, each toggled via a `.open` CSS class, each closed via a
  unified `keydown` Escape handler (`web/index.html:4178-4187`) that closes
  exactly the topmost open surface.
- `removeCards(ids, {scope, skipImg})` (`web/index.html:4086-4104`) is the
  established remove primitive — it does NOT itself snapshot/backup or
  toast; callers pair it with `snapshotBeforeDestructive()` before and a
  toast (with undo) after, matching the Library Health modal's pattern.
- Imported's filtered/sorted `list` (search + source + tag filter, sort
  order) is computed fresh inside `renderImported()` on every render
  (`web/index.html:2282-2284`) and doesn't escape that function today — no
  global "currently visible items" state exists to page through.
- This spec touches only `web/index.html`/`pwa/index.html` (identical
  outside `<script src>` tags, per this project's established convention —
  every edit applies to both).

## Scope

Imported tab only (confirmed with the user — not Saved, not Stumble;
Stumble swipe navigation is an explicitly separate, later brainstorm).
Desktop and PWA both get the same reader; PWA additionally gets touch-swipe
paging (see "Swipe navigation" below).

## Architecture

**1. Entry point.** A new small icon button (📖) added to each Imported
card's existing action row (`impCardHTML()`), alongside the card's other
per-item controls. `onclick="openReader(idx)"` — does not touch the
existing thumb/title click behavior (`impOpen()`, still opens the external
article directly, unchanged).

**2. New overlay: `#readerModal`.** Same family as `#modal`/`#healthModal`/
`#getpicModal` (`.open` class toggle), but sized full-viewport rather than
the 560px `.modal-box` cap — this is meant to feel like its own space.
Layout (per the approved mockup, "immersive"): the card's image fills most
of the viewport; a bottom gradient-overlay strip holds title, description/
benefit, tags, the position indicator ("N of M"), and the Remove button.
Close (✕) top-right; prev/next chevrons (‹/›) at the left/right edges of
the viewport.

**3. Paging snapshot.** `openReader(idx)` captures its own copy of the
*current* filtered/sorted Imported list — re-deriving it the same way
`renderImported()` does (`imported.filter(impFilterPredicate).sort(...)`)
— plus the clicked item's position in that snapshot. Prev/Next walk this
snapshot array, not live `imported`/re-filtered state, so the reader's
"N of M" stays stable even if something else mutates `imported` while it's
open (shouldn't happen — nothing else runs while a full-page overlay is
open — but the snapshot makes that an explicit non-issue rather than an
assumption). Reaching either end disables/hides that end's chevron — no
wraparound.

**4. Keyboard.** Left/Right arrow keys page prev/next. Esc closes — added
as a new topmost-priority branch in the existing unified Escape handler
(`web/index.html:4178-4187`), ahead of `getpicModal`/`healthModal`/`modal`,
since the reader is meant to layer over everything else.

**5. Swipe navigation (touch).** A `touchstart`/`touchend` listener on the
reader's image area computes horizontal delta; past a small threshold
(prevents accidental taps from firing a page), swipe-left → next,
swipe-right → previous — matching the ‹/› layout (right arrow = next).
Attached unconditionally (not gated to the PWA build or a width
breakpoint) — touch events simply never fire on a non-touch device, so
this works on any touchscreen (PWA on iPhone, or a touch-capable Windows
laptop running the desktop build) without needing a platform check.
Swipe is navigation-only — it does not trigger Remove; that stays a
deliberate tap on the Remove button, so the gesture vocabulary stays
unambiguous.

**6. Remove.** Calls the established backup-first pattern:
`snapshotBeforeDestructive()` → `removeCards(new Set([id]), {scope:
"imported"})` → toast with undo, exactly matching Library Health's
pattern rather than the simpler single-card `impDrop()` (which bypasses
`removeCards` and doesn't snapshot). After removal, the reader auto-
advances to the next card in its local snapshot (removing the just-deleted
entry from that snapshot array first, so "N of M" stays accurate). If the
removed card was the last one in the snapshot, the reader closes back to
the grid instead of advancing into nothing.

## Data flow

`openReader(idx)` → snapshot list + position → render bottom-strip content
for the current item → Prev/Next/swipe/arrow-keys mutate only the local
position within the snapshot, re-rendering the strip + image → Remove
mutates real app state (`imported`, `Store`) via the existing
`removeCards`/`snapshotBeforeDestructive` primitives, then mutates the
local snapshot to drop that entry and re-renders at the same index (now
pointing at what was "next"). Closing (✕/Esc) discards the snapshot and
returns to whatever `renderImported()` shows for current live state —
since edits during reader viewing are limited to removals already reflected
in `imported`, no extra re-render reconciliation is needed beyond what
`removeCards` already triggers.

## Error handling

No new failure modes beyond what `removeCards`/`snapshotBeforeDestructive`
already handle (both existing, already covered by the Library Health
modal's error paths). Opening the reader on an empty/already-filtered-away
snapshot (e.g. the underlying filter changed between grid render and click
— not expected in practice, since the click and the snapshot happen in the
same synchronous handler) is a non-issue by construction.

## Explicitly out of scope

- Saved and Stumble tabs — Imported only, per explicit user scope decision.
- Stumble swipe navigation — a separate, later brainstorm (different
  interaction semantics: Stumble already has 👍/👎/deal-size mechanics that
  need their own design conversation about what a swipe should mean there).
- Swipe-to-remove or any other gesture beyond left/right paging — not
  requested; Remove stays a deliberate button tap.
- Embedding/loading the actual external article in-app — the reader shows
  only the card's own stored content (title/image/description/tags), per
  explicit user choice over an embedded-article alternative.
- Any change to `impOpen()`/`openItem()`'s existing click-to-open-article
  behavior.

## Testing

Manual only, matching this project's convention for `index.html`'s inline
script (no automated harness beyond the syntax-parse gate). Concretely:
open the reader from a card, confirm the snapshot's "N of M" matches the
grid's current filtered count; page via arrows, keyboard, and (on a
touch-capable environment) swipe; confirm Remove backs up, removes,
auto-advances, and that removing the last item closes the reader; confirm
Esc closes the reader specifically (not some other open overlay) when
layered over another modal; confirm desktop (`web/index.html`, real
`Store`) and PWA (`pwa/index.html`) behave identically since neither this
feature nor `removeCards` depends on any PWA-stubbed `Store` method.
