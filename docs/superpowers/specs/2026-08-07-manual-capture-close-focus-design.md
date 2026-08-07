# Manual Picture Update: Close Tab + Focus App on Accept — Design

## Goal

When the user updates an existing card's image via the app-triggered manual
point-to-point capture flow (card-face icon → article opens → user drags a
selection box → "Use this"), and the capture is accepted:

1. The browser tab that was opened for the capture closes.
2. The Electron app window comes to the front.

Today, neither reliably happens on the common path (see below). This is a
narrow follow-up to the manual-capture feature shipped 2026-08-05/06, not a
redesign.

## Current behavior

`extension/background.js`'s `regionSelectFinalize` handler closes the tab
only when `session.owned` is `true`. `session.owned` is set by
`startManualCapture`: `true` only when the extension itself had to create
the tab (a rare fallback — e.g. the app's `openLink()` failed to produce a
tab it could find). In the normal case, `findAppOpenedTab` locates the tab
the app's own `openLink()` already opened, and `owned` stays `false` — so
the tab is left open in the common path. There is no "bring the app
forward" step anywhere in this flow today.

## Changes

### 1. Close the tab on accept (app-triggered flow only)

In `regionSelectFinalize`, change the close condition from `session.owned`
to `session.id` (truthy only for the app-triggered "update this card's
image" flow; empty string for the standalone extension context-menu
capture). The app opened this tab specifically for this capture attempt
either way (whether the extension found it or had to create it itself), so
there's no reason to leave it open once the user accepts. The standalone
capture-any-page flow (`session.id === ""`) is untouched — it still never
closes the user's own browsing tab, per its existing documented guarantee.

### 2. Bring the app to front on accept (app-triggered flow only)

New extension→app HTTP signal, following the existing pattern already used
throughout `background.js` (`deliverToApp` posting to
`http://127.0.0.1:<port>/api/...` via `findAppPort()`):

- **`core/server.js`**: new `POST /api/focus-app` endpoint. Calls
  `ctx.focusApp()` if present (optional-capability pattern, same as
  `ctx.storeWorker` — `core/server.js` stays Electron-agnostic and never
  requires `electron` directly). Responds `{ ok: true }` always (best-effort
  — a missing `ctx.focusApp` is a silent no-op, not an error, since older
  app builds or non-Electron test contexts won't have it wired).
- **`main.js`**: sets `ctx.focusApp = () => { ... }` once `mainWindow`
  exists, reusing the exact restore/show/focus sequence the
  `second-instance` handler already uses (`isMinimized() → restore()`, then
  `show()`, then `focus()`).
- **`extension/background.js`**: in `regionSelectFinalize`, after a
  successful `deliverToApp(capture)` and only when `session.id` is truthy,
  fetch the app port (`findAppPort()`) and `POST /api/focus-app`,
  fire-and-forget (mirrors how `setStatus` calls elsewhere in this file are
  best-effort and swallow errors — losing focus is a minor UX miss, never
  worth failing the capture over).

### Scope boundaries

- Fires only on **accept** (`regionSelectFinalize`), never on cancel/Escape
  (`regionSelectCancel` is untouched).
- Fires only for the **app-triggered** recapture flow (`session.id`
  truthy). The standalone "capture any page into a new Saved item" flow
  (context menu, no card) keeps its current behavior exactly — tab stays
  open, app is not brought forward. (If this turns out to be wanted later,
  it's a one-line follow-up: drop the `session.id` guard on the focus
  call only.)
- If `/api/focus-app` fails (app closed, port not found, network error),
  the failure is swallowed — the capture itself already succeeded and was
  delivered; a focus miss is cosmetic.

## Testing

Structural/source-assertion tests, matching this file's existing style
(`tests/manual-capture-wiring.test.js`):

- `regionSelectFinalize` closes the tab when `session.id` is truthy,
  regardless of `session.owned` (replaces the existing
  `session.owned`-gated assertion, which documented the now-superseded
  behavior).
- `regionSelectFinalize` does NOT close the tab for a standalone session
  (`session.id === ""`) — unchanged guarantee, re-asserted against the new
  condition.
- `regionSelectFinalize` calls the focus-app endpoint only when
  `session.id` is truthy.
- `core/server.js`: `POST /api/focus-app` calls `ctx.focusApp()` when
  present, and responds `ok:true` without throwing when it's absent.
- `main.js`: source-assertion that `ctx.focusApp` is wired to the same
  restore/show/focus sequence as the `second-instance` handler (structural
  check, consistent with how this file's other main.js wiring is tested —
  no live Electron window in the unit test run).
