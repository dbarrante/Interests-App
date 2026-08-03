# Skip redundant auto-backups across synced devices — design

## Problem

`S.autoBackup` (the "back up every N days" setting) gates on a **local,
per-device** timestamp (`ia_lastbackup`, in that device's own SQLite kv
table). It never looks at the actual Dropbox backups folder, which is the
one thing genuinely shared across every device running this app. A fresh
install's `ia_lastbackup` starts at `0`, so the very first launch on any
new/second/third device unconditionally runs a full backup — restaging and
re-hashing every image, retrying Dropbox file locks — even when another
device already produced (and Dropbox already synced down) a perfectly
current dated backup.

This is NOT a data-safety bug (backups are date-folder-named, so nothing
gets overwritten or lost) — it's wasted, redundant work on every device,
every auto-backup cycle.

The codebase already has a working example of the right check:
`ensureBackupBeforeMerge()` (`core/backup.js:978-1003`, driven by the
Dropbox-sync timer) reads the real shared folder via
`newestDatedSnapshotTime()` before deciding to write a new dated snapshot.
This fix reuses that exact primitive for the `autoBackup` path too — it
does not touch `ensureBackupBeforeMerge`, `core/sync.js`, or anything
currently working.

## Scope

Desktop Electron only. `pwa/storage-pwa.js`'s `backupNow` is already a
no-op stub on iPad/PWA builds ("Dropbox sync is the backup" — no local
Core service, no `autoBackup` scheduler reachable), so this fix is inert
there by construction; the mirrored `web/index.html`→`pwa/index.html`
functions still get identical edits per this project's convention, they
just never reach the changed code path on that build.

## Design

**One new optional parameter, `freshWithinMs`, on the existing
`POST /api/backup` endpoint** (`core/server.js:665-707`). When present,
non-zero, and the request is NOT a `safety` backup, the handler checks the
shared folder's freshness BEFORE calling `runner.runBackup(...)`:

```js
app.post("/api/backup", async (req, res) => {
  try {
    const safety = !!(req.body && req.body.safety);
    let keep = Number(req.body && req.body.keep);
    if (!Number.isFinite(keep) || keep < 1) keep = 3;
    keep = Math.min(Math.floor(keep), 30);
    const freshWithinMs = Number(req.body && req.body.freshWithinMs);
    if (!safety && Number.isFinite(freshWithinMs) && freshWithinMs > 0) {
      const newest = backup.newestDatedSnapshotTime();
      if (newest && (Date.now() - newest) < freshWithinMs) {
        return res.json({ ok: true, skipped: true, reason: "already-fresh", verified: true });
      }
    }
    const runner = ...   // unchanged from here down
```

`safety` backups (the hard pre-destructive-action gate used by
`verifiedSafetyBackup()`/duplicate-cleanup/restore) are explicitly
excluded from this check — an explicit safety gate must always actually
run, never be skipped based on freshness. Every other existing caller of
`POST /api/backup` (the manual "Back up now" button, the durability
banner's button, the legacy-import safety snapshot, Ctrl+Shift+B) never
sends `freshWithinMs`, so `Number.isFinite(freshWithinMs)` is false and
their behavior is completely unchanged — this is a strictly additive,
opt-in check.

`newestDatedSnapshotTime()` is already exported from `core/backup.js` and
already only counts a dated folder once its `meta.json` completion marker
parses successfully with non-zero counts (`core/backup.js:711-741`) — the
exact same trust bar `ensureBackupBeforeMerge` already relies on without a
full re-verify. The skip response reports `verified: true` on that same
basis, not as a new, looser standard.

**Client side** (`web/index.html`/`pwa/index.html`):

`doBackup(manual, opts)` gains a second, optional parameter that's merged
into the request body:

```js
async function doBackup(manual, opts){
  try{
    const res = await Store.backupNow(Object.assign({keep: S.backupRetainCount||3}, opts||{}));
    ...   // unchanged from here down — a skip response's {ok:true, verified:true}
          // already flows through the existing counts/verified/toast logic
          // with no special-casing needed
```

`maybeAutoBackup()` passes the interval through as the new opt-in param,
using the user's own chosen day-count (not the sync path's unrelated
hardcoded 7 days):

```js
async function maybeAutoBackup(){
  if(!_booted) return;
  const days = +S.autoBackup; if(!days) return;
  let last = 0; try{ last = (+(await Store.kvGet("ia_lastbackup")) || 0); }catch(e){}
  if(Date.now() - last < days*86400000) return;
  await doBackup(false, {freshWithinMs: days*86400000});
}
```

No other call site of `doBackup`/`Store.backupNow` passes `opts`, so this
is a no-op change for the manual button, the durability banner, and the
safety-backup paths — `web/index.html:1441` (manual), `:1469`
(`verifiedSafetyBackup`), `:5788`, `:7824` all keep calling with their
existing single argument (or their existing `{keep}`/`{safety:true}`
object), unaffected.

**Net effect:** the first device (of however many are running/launching
around the same time) to actually find the shared folder stale does the
real work and writes the dated backup. Every other device's own
`maybeAutoBackup()` call gets `{skipped:true}` back near-instantly, stamps
its own local `ia_lastbackup` so it doesn't re-check again this cycle, and
does zero image-hashing/Dropbox-lock work.

## Known limitation (accepted, not fixed)

If two devices launch within the same Dropbox sync-lag window (rare —
seconds to low minutes in practice), both could still see a stale shared
folder and both run a real backup once, racing to write the same dated
folder name. This causes no data loss (`runBackup`'s stage→verify→rename
publish is already race-safe against a folder name collision — whichever
publishes last simply becomes that day's snapshot) and is not made worse
by this change; it merely isn't fully eliminated by it. Building actual
cross-device locking for this narrow window is out of scope — agreed with
the user during design.

## Testing

- `tests/backup.test.js` (or a focused addition there) mounts
  `createServer()` per this project's existing HTTP-test convention and
  exercises `POST /api/backup`:
  - `freshWithinMs` absent/`0`/non-numeric → behaves exactly as today
    (regression guard: existing tests in this file must still pass
    unmodified).
  - A dated backup folder with a valid `meta.json` newer than
    `Date.now() - freshWithinMs` → responds `{ok:true, skipped:true,
    reason:"already-fresh", verified:true}` and does NOT create a new
    dated backup folder or call the underlying `runBackup` path (assert
    via a spy/counter, not just the response shape).
  - The same setup but with `safety:true` also set → the safety backup
    still runs regardless of freshness (never skipped).
  - No dated backup folder, or one older than the interval → runs a real
    backup exactly as today.
- A `web/index.html`/`pwa/index.html` test (via this project's
  `tests/_extract.js` `extractFn()` + sandbox pattern) verifying
  `maybeAutoBackup()` calls `doBackup` with `{freshWithinMs: days*864e5}`
  once its local staleness check passes, and that `doBackup(manual, opts)`
  merges `opts` into the `Store.backupNow` call without disturbing the
  `keep` default.
- Byte-identity check between `web/index.html` and `pwa/index.html` for
  every touched function, per this project's standing convention.

## Review

This touches backup-triggering logic — per this project's own
conventions, the implementation must go through the **data-safety-reviewer**
agent before merge, in addition to the normal task/final review.
