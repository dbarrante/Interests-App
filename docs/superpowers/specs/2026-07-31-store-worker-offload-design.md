# Store-mutating operations off the main thread — design

## Goal

Fix the ~15-second UI freeze that happens whenever a store-mutating operation
(automatic or manual backup, restore, or store-location move) runs, by moving
all of it off the Electron main process — the same process that pumps the
native window's message loop — into a worker thread, following the exact
pattern already proven in production for sync (`core/syncworker.js`, fixed
2026-07-18 for the identical bug class: "A synchronous runSync on the main
process froze every window into Windows' 'Not responding' for the whole
merge").

Discovered live-testing the AI research feature on 2026-07-31 (see memory:
`backup-sync-freeze-and-rmsync-fix`). A separate bug in the same code path (an
unretried `fs.rmSync` throwing on a transient Dropbox lock) was already found
and fixed in commit `3ee6e4b` — that fix is NOT part of this design, it's
already shipped. This design is the remaining, larger architectural fix.

## Background: why this happens

`main.js` starts the Core HTTP service (`core/server.js`) directly in the
Electron main process — there is no worker thread or child process separating
them. Any synchronous, CPU/IO-heavy work triggered by an HTTP route therefore
blocks the same event loop that drives the native window, freezing it for
however long that work takes (Windows shows this as a transparent/"Not
Responding" ghost window).

`core/backup.js`'s `runBackup`, `restore`, and `moveStore` all do this kind of
work: copying and sha256-hashing every image in the library. A library of a
few thousand images can take the observed ~15 seconds or more. This has been a
known tradeoff since a 2026-07-22 performance investigation (documented in
`core/backup.js`'s comments) that made the copy-and-hash step as efficient as
it can be *while still being synchronous* — it only became acutely disruptive
now because automatic backup fires at boot, freezing the app on every launch.

Sync had the identical problem and was already fixed with
`core/syncworker.js`: run the actual work in a fresh `worker_threads.Worker`
per invocation, with a Promise-based façade on the main-thread side matching
the original synchronous call's shape. This design applies that same fix to
backup, restore, and store-move.

## Scope

In scope: `core/backup.js`'s `runBackup`, `rotate`, `restore`, and
`moveStore`, as called from `core/server.js`'s `/api/backup`, `/api/restore`,
and `/api/store-location/move` routes (including the safety-backup-before-
import call at `core/server.js:645`). A UI "operation in progress" indicator
for these three user-facing actions.

Out of scope: moving the whole Core HTTP service into a separate process
(considered and rejected as disproportionate to the actual problem — see the
design's approaches discussion below); any change to backup/restore/move's
existing safety logic, verification, or rollback semantics, beyond what's
needed to relocate the slow parts across the worker boundary; incremental
progress reporting (e.g. "142/6000 images") — matches the existing sync
indicator's precedent of a plain spinner, not a percentage.

## Architecture

### One shared worker file, one shared exclusivity queue

`core/syncworker.js` is renamed to `core/storeworker.js` and extended with
three new `job.op` values (`"backup"`, `"restore"`, `"movestore"`) alongside
its existing `"run"` (sync merge) and `"publish"` (snapshot publish). All five
job types share the SAME `exclusive()` queue that already serializes sync
jobs against each other today — extended to serialize ALL store-mutating
operations against each other, not just within their own type. A restore can
no longer run concurrently with a sync merge, a backup, or a store-move (and
vice versa); every other call queues behind whichever one is in flight.

This closes a real, previously-open concurrency risk at the same time it
fixes the freeze: today, nothing stops a scheduled sync merge from running
while a user-initiated restore is mid-flight, both mutating the same
`ctx.db`/`ctx.storeDir`.

Every job keeps the "one fresh worker per run" shape `syncworker.js`
established: ~50ms spawn cost, the worker opens its own throwaway DB
connection where it needs one and closes it before exiting (so no long-lived
cross-thread DB handle can race the main thread's own connection), and a
Promise-based façade on the main-thread side resolves to the exact same
result shape the synchronous function used to return — so `core/server.js`'s
route handlers change minimally (add `await`, keep the same
`res.json(...)` logic). A crashed/exited worker resolves to
`{ok:false, error:"...worker exited before reporting"}`, matching
`syncworker.js`'s existing crash-safety net — never left hanging.

### `runBackup`/`rotate` — direct port

These never mutate `ctx.db` beyond a quick `PRAGMA wal_checkpoint` and a
read-only `counts()` call at the very start. Both move into the worker
essentially as-is: the worker takes `storeDir` (a plain path) plus the WAL-
checkpoint/counts snapshot taken cheaply on the main thread first, does all
the slow copy-and-hash-and-verify work, and returns the same
`{ok, verified, name, counts}` (backup) result the synchronous version does.
`rotate(keep)` runs in the same worker call immediately after, matching
`core/server.js`'s existing sequencing (backup → verify → conditionally
rotate).

### `moveStore` — near-direct port

Already structured almost perfectly for this: it copies db+images into a NEW
target directory (never touching the live store in place) and verifies there
via its own throwaway DB connection, closing it immediately — exactly
`syncworker.js`'s established shape. Only the final "verified → repoint +
reopen" step (cheap: close the live db, `setStorePath(target)`, reopen) stays
on the main thread, since only the main thread can safely mutate the live
`ctx`.

### `restore` — staging refactor

Today, `restoreFromFolder` copies backup content directly INTO the live store
directory while `ctx.db` is closed — inherently slow, main-thread-only work,
since the live store must stay closed for the whole copy.

New shape, mirroring the stage-then-atomic-rename pattern `runBackup` already
uses when it CREATES a backup:

1. **Worker (slow, no `ctx.db` needed):** copy the backup's `interests.db` +
   images into a scratch staging folder next to the live store — on local
   disk (the live store's own directory, NOT inside the Dropbox-synced
   backups folder), so this copy is immune to the Dropbox-lock contention
   that motivated `renameSyncWithRetry` in the first place. Verify the staged
   copy with the same sha256-manifest check `runBackup`/`verifyBackup` already
   use.
2. **Main thread (fast, needs `ctx.db`):** once the worker reports the stage
   is verified — take the existing pre-restore safety snapshot (already fast:
   a small db-file copy, not the whole image library, unchanged from today),
   close `ctx.db`, drop stale WAL/SHM sidecars (unchanged from today), rename
   the staged folder into place as the new live store (one fast directory
   rename, not a file-by-file copy), reopen `ctx.db`, re-baseline the boot-
   guard counts (unchanged from today).

Net effect: all the slow file I/O moves into the worker; the only main-thread
work is a safety-snapshot copy of the (small) db file, closing/reopening a
database handle, and one fast rename.

The mirror-freeze path (`restore(MIRROR_NAME, ctx)` → `freezeMirrorForRestore`
→ `restoreFromFolder`) is unaffected in its own logic — `freezeMirrorForRestore`
still runs first (unchanged), and its output just becomes the worker's input
instead of `restoreFromFolder`'s.

## Approaches considered

**Chosen: extend the existing worker-per-run pattern to backup/rotate/restore/
moveStore, with restore refactored to a staging-then-rename swap.** Reuses a
pattern already proven in production; the restore refactor is small and
contained (changes *where* it writes before swapping, not its safety/rollback
logic).

**Rejected: fix backup/rotate only, defer restore/moveStore.** Would leave a
known, structurally-identical freeze risk in restore/moveStore unaddressed —
explicitly not what was asked for this pass.

**Rejected: move the whole Core service into a separate child process.**
Would fix this bug class permanently for any future slow function added to
`core/`, not just these four — but is a much larger, riskier change touching
how the entire server boots, binds its port, and communicates with the
renderer and Electron main process, for a problem that's actually scoped to a
few known, already-identified functions. Disproportionate cost for the actual
problem.

## UI

A new store-op-in-flight indicator reuses the existing sync indicator's
spinner styling (the `.syncing`/`spin` class pattern already in the header)
while any backup/restore/move job is in flight, plus the existing `toast()`
pattern for completion/failure — no new visual language. The triggering
buttons (Backup Now, Restore, Move store) stay disabled for the duration of
their own operation (matching today's *effective* behavior, where the freeze
made re-clicking impossible anyway) — but now via an explicit disabled state
instead of an accidental one, so double-submission is prevented by design,
not by luck.

## Error handling

Every failure mode that exists today must still exist identically: a failed
safety-backup-before-import still blocks the import; a failed restore still
leaves the live store untouched; a failed move still leaves the old copy in
place; a `rotate()` that would evict a good backup for a bad one still
refuses. The worker boundary adds exactly one new failure mode — worker
crash or unexpected exit mid-job — handled the same way `syncworker.js`
already handles it for sync: resolved (never rejected) as
`{ok:false, error:"..."}`, surfaced to the user via the existing toast/error
paths already wired to each route's `catch` block.

## Testing

Data-safety-critical code — per this project's conventions, implementation
routes through the `data-safety-reviewer` agent before merge.

Existing `tests/backup.test.js`/`tests/store-safety.test.js` scenarios
exercise `backup.runBackup`/`restore`/`moveStore` directly as pure functions
and must keep passing unchanged — only their CALLERS in `core/server.js`
change to go through the new worker façade, not the underlying functions'
own logic (`restore`'s staging refactor is the one exception: its internal
mechanics change, so its existing tests need updating to match the new
staging-folder-then-rename flow, while their assertions — safety snapshot
still taken, live store never left half-written, rollback on failure —
stay the same).

New tests cover: the shared exclusivity queue (a restore queued behind an
in-flight backup and vice versa — and a sync merge queued behind either),
the restore staging-then-rename swap specifically (staging folder verified
before any live-store mutation; a failure at any stage before the rename
leaves the live store completely untouched), and a worker crash/timeout for
each of the three new job types, mirroring `syncworker.js`'s own existing
crash-handling tests.
