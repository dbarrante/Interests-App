# Consolidate "Check dead links" + "Check link safety" into one "Check links" button

**Date:** 2026-06-30
**Status:** Design approved (Dave); ready for implementation
**Author:** Dave + Claude

## Problem

The toolbar has two adjacent buttons — **"🔗 Check dead links"** and **"🛡️ Check link safety"** — but
`checkDeadLinks()` already runs the *full* pipeline in one process: HTTP dead check → page-content read
→ AI soft-dead confirm (spend-consent) → Google Safe Browsing safety pass (when a key is set) → one
merged "Dead & unsafe links" review. The standalone "Check link safety" button (`checkLinkSafety()`) is
therefore a redundant subset. Dave wants **one button** that does everything.

## Goal

Collapse the two buttons into a single **"🔗 Check links"** button that runs the existing combined sweep
(dead + AI soft-dead + safety) and shows the one merged review. No engine/behavior change — UI cleanup
plus deleting the now-orphaned safety-only code.

## Design

UI-only change in `web/index.html`. The combined engine (`checkDeadLinks`) is unchanged.

### Keep (used by the combined sweep)
- `checkDeadLinks()` — the combined pipeline (already runs `runSafetyPass` at the end when a key is set).
- `runSafetyPass(cands, opts)` — shared safety pass.
- `_sbFresh(it)`, `_threatLabel(t)`, `SB_FRESH_DAYS` — used by `checkDeadLinks`/`deadRowHTML`.
- The Safe Browsing key field in Settings and all Core endpoints — unchanged.
- The `#deadModal` review (`openDeadReview`/`deadRowHTML`/`applyDeadRemoval`) — unchanged; already shows
  dead + AI + unsafe rows merged.

### Change
1. **Rename** the remaining button: `🔗 Check dead links` → **`🔗 Check links`**, tooltip updated to
   "Check Imported + Saved links for dead pages AND unsafe sites (Safe Browsing), then review before removing".
2. **Remove** the `🛡️ Check link safety` button (the `onclick="checkLinkSafety()"` button).
3. **Delete the orphaned safety-only code** (verified to have no other callers):
   - `let _sbStop = false, _safetyList = [];`
   - `checkLinkSafety()`, `safetyRowHTML()`, `renderSafetyModal()`, `openSafetyReview()`,
     `closeSafetyReview()`, `applySafetyRemoval()` (the contiguous block).
   - The `<div id="safetyModal">…</div>` markup, and the `#safetyModal`/`#safetyModal.open` tokens in the
     shared modal CSS (leaving `#dupeModal,#deadModal,#failModal` intact).

### No-key behavior (unchanged)
With no Safe Browsing key, "Check links" still runs dead + AI and shows a one-time toast hint to add a key
for safety. (This is the existing `checkDeadLinks` else-branch.)

## Error handling / limits
No new logic. Stop control (`_deadStop`), chunking, AI spend-consent, and the backup-first
`applyDeadRemoval` removal path are all unchanged.

## Testing
- Extend `tests/capture-wiring.test.js` (or the dead-link wiring test) with text-asserts:
  - exactly one links-check button remains: a `Check links` button exists, and there is **no**
    `checkLinkSafety(` reference and no `Check link safety` label left.
  - the combined sweep is intact: `checkDeadLinks` still references `runSafetyPass(`.
  - the orphaned functions are gone: no `function applySafetyRemoval(` / `renderSafetyModal(` /
    `openSafetyReview(` remain.
- `node tests/syntax-check.js` (HTML inline-script parse) + full `node tests/run.js` stay green.

## Data-safety / security
App-only. No data-store schema, Core endpoint, or *new* delete path is added — this **removes** a dead
delete-path function (`applySafetyRemoval`, which had no caller after the button is gone); the live removal
path (`applyDeadRemoval`) is untouched and remains backup-first. No new data-loss surface, so the heavy
data-safety/electron-security subagent reviews are not warranted (self-verified).

## Out of scope
- Any change to detection logic, tiers, thresholds, or the merged review modal.
- The Safe Browsing key acquisition flow / Settings field.
