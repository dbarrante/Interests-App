# Hashtag Library Scan + Manual Point-to-Point Capture — Design

Two independent features, specified together since both were requested in the
same conversation. Each can be planned and implemented as its own task group.

---

## Part 1: Hashtags → Tags Library Scan

**Goal:** a one-click action in Library Health that scans every card's title
for `#hashtags` and adds them as tags, across the whole library at once.

**Architecture:** a new Library Health tab, "Hashtags → Tags", sitting next to
the existing "AI refresh" tab. Unlike AI refresh, this requires no AI key and
has no "skip recently touched" freshness gate — hashtag extraction is a free,
local, deterministic, idempotent operation (`extractHashtags`/`mergeCleanTags`
already exist and are already used by the title picker and the image-refresh
button), so every run just re-scans everything; already-tagged cards no-op
instantly since `mergeCleanTags` dedupes against existing tags.

**Scope:** `imported.concat(saved)` — the same combined set `aiRefreshCandidates()`
already uses for AI refresh — not just Imported.

**Behavior:** for each card, call the existing `captureOutgoingHashtags(card)`
unchanged. It already does exactly what's needed: extract `#hashtags` from
`card.title`, merge them into `card.tags`, and leave the title text itself
untouched (consistent with the existing image-refresh button's hashtag
capture — no reason to diverge here).

**UI:**
- New `HEALTH_TABS` entry: `{ id:"hashtags", label:"Hashtags → Tags" }`.
- Tab body: a short description line ("Scans every card's title for #hashtags
  and adds them as tags. Titles are never changed.") + a single button,
  "Scan library" (no threshold/checkbox controls, unlike AI refresh).
- No `hasAIKey()` gate — the button is always enabled (a library with 0 cards
  can just be a no-op with a toast).

**Processing:** chunked in groups of 400 (mirrors `runAiRefreshBatch`'s
chunking, just at a larger chunk size since there's no per-item AI cost):

```js
const ALL = imported.concat(saved);
for (let i = 0; i < ALL.length; i += 400) {
  const chunk = ALL.slice(i, i + 400);
  let chunkTagged = 0;
  chunk.forEach(card => {
    const added = captureOutgoingHashtags(card);
    if (added && added.length) chunkTagged++;
  });
  Store.putCards(imported); Store.putSaved(saved); persistAll();
  toast(`Hashtag scan: ${Math.min(i+400, ALL.length)}/${ALL.length}…`);
}
```

Note: `captureOutgoingHashtags` currently returns `undefined` (no return
value) — it needs to return the array `mergeCleanTags` gives back (or `[]`
for a no-op) so this loop can count how many cards actually got new tags for
the completion toast. This is a small, backward-compatible signature change
(existing callers ignore the return value today).

**Completion:** `toast("Hashtag scan done — added tags to N of M cards")`.
Re-render Saved/Imported views afterward, same as `runAiRefreshBatch` does.

**Testing:** structural/unit tests mirroring `runAiRefreshBatch`'s existing
test coverage — chunk-size correctness, that titles are never mutated, that
an already-tagged card doesn't get double-added tags, and that both Imported
and Saved cards are covered. `captureOutgoingHashtags`'s new return value
needs a regression test confirming existing call sites (impRefresh,
impEditSave, cardEditSave, applyTitleSuggestions, enrichOnOpen) are
unaffected by it now returning a value instead of `undefined`.

---

## Part 2: Manual Point-to-Point Capture

**Goal:** let the user manually draw a rectangle on the actual page to choose
exactly what becomes a card's image, as a human-aimed alternative/fallback to
the automatic capture heuristics — available both from an existing card in
the app, and standalone from the extension on any page.

### Two entry points, one shared mechanism

**A. App-triggered (recapture an existing card).** A new icon on the card
face, next to the existing "↻" refresh icon (`impRefresh`). Clicking it:
1. Opens the card's URL in the browser (`openLink`, same as today).
2. Arms a capture request with a new flag: `Store.setCaptureRequest({url, id,
   manual:true})` — no `delay`/`force`/`render` needed, this path doesn't use
   the automatic-capture timing logic at all.
3. The extension's poller (`pollCaptureRequest`) sees `req.manual` and skips
   the normal `captureOneTab`/`renderCaptureFb` pipeline entirely — instead,
   once the tab finishes loading, it injects the region-select overlay
   (`chrome.scripting.executeScript`) and waits. Unlike every existing
   capture path, this one has **no timeout** — it's paced by the human
   deciding what to select, not a page finishing rendering.
4. On completion ("Use this"), the crop is delivered tagged with the card's
   `id` and `force:true` — routed by the existing `routeCapture` id-match
   logic into `card-image`, exactly like today's refresh does. This needs no
   new routing logic.
5. On cancel (Escape at any point), nothing is delivered. The card's
   `lastResult` (set to `"pending"` when the request was armed, mirroring
   `impRefresh`) should revert to its prior value rather than being left
   showing "pending" forever with nothing coming.

**B. Extension-standalone (any page, no existing card required).** A new
context-menu item, "Point-to-point capture," added alongside the existing
"Save to Interests" / "Remove from Interests" items in
`chrome.contextMenus.onClicked`. Clicking it immediately injects the same
overlay on the current tab (no capture-request mailbox involved — this
mirrors the existing synchronous `captureCtxPost` right-click flow, just
launching the overlay instead of an instant clip).

On completion, deliver `{url, title: <scraped page title>, screenshot:
<cropped data URL>, force:true, ts}` — deliberately **without** `clip:true`
(so it does NOT take the clip flow's always-new-Saved-item path) and
**without** an `id` (there is none to know yet). This lets the existing
`routeCapture` logic decide:
- If the URL matches an existing **Imported** card → `card-image`, updates
  that card's image (same as path A).
- If no match → falls through to the existing-but-currently-unused rule
  `cap.force && !cap.id && !cap.blocked → { action: "saved", reason: "manual
  capture, no card → Saved" }` — creates a new Saved entry via the existing
  `addClip(cap)`, which already knows how to use `cap.title` and
  `cap.screenshot` (confirmed by reading `addClip` — no changes needed there).
  This is the resolution to "if there is no existing card... create a card
  and link the URL and title" — lands in Saved, matching the design decision
  above, using entirely existing, already-tested code.

The page's title for this path reuses the same `content.js` metadata
extraction already used by `clipCurrentPage`/`captureTab`.

### The overlay itself (shared by both entry points)

A full-viewport `position:fixed` overlay, injected on demand via
`chrome.scripting.executeScript` (the manifest already grants `<all_urls>` +
`scripting`, so this works on any page without broadening the persistent
`content_scripts` matches).

1. Semi-transparent dark background (`rgba(0,0,0,.5)`) with a crosshair
   cursor.
2. `mousedown` records the drag start point (viewport CSS pixels);
   `mousemove` while the button is held draws a live rectangle — the
   selected area shown undimmed/bordered, everything else stays dark
   (standard screenshot-tool look).
3. `mouseup` finalizes the rect `{x, y, w, h}` — the same shape
   `cropScreenshot(tab, rect)` already consumes (it already exists, already
   handles `devicePixelRatio` scaling, already used internally for FB's
   stability-crop). The content script messages the background script with
   this rect; **only the background script can call
   `chrome.tabs.captureVisibleTab`** (a background-only API), so it performs
   the actual `cropScreenshot` and sends the resulting data URL back.
4. The content script then shows a small floating panel with that cropped
   image as a preview, plus two buttons: **Use this** (finalizes — see
   delivery above) and **Redo** (discards, removes the preview, re-arms the
   drag overlay for another attempt — no need to re-inject the script).
5. **Escape** cancels at any point (during the drag, or at the preview step)
   — removes the overlay/preview entirely and, for the app-triggered path,
   notifies the background script so it can revert the card's pending state
   (see A.5 above). No delivery happens on cancel.

### Data safety / error handling

- If the tab navigates away or is closed while the overlay is active
  (before "Use this"), the overlay/content-script state is simply gone with
  it — nothing is delivered, same effective outcome as a cancel. No new
  cleanup logic needed beyond what tab-close already does naturally.
- The extension-standalone path's "no match → new Saved item" branch never
  dedupes against existing Saved entries for the same URL (consistent with
  the existing clip flow, which has the same property) — capturing the same
  untracked page twice makes two Saved entries, exactly as "Save to
  Interests" already behaves today.
- This never touches an Imported card's data through any path except the
  two explicit, user-initiated "update this specific image" actions above —
  no batch/automatic logic is added or changed.

### Testing

- `routeCapture` (`web/route-capture.js`, mirrored in `pwa/`): a regression
  test proving the existing `force && !cap.id && !cap.blocked → saved`
  branch is reachable and correct (it currently has no caller exercising it
  in practice) — plus that an id-tagged manual-capture payload still routes
  to `card-image` exactly like today's refresh.
- `addClip`: confirm it correctly uses `cap.screenshot` + `cap.title` for a
  brand-new item (this path already exists and is tested via the clip flow,
  but add a case using the new payload shape — no `clip:true` — for
  completeness).
- Extension-side (`background.js`/`capture-core.js`): structural
  source-assertion tests in the same style as `tests/ext-sw-driver.test.js`
  and this session's `tests/fb-capture-hang-fix.test.js` — confirming the
  `req.manual` branch skips the automatic pipeline, the context-menu item is
  registered, and the overlay's finalize/cancel messages are handled. No
  live-browser test of the actual drag interaction is feasible in this
  repo's test setup; that needs manual verification in the real extension
  (matching how the FB capture fixes were verified this session).
