# Duplicate-review safety-snapshot throttle — design

## Problem

`applyDupeRemoval()` (the Duplicates-review "Apply choices" action, `web/index.html`)
calls `createDupeSafetySnapshot()` before every single removal. On desktop this
means a full `Store.backupNow({safety:true})` — a complete backup+verify of the
whole library (~600MB / ~6,000 images for a large library) — on *every* card,
even when reviewing many duplicate groups back-to-back in one sitting.

This was the root cause behind two related problems fixed/found 2026-07-24:
- Each removal takes 25-47 seconds even when nothing goes wrong.
- Doing this repeatedly in quick succession is what actually triggered the
  Dropbox publish-lock bug fixed earlier the same day (commit `f4098d6`) — more
  full-library writes in a short window means more chances to collide with
  Dropbox's own sync of the just-written batch.

`snapshotBeforeDestructive()` (a different destructive-action safety net,
covering saves/likes/hide actions) already solved the identical shape of
problem with a 5-minute throttle, added earlier this session. This design
applies the same fix to the duplicate-review path specifically.

## Scope

**Desktop only** (the `!window.IA_IDB` branch of `createDupeSafetySnapshot`).
The PWA branch already takes a cheap, per-group-scoped IndexedDB snapshot
(only the image ids referenced by the groups actually being processed in that
call) rather than a full-library backup — it doesn't have the expensive-backup
problem this fixes, and reusing it across a session would require it to
become a full-library snapshot too (a group processed later in the session
could reference images the first snapshot never captured), which is a
different, larger change. Left untouched.

## Design

A module-level cache alongside `_dupeGroups` etc. in `web/index.html`:

```js
let _dupeSafetyCache = { at: 0, safety: null };
const DUPE_SAFETY_REUSE_MS = 5*60*1000;
```

In `applyDupeRemoval()`, replace the unconditional
`const safety = await createDupeSafetySnapshot();` with: if
`_dupeSafetyCache.safety` is set and `Date.now() - _dupeSafetyCache.at <
DUPE_SAFETY_REUSE_MS`, reuse `_dupeSafetyCache.safety` directly (desktop path
only — `window.IA_IDB` still always takes its own scoped snapshot, matching
today's behavior). Otherwise call the real `createDupeSafetySnapshot()`; on a
confirmed non-null (verified) result, stamp `_dupeSafetyCache = {at:
Date.now(), safety}` — matching `snapshotBeforeDestructive`'s existing rule of
only arming the throttle on a confirmed verified success, never on a failed
or unverified attempt (so a failure doesn't block the next attempt).

**Trust model:** a reused snapshot is trusted without re-verification within
the window — re-verifying (`verifyBackup`'s full per-image re-hash) would
reintroduce the same expensive, lock-prone operation this change exists to
avoid. This mirrors `snapshotBeforeDestructive`, which also trusts a
recently-confirmed success rather than re-checking on every call.

**No new invalidation hooks.** The cache expires purely by elapsed time, same
as `snapshotBeforeDestructive` — no explicit clear on modal-close, tab-switch,
etc. A stale-but-still-within-window cached snapshot is exactly the intended
behavior (it's still a valid rollback point for anything removed since it was
taken); the window is short enough (5 min) that this doesn't meaningfully
weaken the safety net in practice.

**Effect:** the first removal in a review burst still pays the full cost
(unchanged); every removal within 5 minutes after a *confirmed verified*
snapshot skips straight to the actual card removal. `rotateNamedSnapshots`
(keep the newest 2 verified safety snapshots) is unaffected — it just fires
less often, since fewer safety snapshots get created overall.

## Testing

- Structural/behavioral test in the existing `web/index.html`/`pwa/index.html`
  test conventions (regex-based wiring check, matching this project's
  established pattern for inline-script functions) confirming: the cache
  exists, `applyDupeRemoval` checks it before calling
  `createDupeSafetySnapshot`, and the cache is only armed on a truthy
  (verified) result — not on `null`.
- If a call site can be cleanly extracted (per this codebase's `extractFn`
  utility, already extended this session to handle `async function`), a
  behavioral test exercising the reuse-vs-fresh-snapshot branching with
  mocked `Date.now()`/`createDupeSafetySnapshot` is preferred over a
  structural-only check.
