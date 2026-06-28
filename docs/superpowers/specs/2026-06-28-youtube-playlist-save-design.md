# YouTube Playlist-Save → Library (Native Save Mirroring, slice 1) Design

**Date:** 2026-06-28
**Status:** Approved (design); ready for implementation planning
**Topic:** When the user adds a YouTube video to a playlist, capture that video into the Interests App's Saved library — extending the existing in-page capture engine, which today mirrors native Save on Facebook / Instagram / Pinterest but has no YouTube save-mirror.

---

## Goal

YouTube is the one platform whose "Save" means *add to a playlist*, so the capture engine's `saveTrigger` for it is deliberately stubbed (`() => null`). This slice gives YouTube a real `saveTrigger`: adding a video to **any** playlist (the "Save to playlist" dialog, or the one-click "Save to Watch later") captures that video into the app's **Saved** library, reusing the entire existing pipeline. Extension-only; no app reinstall.

This is **slice 1** of the "Native Save-to-Interests mirroring" family. The other pieces — an explicit "Save to Interests" item injected into the FB/IG/Pinterest post ⋯ menu, and verifying/hardening the existing FB/IG/Pinterest mirrors — are **out of scope here** and remain queued (each its own spec → plan → build).

## Decisions locked with the user (2026-06-28)

1. **Trigger scope = EVERY playlist add.** Ticking any playlist in the "Save to playlist" dialog (Watch Later, Liked, or any custom playlist) captures; so does the one-click "Save to Watch later" in a thumbnail's ⋮ menu.
2. **Add only, never remove.** Fire only when a playlist is toggled **on**; un-ticking (remove from playlist) captures nothing.
3. **Not the Like button.** The thumbs-up Like is a different action and is **excluded** (capturing every like would flood the library).
4. **Both watch-page and feed saves.** Saving from a video's watch page AND from a thumbnail's ⋮ menu in the feed/grid/search are both supported.
5. **Goes to the Saved library only**, never modifies an Imported card (standing data-safety invariant).

## Non-goals (this slice)

- The explicit "Save to Interests" ⋯-menu injection (FB/IG/Pinterest) — separate slice.
- Capturing thumbs-up Likes, or YouTube channel subscriptions.
- Capturing a *removal* from a playlist.
- New delivery/routing plumbing — this reuses `clipSocialPost` → `POST /api/captures` → `web/route-capture.js` unchanged.
- Any change to the app (`web/`, `core/`, `main.js`) — extension-only.

---

## Architecture

The work is entirely inside the **existing capture engine** (`extension/capture-core.js` + `extension/capture-configs.js`), which is already injected on `*://*.youtube.com/*` (manifest content_scripts, since v4.35). The engine's flow is unchanged:

```
 user adds video to a playlist
        │
        ▼
 capture-core.js click listener  ──►  cfg.saveTrigger(e, U)  (YouTube: NEW — returns the add control)
        │ (truthy)
        ▼
 cfg.findPost(trigger, U)  ──►  the pending video tile (or the watch-page video)
        │
        ▼
 doCapture → clipSocialPost { url:/watch?v=…, title, image, … }
        │
        ▼
 background.js  ──►  derives the i.ytimg/hqdefault thumbnail from the /watch id (already implemented)
        │
        ▼
 POST /api/captures  ──►  app drains → web/route-capture.js  ──►  clip → Saved library (never Imported)
```

Only **two files** change: `extension/capture-configs.js` (the `youtube` config) and `extension/manifest.json` (version bump). `background.js` already derives the `i.ytimg` thumbnail for any youtube clip (from the v4.36 right-click work), so it needs no change.

### The crux: detecting the add + resolving which video

YouTube's add-to-playlist dialog (`ytd-add-to-playlist-renderer`, a list of `ytd-playlist-add-to-option-renderer` rows each with a `tp-yt-paper-checkbox`) opens in a **detached** popup container — it is NOT inside the video's tile. So when a playlist row is ticked, the click target carries no reference to the video. Two coordinated mechanisms solve this (mirroring how the Facebook config tracks which post owns an open menu via `fbLastPost`):

**(a) Pending-video tracking (`init` + a capture-phase click listener):**
- The `youtube` config keeps module-closure state `_pendingVideo` (an element) + `_pendingAt` (timestamp).
- When the user clicks a video tile's **⋮ "Action menu"** button (a tile-scoped control — resolvable to its tile via the existing `findPost` tile walk), record `_pendingVideo = that tile` and stamp `_pendingAt`.
- On a **watch page** (`/watch?v=…` or `/shorts/…`), the pending video is always resolvable from the page itself (`location.href` carries the id), so no tracking is needed there.

**(b) `saveTrigger(e, U)` — returns a truthy control on a real playlist ADD:**
- **Dialog tick:** the click is on a playlist option row / its checkbox inside `ytd-add-to-playlist-renderer`, AND the row is currently **un-checked** (i.e. about to toggle on). `saveTrigger` runs at click time, before YouTube flips the state, so "currently unchecked → about to add" is read from the row's `aria-checked="false"` / unchecked checkbox. An already-checked row being clicked = a remove → return null.
- **One-click Watch Later:** the click is on a menu item whose label is "Save to Watch later" (a direct add, no dialog). ("Save to playlist" merely *opens* the dialog and is NOT itself an add — return null for it.)
- Returns the clicked control so the engine proceeds; returns null otherwise.

**`findPost(trigger, U)` override:** if `trigger` is inside the add-to-playlist dialog or a Watch-later menu item (i.e. not itself a video tile), return `_pendingVideo` when it is set and recent (`Date.now() - _pendingAt < 60000`); otherwise, on a watch page, return the page video element; otherwise null (skip — better to capture nothing than the wrong video). If `trigger` *is* a video tile (the right-click `captureCtxPost` path), keep the existing tile resolution unchanged.

The rest of the `youtube` config (`isSpecificUrl`, `findPermalink` → clean `/watch?v=` URL, `extract` → `#video-title`, `title`, `image:"photo"`, `imageCdn:/ytimg/`) is already correct and is reused as-is.

---

## Data flow, dedup & data-safety

- A captured video flows through `clipSocialPost` exactly like a right-click YouTube save: `background.js` sets the image to the deterministic `https://i.ytimg.com/vi/<id>/hqdefault.jpg` (derived from the `/watch` permalink) — **no broken-image risk**, no scraped tile needed.
- Delivery is `POST /api/captures` (with the extension's existing offline-queue + retry); the app drains and routes via `web/route-capture.js`, where a clip **always** goes to the Saved library and **never** modifies an Imported card.
- **Dedup:** adding the same video to multiple playlists fires multiple add events, but (i) the engine debounces (`lastClipTs`, 2.5 s) and (ii) `clipKey` folds the YouTube video id (from the v4.36 capture-routing work), so the same video collapses to **one** Saved card.

## Edge cases

- **Opening the dialog without ticking** → no capture (only a toggle-on fires).
- **Un-ticking a playlist (remove)** → no capture (gated on `aria-checked="false"` at click time).
- **"+ New playlist"** (create + add) → counts as a playlist add → captures (acceptable; it is a deliberate save).
- **Pending video gone stale** (>60 s since the ⋮ was opened, e.g. the dialog left open a long time) → skip rather than risk attributing to the wrong video.
- **Extension reloaded / stale tab** → the engine already bails quietly (`chrome.runtime.id` check); the user refreshes the tab to re-enable.
- **Thumbs-up Like** → not matched by `saveTrigger` (no capture), by decision 3.

## Testing

The capture configs are in-page DOM logic; like the existing FB/IG/Pinterest mirrors, the wiring is verified by **manual smoke on real YouTube**, not headless unit tests. To maximize what *is* testable:

- Factor the toggle-direction decision into a **pure helper** that takes primitives (e.g. `ytShouldFireAdd({ inPlaylistDialog, ariaChecked, isWatchLaterMenuItem, isSavePlaylistOpener })` → boolean) so the add-vs-remove / dialog-opener-vs-add logic is unit-tested without a DOM. (Video-id/permalink cleaning already lives in the config's `findPermalink` URL parsing and `background.js`'s `ytVideoId`; no new id helper is needed.)
- `node --check extension/capture-configs.js` and `node --check extension/background.js` must pass (the PostToolUse hook enforces this on edit); `node tests/run.js` must stay **ALL TEST FILES PASSED** (the build's existing gate is unaffected — no app files change).
- **Manual smoke checklist:** (1) on a watch page, Save → tick a custom playlist → a Saved card appears with the right title + thumbnail + `/watch?v=` URL; (2) in the home feed, a thumbnail's ⋮ → "Save to playlist" → tick a playlist → that video (not a neighbor) is saved; (3) ⋮ → "Save to Watch later" → saved; (4) un-ticking a playlist saves nothing; (5) adding one video to two playlists yields one card; (6) the Like button saves nothing.

## Files

- **Modify** `extension/capture-configs.js` — the `youtube` config: real `saveTrigger`, `init` pending-video tracker (⋮-owner + state), `findPost` override for dialog-originated triggers; a small pure `ytShouldFireAdd(...)` helper.
- **Modify** `extension/manifest.json` — version bump `4.36` → `4.37`.
- (No change to `background.js` — it already derives the `i.ytimg` thumbnail for youtube clips. No change to any app file.)

## Global constraints (carry verbatim into the plan)

- Repo stays **private**; **never create/edit/`git add` personal-data files** (PreToolUse-guarded).
- A Save **always** routes to the **Saved library** and **never** modifies an Imported card.
- **Extension-only** — after shipping, reload the extension (`chrome://extensions → ↻`) and refresh open YouTube tabs (content scripts inject on load); no app reinstall.
- Best-effort against YouTube DOM changes/ToS (YouTube's markup is finicky; selectors are resilient-but-not-guaranteed, consistent with the other mirrors).
- The engine file `capture-core.js` is **not** modified — adding a platform = editing its config only.

## Future slices (queued, not part of this spec)

- Explicit "Save to Interests" injected into the FB/IG/Pinterest post ⋯ menu (the most fragile/high-upkeep piece).
- Verify/harden the existing FB/Instagram/Pinterest native-Save mirrors (esp. Instagram).
- (Other v2 backlog: Instagram import, scheduled extraction.)
