# Recapture: heal the failed card on the next clip

**Date:** 2026-06-29
**Status:** Approved (design); ready for implementation plan
**Author:** Dave + Claude

## Problem

v1.5.3 added: click a failed card's title → opens the page, clears the image, marks it
"Recapturing…"; the user then clicks the extension's **Clip** to recapture. But the recapture half
never works — the row stays stuck on "Recapturing…". Root cause (confirmed by a 4-boundary trace):
the extension popup's **"Clip this page"** is a generic page clip flagged `clip:true`, and the app's
router (`web/route-capture.js:19`) sends *any* `clip:true` capture straight to the **Saved library**
**before** any imported-card matching. So the clip mints a new Saved entry and the failed imported
card is never touched; its image stays empty, so `_failRowStatus` never returns "success".

The **Remove** path is unaffected (it sends a non-clip `dead`/`removeActive` capture → routes to
removal) and works.

## Approach (chosen: app-only)

When the user clicks a failed card's title, **arm a one-shot, time-windowed "recapture target"** =
that card. A `clip` that arrives while the target is armed is routed to **heal that card**
(`card-image`) instead of `saved`. No extension change.

Crucially, the target is the **explicit card the user clicked** — so healing does **not** depend on
the clip's URL matching the card's stored URL. This is robust against URL drift (redirects, tracking
params, sites like fatpita.net that serve a random `?i=` URL per load).

## Mechanism

1. **Arm (renderer, `openFailOne` in `web/index.html`):** in addition to its current behavior
   (backup-first image clear, `ia_last_opened`, `_failStatus[id]="recapturing"`, open), set a
   module-level `_recapTarget = { id: c.id, ts: Date.now() }`.
2. **Route (pure, `web/route-capture.js`):** add `ctx.recapTarget`. Insert a branch **after** the
   `dead` check and **before** the `cap.clip → saved` line: if `cap.clip` and `recapTarget` is set,
   recent (`now - recapTarget.ts < RECAP_WINDOW`, `RECAP_WINDOW = 15*60*1000`), and the target card is
   still present in `imported`, return `{ action: "card-image", target: <that card>,
   reason: "recapture target (healing failed card)" }`. Otherwise fall through to the existing
   `cap.clip → saved`. (A `dead` capture during recapture still removes — Remove keeps working.)
3. **Apply + disarm (renderer, `drainCaptures` in `web/index.html`):** pass `recapTarget: _recapTarget`
   into the `routeCapture(cap, ctx)` call. The existing `card-image` apply-path then sets the card's
   image, `lastResult="ok"`, clears `capReason`, persists, and re-renders. When a capture is
   successfully applied to the recap-target card (image actually set), **clear `_recapTarget = null`**
   (one-shot). The v1.5.3 `refreshFailStatuses()` (already called at the end of `drainCaptures`) flips
   the row to ✅ Success with no further change.

## Decisions / edge cases

- **One-shot + 15-minute window** bound the wrong-card risk: arming happens on the explicit title
  click; the first clip that lands a picture on the card consumes the target; a stale target expires.
- **No duplicate Saved entry:** when healing, the clip routes to `card-image` only, never also to
  `saved`.
- **No-image / rejected clip:** if the applied capture has no usable image (e.g. a blocked page), the
  existing `drainCaptures` image-rejection keeps the card failed; the target is cleared **only on a
  successful image apply**, so a follow-up clip can retry.
- **Wrong-page clip (accepted trade-off):** if the user arms a target then clips a *different* page
  within the window, that page's picture heals the failed card. Mitigated by one-shot + window; the
  normal flow (click → page opens → clip that page) is correct.
- **Target card removed/already fixed:** `routeCapture` only heals if the target id is still in
  `imported`; otherwise the clip falls through to `saved` as before.

## Components

- `web/route-capture.js`: new `recapTarget` branch (clip + armed target → `card-image`).
- `web/index.html`: declare `_recapTarget`; set it in `openFailOne`; pass it to `routeCapture` in
  `drainCaptures`; clear it on a successful apply to the target card.
- `tests/route-capture.test.js`: extend.

## Testing

- `routeCapture`: a `clip` capture with a recent `recapTarget` whose id is in `imported` →
  `action:"card-image"` targeting that card; with NO `recapTarget` → `action:"saved"` (unchanged);
  with an EXPIRED `recapTarget` (ts older than the window) → `saved`; with a `recapTarget` whose id is
  NOT in `imported` → `saved`; a `dead` capture with a `recapTarget` still → `dead` (Remove
  unaffected). Use the project's existing `route-capture.test.js` style.
- Renderer wiring (text-assert in an existing wiring test): `openFailOne` sets `_recapTarget`;
  `drainCaptures` passes `recapTarget` to `routeCapture` and clears `_recapTarget` on apply.
- `tests/syntax-check.js` + full `node tests/run.js` green.

## Data-safety & security

- Renderer-only; no Core endpoint, no extension change. The heal path reuses the existing
  `card-image` apply (which is the same path batch/auto-capture already uses) — no new delete path,
  no new data file. The image clear on title-click remains backup-first (unchanged from v1.5.3).
- Run the **data-safety-reviewer** on the change (it affects how a capture mutates an imported card).

## Out of scope / deferred

- A dedicated "Recapture this card" button in the extension (the extension+app approach) — not chosen.
- Surfacing the true routing outcome in the extension popup (it reports success on HTTP delivery only)
  — a separate nicety, not needed for this fix.
- The Instagram login-wall content problem (separate; IG capture fix shipped as extension v4.39).
