# Capture-failure troubleshooting + Settings/capture polish

**Date:** 2026-06-29
**Status:** Approved (design); ready for implementation plan
**Author:** Dave + Claude

## Problem

After the Electron-native "Capture missing" (v1.4.1), cards still fail to get a picture for
**different reasons**, but they all land in one "failed" bucket and "Retry all" blindly re-runs
them — so dead/social/no-image cards fail forever. The user wants a real strategy to **diagnose and
resolve** failed cards, plus three smaller polish items.

## Scope (5 parts, one plan)

A. Record **why** each capture failed.
B. **Triage** view (enhance "View failures") grouped by reason, with the right fix per group.
C. **"Capture all"** — uncap the loop for both never-tried and failed.
D. **Consolidate** the two interests sections into one.
E. Safe Browsing key: cosmetic **asterisks** + **live "Active" status**.

---

## A. Failure reasons (Core)

`core/capturemeta.js captureMetaChunk` returns a `reason` per item when no image is produced; the
`/api/capture-meta` endpoint passes it through (alongside `hasImage`). Reasons:

- **`social`** — `linkcheck.isSkippedHost` (FB/IG/Pinterest/YouTube-walled/Threads): skipped, the
  Core can't see logged-in pages.
- **`unreachable`** — page didn't load (fetch failed / empty body / non-probable/SSRF host). Treated
  as likely-dead. (Also covers a private/blocked host — rare for a real card.)
- **`no-image`** — page loaded (non-empty HTML) but no `og:image`/fallback found.
- **`image-failed`** — an image URL was found but the download failed (not `image/*`, too big, error).

Renderer stores `c.capReason` when a card comes back `hasImage:false`, alongside `lastResult="fail"`.
(`hasImage:true` clears any prior `capReason` and sets `lastResult="ok"`.)

## B. Triage view (enhances the existing "View failures")

The **🔄 N failed ▾** menu's **View failures** opens a triage that groups failed cards by
`capReason`, each group with a count + the right action(s):

- **Transient / image-failed → Retry (fresh).**
- **No preview image → Mark done** (accept: set `lastResult` to a non-fail value so they leave the
  failed bucket and stop nagging) **or Retry (fresh)** if you think it was a fluke.
- **Unreachable (likely dead) → Remove** (backup-first, reviewable — uncheck any to keep) **or
  Retry (fresh)** for the transient case. Not auto-removed.
- **Social → "Open & Save from your browser"** — flagged as needing the extension; offers the
  existing **Capture selected** (extension) path for the selected social cards.

**Retry (fresh)** = the user's key requirement: **delete the card's existing (bad/placeholder)
picture first** (`Store.imgDel(id)` + clear `c.img`), then re-run the Core capture so it gets a
clean new image — never reuses a stale/broken thumbnail. This (and Remove) go through the existing
**`snapshotBeforeDestructive()`** backup-first path. Image clears are additive-safe (the card
stays; the picture is re-fetched).

## C. "Capture all" — uncap both loops

The capture loop is already chunked (25) + stoppable (`_capStop`), so the 100 cap is vestigial.
Make **Capture missing (N)** (never-tried) and **Retry all (N)** (failed) process **every** matching
card (drop the `BATCH_CAP` slice), still in stoppable chunks of 25. Labels become true "all".
Honors the "nothing unbounded / always stoppable" rule (it IS stoppable; the user initiates it).

## D. Consolidate interests sections

Merge "Your interest profile" (About you + interests list + 🧠 Analyze my library) and "Discover new
interests" (musing → chips) into one **"Your interests"** section, both tools together. DOM reflow
only — no behavior change to `analyzeLibrary`/`discoverInterests`/`acceptProfile`/`addDiscovered`.

## E. Safe Browsing key — asterisks + live status

- **Cosmetic asterisks:** on Settings load, if a key is set, prefill `#sbKey` with a fixed mask
  (e.g. 24 × "•") so the field visibly shows a key is present. The real key is **never** sent to the
  renderer. On Save: if the field value still equals the mask (unchanged) → do nothing; otherwise
  `Store.setSafeBrowsingKey(value)`.
- **Live status:** on Settings open and after Save, call a new `GET /api/safebrowsing-verify` — the
  Core does one benign-URL lookup with the stored key and returns `{ state: "active"|"invalid"|"none", }`:
  - no key → `none` → status "— not set";
  - Google 200 → `active` → "✅ Active";
  - Google 4xx (rejected key) → `invalid` → "⚠ Invalid key";
  - network error → leave the prior text (don't flip to invalid on a transient failure).
  New `safebrowse.verifyKey(apiKey) -> Promise<{ok, status}>` (one lookup of `https://example.com`;
  distinguishes 200 / 4xx / network-error). The key value is never returned or logged.

## Components

- `core/capturemeta.js`: `captureMetaChunk` adds `reason` to each result; NEW `verifyKey`.
- `core/server.js`: `/api/capture-meta` passes `reason` through; NEW `GET /api/safebrowsing-verify`.
- `web/storage.js`: `Store.captureMeta` already returns results (now incl. `reason`); NEW
  `Store.verifySafeBrowsing() -> Promise<{state}>`; `SE.safebrowsingVerify()`.
- `web/index.html`: capture result-application sets `c.capReason`; uncapped capture-all; the triage
  modal/view grouped by reason with the actions above (reuses `dupeThumb`/`esc`/the snapshot-first
  removal pattern); consolidate the interests sections; SB field mask + live status wiring.

## Data-safety & security

- **Non-destructive:** Retry clears only a card's *picture* (re-fetchable), backup-first; Remove uses
  the existing snapshot-first bulk-replace; "Mark done" only flips a status field. No data loss; only
  `Store.putCards`/`Store.imgDel`/`images.putImg` writes.
- **Bounded/stoppable:** capture-all is chunked + `_capStop`; verify is one bounded lookup.
- **SB key:** still Core-only — the mask is cosmetic; verify never returns/logs the key.
- Reviews: **data-safety** (Retry-clears-image + Remove paths), **electron-security** (the verify
  endpoint + that the key isn't leaked). Installer bump.

## Testing (TDD)

- `captureMetaChunk` reason: social → `social`; empty html → `unreachable`; html w/o og:image →
  `no-image`; og:image present but image fetch fails → `image-failed` (stubbed fetch + DNS).
- `verifyKey`: 200 → `{ok:true,status:"active"}`; 4xx → `invalid`; throw → network-error (stubbed fetch).
- `/api/safebrowsing-verify`: no key → `none`; with key + stub → `active`/`invalid`.
- Wiring tests (text-assert): triage references `c.capReason` + group actions; capture-all uncapped
  (no `BATCH_CAP` slice in the loop path); one consolidated interests section; SB mask + verify wired.
- `tests/syntax-check.js` + full gate green.

## Out of scope / deferred

- Screenshot-render fallback for `no-image` cards (the v1 capture is og:image only — YAGNI here).
- Re-probing unreachable cards with the full dead-link HTTP probe (the single capture attempt's
  result is used; the dedicated "Check dead links" sweep remains available separately).
- The "toggle off built-in viewer" item and the Notion connector — still queued, separate.
