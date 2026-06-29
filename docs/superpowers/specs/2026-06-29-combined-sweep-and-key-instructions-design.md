# Combined dead+safety sweep & Safe Browsing key instructions

**Date:** 2026-06-29
**Status:** Approved (design); ready for implementation plan
**Author:** Dave + Claude

## Problem

Two follow-ups to the link-safety feature (v1.3.0):

1. **Getting a Google Safe Browsing API key is non-obvious.** The Settings field only links to Google's docs; the user wants the actual step-by-step in the app.
2. **The dead-link and safety checks are two separate sweeps.** The user wants the Safe Browsing check to run **as part of the dead-link sweep** (one pass, merged review) **and** still be available on its own.

## Solution overview

- **Combined sweep:** `checkLinkSafety`'s safety logic is extracted into a shared helper and *also* invoked by `checkDeadLinks`. Dead and unsafe links land in the **same** (existing dead-link) review modal, tagged. The standalone 🛡️ button keeps doing safety-only.
- **Settings instructions:** a collapsible "How to get a free key" with the real Google Cloud steps.
- No new endpoints, Core, or data-store changes — reuses `/api/check-safety` and the existing backup-first `applyDeadRemoval`.

## Behavior

### Combined sweep (`checkDeadLinks`)

After its existing tiers (HTTP dead-check → content heuristics → AI soft-dead) build the `dead` list, the sweep runs a **safety pass** over the sweep's candidate links and pushes any Safe-Browsing-flagged links into the **same review list**, tagged unsafe.

- **Scope:** the safety pass checks **all** http(s) links in the sweep's candidate set, **including social** (Instagram/Facebook/YouTube/etc.). Safe Browsing is a blocklist *lookup* (no page fetch), so the login-wall reason for skipping social in the dead-link *probe* does not apply here. (The dead-link probe still skips social as before.)
- **No key set:** the sweep still runs dead-link detection normally and shows a **one-time** toast ("Add a Google Safe Browsing key in Settings to also check link safety"). Never blocks, never errors.
- **Stoppable:** the safety pass honors the existing `_deadStop` flag.
- **No spend prompt:** Safe Browsing is free with a generous quota, so (unlike the AI soft-dead tier) the safety pass needs no consent dialog.
- Each checked card gets the additive `sb = {at, verdict, threat}` marker (same as the standalone sweep), so re-runs skip recently-checked links.

### Standalone safety (`checkLinkSafety`)

Unchanged in behavior — it calls the same shared helper and shows its own `#safetyModal`. (Kept per the user's request to still run safety on its own.)

### Merged review modal

The existing dead-link modal (`#deadModal` / `renderDeadModal` / `deadRowHTML`) renders a third row variant:

- **dead** (HTTP): reason e.g. "404 not found" (existing).
- **soft-dead** (AI): "AI: <reason>" + "archived copy" link (existing).
- **unsafe** (Safe Browsing, NEW): red **⚠ <threat label>** (Malware / Phishing / Unwanted software / Harmful app). No "archived copy" link for unsafe rows (don't encourage opening a malicious archived page).

Review/removal is unchanged: `applyDeadRemoval` (snapshot-first, review-gated, remove by `scope:id`) handles all row types — unsafe entries are `{scope, card}` like the rest.

### Settings — key instructions

Replace the one-line hint under the "Google Safe Browsing API key" field with a collapsible **"How do I get a free key?"** containing:

1. Open the Google Cloud Console (console.cloud.google.com).
2. Create a new project (or pick an existing one).
3. APIs & Services → Library → search **Safe Browsing API** → **Enable**.
4. APIs & Services → Credentials → **Create credentials → API key**.
5. Copy the key and paste it above.

Plain language (the user is not a developer). The field stays a password input; the key is still stored only in `config.json` and never rendered back.

## Components

- **`web/index.html`:**
  - NEW shared helper `runSafetyPass(cands, opts)` — given candidate `{scope, card}` entries (with http(s) urls), batches their urls to `Store.checkSafety` (chunks of 200, honoring a stop flag), stamps each card's `sb` marker, and returns the unsafe entries (`{scope, card, unsafe:true, threat}`). Used by both sweeps.
  - `checkLinkSafety` refactored to use `runSafetyPass` (behavior preserved).
  - `checkDeadLinks` calls `runSafetyPass` after its dead tiers (only if a key is set), merges the unsafe entries into the `dead` list, then `openDeadReview`.
  - `deadRowHTML` extended: an `c.unsafe` row shows the red threat label (via `_threatLabel`) and no wayback link.
  - Settings: collapsible instructions block.
- No changes to `core/*`, `web/storage.js`, or any endpoint.

## Data-safety & security

- **Read-only detection;** unsafe links only join the review modal; removal stays in the unchanged snapshot-first `applyDeadRemoval`. The `sb` marker is additive.
- **Key handling unchanged:** still in `config.json`, never echoed/rendered. No new key surface.
- **Bounded & stoppable:** safety pass chunks + honors `_deadStop`; Safe Browsing quota is ample.
- **Fail-open** is inherited from `safebrowse.checkUrls` (API error → no flag, never a false "unsafe").

## Testing (TDD)

- Extend `tests/safety-wiring.test.js` (or add a small wiring test): assert `checkDeadLinks` references `runSafetyPass`/`Store.checkSafety`; `deadRowHTML` handles `c.unsafe`; Settings contains the instruction steps (e.g. "Safe Browsing API" + "Create credentials").
- `web/index.html` inline JS stays syntax-gated (`tests/syntax-check.js`).
- Full gate (`node tests/run.js`) green.
- Then run **data-safety-reviewer** (touches the review/removal flow); rebuild installer (bump to 1.3.1). electron-security not required (no new endpoint/network/IPC/key surface).

## Out of scope / deferred

- Phase 2 open-time block-with-override warning (separate spec, still next).
- Merging `#safetyModal` and `#deadModal` into a single unified modal (kept separate; the standalone button keeps its own modal to avoid a larger refactor — YAGNI).
- The pre-existing Minor: POST `/api/safebrowsing-key` reports `hasKey` from raw input (no security impact) — not addressed here.
