# Failures modal — open / verify links

**Date:** 2026-06-29
**Status:** Approved (design); ready for implementation plan
**Author:** Dave + Claude

## Problem

The failed-capture triage modal lists cards that "may be dead", but the user has no way to
actually check whether a link is dead from inside the modal. They want to **verify** a candidate
before deciding to Retry / Mark done / Remove — by clicking a single title to open it, or by
selecting several and opening them together.

## Scope

A. **Single-click a title** in the failures list → open that one link.
B. **New "Open" action** in the modal's pinned top bar → open all *checked* cards' links.
C. A small **DRY refactor**: share the open-in-tabs core between the existing main-grid
   `openSelected()` and the new failures-modal opener.

This is renderer-only (`web/index.html`). No data store, no Core endpoint, no delete-path change.

---

## A. Single-click a title → open one link in the browser

- In `failRowHTML(c)`, the title element (`.meta .t`) becomes a click target: `cursor:pointer`,
  subtle hover underline, and `onclick` → opens `c.url` **in the default browser** (a new tab).
- It **always opens in the browser**, NOT the in-app reused viewer — the reuse-window setting is not
  involved in this feature at all. Use the same browser path as bulk open (`window.open(url,"_blank")`,
  which the Electron window-open handler routes to `shell.openExternal` → the system browser), guarded
  to http(s) only. Reuse the shared helper: `openUrlsInTabs([c.url])`.
- Clicking the title **only opens** — it must NOT toggle the row's checkbox. The checkbox / "select"
  label remains the separate selection control; the thumbnail is non-interactive.
- Verification opens are **NOT** logged as interest "clicks" — never call `openItem` (which pushes to
  `clicks`). Checking dead links must not pollute the interest signal.

## B. "Open" button → open all selected links (browser tabs)

- Add an **"&#8599; Open"** button as the FIRST button in the modal's pinned action bar, so the bar
  reads: **Open · Retry (fresh) · Mark done · Remove**.
- New `openFailSelected()`:
  - gathers `_failCheckedIds()` → maps to the corresponding cards (from `_failModalList`/`imported`)
    → their `url`s;
  - if none checked → toast "Select some cards first." and return;
  - opens via the shared `openUrlsInTabs(urls)` helper (see C).
- Bulk open **always uses browser tabs**, never the reuse-window — opening many pages into one reused
  window is meaningless (last wins). Mirrors the existing main-grid `openSelected()`. (Single-click
  also opens in the browser, so the whole feature is browser-only — the reuse-window setting is never
  consulted here.)

## C. Shared open-in-tabs helper (DRY)

- Extract the open-in-tabs core currently inside `openSelected()` (web/index.html:2816) into
  `openUrlsInTabs(urls)`:
  - dedup repeat links by `normalizeUrl`;
  - filter to http(s) only (drop `javascript:`/`data:`/etc. that could come from an old import or
    restored backup — mirrors the existing import og-guard); count + report skipped in the toast;
  - if opening more than 25, `confirm(...)` first (same wording/threshold as today);
  - open synchronously within the user's click (so the browser treats them as one user gesture and
    is less likely to block the pop-ups);
  - returns the number opened (or the existing toast behavior on none).
- `openSelected()` keeps its main-grid-specific bits (the `_openedSel` per-Select-session dedup,
  the `selPicks` source) and calls `openUrlsInTabs` for the actual opening, so its current behavior
  is preserved exactly. `openFailSelected()` calls `openUrlsInTabs` directly (no session concept in
  the modal).

## Components

- `web/index.html`:
  - `failRowHTML` — title becomes a click target that opens `c.url` in the browser via
    `openUrlsInTabs([c.url])` (checkbox unaffected; reuse-window not consulted).
  - `renderFailModal` — add the "Open" button to the pinned action bar (first).
  - NEW `openFailSelected()`.
  - NEW `openUrlsInTabs(urls)` extracted from `openSelected()`; `openSelected()` refactored to use it.

## Error handling

- Non-web links are filtered out and reported in the toast; never passed to `window.open`.
- `openLink` already guards single opens to http(s); a non-web single title falls back to a no-op /
  `window.open` guard as today.
- Empty selection → toast, no-op.

## Testing (text-assert wiring + gate)

- `failRowHTML` title is a click target that opens via `openUrlsInTabs([` (browser), and
  `renderFailModal` renders an "Open" action calling `openFailSelected`.
- `openUrlsInTabs` exists and is called by BOTH `openSelected` and `openFailSelected`.
- `openFailSelected` reads `_failCheckedIds()` and opens via `openUrlsInTabs` (browser tabs).
- Neither the title click nor `openFailSelected` routes through the reuse-window / `openInApp` path.
- `tests/syntax-check.js` + full `node tests/run.js` green.

## Data-safety & security

- No store/backup/delete/endpoint change → the data-safety and electron-security domain reviewers are
  not required for this feature. The only security-relevant invariant — never hand a non-http(s) URL to
  `window.open` — is preserved (and centralized) in `openUrlsInTabs`.

## Out of scope / deferred

- Auto-probing / auto-marking dead links from the modal (the existing "Check dead links" sweep and the
  capture-reason triage already cover automated detection; this feature is manual verification only).
- A per-row "open" icon button (the title itself is the click target, per the request).
