# Failures modal — click-to-verify → recapture / remove, with live status

**Date:** 2026-06-29
**Status:** Approved (design); ready for implementation plan
**Author:** Dave + Claude

## Problem

In the failed-capture triage modal the user can now open a "may be dead" link, but there's no
closed loop: they want clicking a title to (a) open the page, (b) clear the card's bad image and let
them recapture it via the extension, and (c) see the outcome reflected on that card — **Success** if a
new image lands, **REMOVED** if they delete it from the extension. Today a card that gets fixed or
removed just silently disappears from the modal; the user can't tell what happened.

## What already exists (reused, not rebuilt)

- The extension popup has **"📎 Clip this page to Interests"** (recapture the open page) and
  **"Remove this card from Interests"** (sends a "dead" capture for the page's URL).
- `drainCaptures()` (web/index.html:4063) runs every 3s. It matches each incoming capture to an
  existing card by `normalizeUrl(url)`: a successful capture **replaces that card's image**; a "dead"
  capture (what Remove sends) **removes the matching card** — and for a `removeActive` capture with no
  URL match it falls back to the `ia_last_opened` card id.
- Opening a card elsewhere records `Store.kvSet("ia_last_opened", {id, ts})` (web/index.html:3093/3127).

So the recapture-into-card, remove-by-URL, the extension buttons, and the 3s ingest loop are all
already in place. This feature is **renderer-only** (`web/index.html`) — **no extension change, no Core
change.** It adds the click-time image clear and the live per-card status in the modal.

## Flow

1. **Click a title** in the failures modal (`openFailOne(id)`):
   - back up first, then **clear the card's image** (`Store.imgDel(id)` if `img` starts with `idb:`;
     set `c.img=""`) and persist;
   - record it as last-opened: `Store.kvSet("ia_last_opened", {id, ts:Date.now()})` so a subsequent
     extension Remove targets this card even if the URL match is imperfect;
   - set the card's session status to **`recapturing`**;
   - open the page in the browser via `openUrlsInTabs([c.url])` (browser tab, as today).
2. **On the opened page, the user clicks the extension:** Clip (recapture) or Remove. No app action.
3. **Back in the app**, the existing 3s `drainCaptures` ingests the result (new image on the card, or
   card removed). The failures modal **refreshes its rows in place** and updates the status:
   - the card's `imported` entry now has a good image (`!isBadImg(img)`) → **✅ Success**;
   - the card is no longer in `imported` → **🗑 REMOVED** (struck-through tombstone);
   - otherwise unchanged (still failed; shows **Recapturing…** if the user clicked it this session).

## Status model

- A modal-session map `_failStatus` (`{ [cardId]: "recapturing" | "success" | "removed" }`) holds the
  transient `recapturing` hint set on title-click. `success` / `removed` are **derived from actual
  state** at refresh time (image present / card gone) — not trusted from the map — so they're reliable.
- `_failModalList` (the snapshot of failed cards taken when the modal opened) is the row source. Because
  it holds the original card objects, a **removed** card can still be rendered as a REMOVED tombstone
  even after it's gone from `imported`.
- Resolved rows (`success` / `removed`) **stay visible** for the rest of the modal session so the user
  sees the outcome; they're absent next time the modal is opened (it re-snapshots from `needsRetry`).

## Components (all in `web/index.html`)

- `openFailOne(id)` — add: backup-first image clear, `ia_last_opened`, `_failStatus[id]="recapturing"`,
  persist, then open. (Keep using `openUrlsInTabs([c.url])`.)
- `failRowHTML(c)` — render a status slot (e.g. `<span class="fst">`) reflecting `_failStatus`/derived
  state, and on a resolved row disable the title's open click and the select checkbox.
- NEW `refreshFailStatuses()` — for each row currently in the open modal, recompute status from live
  state (`imported` lookup by id + `isBadImg`) and update that row's badge + disabled state **in place**
  (by `data-id`), preserving the user's checkbox selection and scroll position. No full re-render.
- Wire `refreshFailStatuses()` to run when the modal is open: piggyback the existing 3s `drainCaptures`
  tail and the visibility/focus-return path, so results appear without the user doing anything else.

## Error handling / data safety

- The click-time image clear is **backup-first** and clears only the (re-fetchable) image — never the
  card or other fields. If the user opens a title but never recaptures, the card simply stays failed
  (its prior state), with the image backed up.
- A clip whose URL doesn't match this card won't flip the row — it stays **Recapturing…** until the
  user acts or closes the modal. No false Success.
- Removal goes through the existing capture pipeline (`drainCaptures` → the same snapshot-backed card
  removal already in use); this feature does not add a new delete path.

## Testing (text-assert wiring + gate)

- `openFailOne` clears the image backup-first (`Store.imgDel` + `c.img=""`), sets `ia_last_opened`,
  marks `_failStatus[...]="recapturing"`, and still opens via `openUrlsInTabs`.
- `refreshFailStatuses` exists, derives `success` from a present image and `removed` from a card missing
  in `imported`, and updates rows by `data-id` without rebuilding the list; it is invoked from the
  drainCaptures/refresh path when the modal is open.
- `failRowHTML` renders the status states and disables interaction on resolved rows.
- `tests/syntax-check.js` + full `node tests/run.js` green.

## Out of scope / deferred

- Auto-triggering the extension from the app (chose user-mediated Clip — reliable, no extension change).
- Any extension or Core code change (the existing Clip/Remove + `drainCaptures` matching already do it).
- An in-modal "undo" for REMOVED (removal is already backup-first and undoable from the app as today).
