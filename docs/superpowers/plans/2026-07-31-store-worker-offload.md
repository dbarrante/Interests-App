# Store Worker Offload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the ~15-second UI freeze on backup/restore/store-move by moving all their slow, synchronous file I/O off the Electron main process into a worker thread, extending the existing `core/syncworker.js` pattern (already proven in production for sync, fixed 2026-07-18 for the identical bug class) — with one shared exclusivity queue across sync, backup, restore, and store-move.

**Architecture:** `core/syncworker.js` is renamed to `core/storeworker.js` and grows three new job types (`"backup"`, `"restore"`, `"movestore"`) alongside its existing `"run"`/`"publish"` sync jobs, all sharing one `exclusive()` queue. Each job keeps the established "one fresh worker per run" shape: the worker does all the slow, `ctx.db`-independent file I/O using only plain paths, and returns a result the main thread turns into a cheap, fast db-handle close/reopen. Restore is refactored from "copy into the live store while `ctx.db` is closed" to "stage a verified copy next to the live store, then swap in via fast directory renames" — mirroring the stage-then-rename pattern `runBackup` already uses for creating backups.

**Tech Stack:** Node.js `worker_threads`, `node:sqlite`'s `DatabaseSync`, Express (`core/server.js`), plain `assert`-based tests (`node tests/<name>.test.js`).

## Global Constraints

- This is safety-critical code (backup/restore/store-move). Per this project's conventions, the data-safety-reviewer agent reviews every task in this plan, and the final whole-branch review is dispatched on the most capable available model.
- Every existing `tests/backup.test.js`/`tests/store-safety.test.js` scenario that calls `backup.runBackup`/`restore`/`moveStore` directly (as pure functions, not through the worker) must keep passing unchanged — these tests exercise the underlying logic directly and are the safety net for every task in this plan. The one exception is `restore`'s internal mechanics (Task 4), whose existing tests need updating to match the new staging-then-rename flow while keeping the same safety assertions (snapshot taken, live store never left half-written, rollback on failure).
- `core/server.js`'s existing fallback pattern (`const runner = (ctx.syncRunner && ctx.syncRunner.runSync) ? ctx.syncRunner : sync;`) must be preserved for every new job type: when `ctx.storeWorker` isn't set (as in every existing server test, which mounts `createServer(ctx)` without a worker), routes fall back to calling the direct synchronous function — so no existing HTTP-level test needs a worker thread to pass.
- The shared exclusive queue must serialize ALL FIVE job types against each other (sync run, sync publish, backup, restore, movestore) — not just within their own type. A restore must not be able to run concurrently with a sync merge, and vice versa, for any of the 10 possible pairs.
- Every failure mode that exists today must still exist identically: a failed safety-backup-before-import still blocks the import; a failed restore leaves the live store untouched; a failed move leaves the old copy in place; `rotate()` never evicts a good backup for a bad one.
- A worker crash or unexpected exit mid-job resolves as `{ok:false, error:"..."}` — matching `syncworker.js`'s existing crash-safety net (`w.once("exit", ...)`) — never left hanging, never rejects the returned Promise.
- Follow the project's `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` commit trailer convention.

---

### Task 1: Rename `core/syncworker.js` → `core/storeworker.js`

**Files:**
- Create: `core/storeworker.js`
- Delete: `core/syncworker.js`
- Modify: `main.js:7,95,97` (require path, `createAsyncSync`→`createStoreWorker`, `ctx.syncRunner`→`ctx.storeWorker`)
- Modify: `core/server.js:834` (the one reference, plus its surrounding comment)
- Modify: `core/synctimers.js:28` (comment only — mentions `core/syncworker.js` by name)
- Modify: `core/db.js:83` (comment only — mentions `core/syncworker.js` by name)
- Create: `tests/storeworker.test.js` (renamed from `tests/syncworker.test.js`, same content, updated import/identifier names)
- Delete: `tests/syncworker.test.js`
- Modify: `tests/sync-skip.test.js:160-161` (assertions check `main.js`'s literal source text for the old names)

**Interfaces:**
- Consumes: nothing new — this task is a pure rename with zero behavior change.
- Produces: `core/storeworker.js` exporting `{ createStoreWorker }`. `createStoreWorker(storeDir)` returns `{ defaultSyncDir, runSync(_ctx, opts), publishSnapshot(_ctx, syncDir, deviceId, deviceLabel) }` — identical shape to the old `createAsyncSync`, just renamed. `ctx.storeWorker` is the property name every later task's server.js changes read. Later tasks add `runBackup`, `restore`, `moveStore` methods to this SAME returned object, sharing its internal `exclusive()` queue.

- [ ] **Step 1: Create `core/storeworker.js` with the renamed identifiers**

Copy `core/syncworker.js`'s full content into a new file `core/storeworker.js`, with these renames (content otherwise identical):
- `createAsyncSync` → `createStoreWorker` (the function name and the final `module.exports`)
- Update the top comment to reflect the broader scope:

```js
"use strict";
// Runs store-mutating operations (sync, backup, restore, store-move) OFF the
// Electron main process. A synchronous runSync on the main process froze
// every window into Windows' "Not responding" for the whole merge (live
// 2026-07-18) — the main process pumps the native message loop, so blocking
// it freezes the UI regardless of the renderer being a separate process.
// Backup/restore/store-move have the identical problem (large image
// libraries, synchronous copy+hash) and share this same worker + queue.
//
// Design: ONE FRESH worker per run. ~50ms spawn cost every few minutes buys
// crash isolation and zero lifecycle management, and — critically — the worker
// opens its OWN DatabaseSync connection per run and closes it before exiting,
// so restore/store-move flows never race a long-lived cross-thread DB handle.
// WAL + busy_timeout (core/db.js openDb) absorb brief write-lock contention
// with renderer writes happening through the main process's connection.
//
// ONE queue serializes ALL FIVE job types against each other (sync run, sync
// publish, backup, restore, movestore) — not just within their own type. A
// restore must never run concurrently with a sync merge; both mutate the
// same ctx.db/storeDir.
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

if (!isMainThread) {
  // ---- worker side: one job, then exit ----
  const { buildContext } = require("./appctx");
  const sync = require("./sync");
  const job = workerData || {};
  let result;
  try {
    const ctx = buildContext(job.storeDir);
    try {
      if (job.op === "publish") {
        sync.publishSnapshot(ctx, job.syncDir, job.deviceId, job.deviceLabel);
        result = { ok: true };
      } else {
        const r = sync.runSync(ctx, { syncDir: job.syncDir, deviceId: job.deviceId, deviceLabel: job.deviceLabel, publish: job.publish !== false, backupFn: job.noBackup ? function () {} : undefined });
        result = { ok: true, changed: r.changed, conflicts: r.conflicts, backupError: r.backupError || null, peers: r.peers, peersSkipped: r.peersSkipped, publishSkipped: r.publishSkipped };
      }
    } finally {
      try { ctx.db.close(); } catch (e) { /* already closed / never opened */ }
    }
  } catch (e) {
    result = { ok: false, error: (e && e.message) || String(e) };
  }
  parentPort.postMessage(result);
} else {
  // ---- main side ----
  function runJob(job) {
    return new Promise((resolve) => {
      const w = new Worker(__filename, { workerData: job });
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; resolve(r); } };
      w.once("message", done);
      w.once("error", (e) => done({ ok: false, error: (e && e.message) || String(e) }));
      w.once("exit", (code) => done({ ok: false, error: "store worker exited (" + code + ") before reporting" }));
    });
  }

  // Async façade matching core/sync.js's call shapes — injectable wherever a
  // blocking sync call used to sit (synctimers, the launch merge, POST
  // /api/sync/now). NEVER rejects: every outcome is a resolved object, error
  // outcomes as {ok:false, error}. One job at a time ACROSS ALL job types —
  // two concurrent store-mutating operations would fight over the same files.
  function createStoreWorker(storeDir) {
    const syncMod = require("./sync");
    let inFlight = null;
    function exclusive(job) {
      if (inFlight) return inFlight.then(() => exclusive(job));
      const p = runJob(job).finally(() => { if (inFlight === p) inFlight = null; });
      inFlight = p;
      return p;
    }
    return {
      defaultSyncDir: syncMod.defaultSyncDir,
      runSync(_ctx, opts) {
        return exclusive({ op: "run", storeDir, syncDir: opts.syncDir, deviceId: opts.deviceId, deviceLabel: opts.deviceLabel, publish: opts.publish, noBackup: !!opts.noBackup });
      },
      publishSnapshot(_ctx, syncDir, deviceId, deviceLabel) {
        return exclusive({ op: "publish", storeDir, syncDir, deviceId, deviceLabel });
      },
    };
  }

  module.exports = { createStoreWorker };
}
```

- [ ] **Step 2: Delete the old file**

```bash
git rm core/syncworker.js
```

- [ ] **Step 3: Update `main.js`**

At `main.js:7`:
```js
const { createStoreWorker } = require("./core/storeworker");
```
At `main.js:91-102`, replace the whole block:
```js
      // All periodic/launch/manual sync cycles, plus backup/restore/store-move,
      // run OFF the main process via a worker-thread façade — a synchronous
      // merge or backup on the main process froze every window into "Not
      // responding" (live 2026-07-18; backup/restore/move confirmed 2026-07-31).
      // Same call shapes, async results; one job at a time across all of them.
      const storeWorker = createStoreWorker(storeDir);
      syncRunner = storeWorker;
      ctx.storeWorker = storeWorker;   // POST /api/sync/now, /api/backup, /api/restore, /api/store-location/move all use this when present

      // Sync timers self-gate on live config (re-read every tick), so start them
      // unconditionally — enabling/disabling Dropbox sync in Settings takes effect
      // on the next tick with no app restart required.
      timers = startSyncTimers({ ctx, config, sync: storeWorker, setKV, log: console.error });
```
At `main.js:135`, the launch-merge callback also references the old name — replace `asyncSync.runSync(` with `storeWorker.runSync(`.

The `syncRunner` local variable (declared at `main.js:26`, read at `main.js:171,177,191` in the `will-quit` handler) is unchanged — it already gets assigned `storeWorker` above, and `will-quit`'s own use of it (checking truthiness, calling `.publishSnapshot`) is unaffected since `storeWorker` has that same method.

- [ ] **Step 4: Update `core/server.js:834` and its comment**

```js
      // Prefer the worker-thread runner (ctx.storeWorker, set by main.js) so a
      // manual sync can't freeze the main process either; tests and headless
      // embedders without a runner keep the direct synchronous path.
      const runner = (ctx.storeWorker && ctx.storeWorker.runSync) ? ctx.storeWorker : sync;
```

- [ ] **Step 5: Update the two comment-only references**

`core/synctimers.js:28`: replace `core/syncworker.js` with `core/storeworker.js` in the comment text.
`core/db.js:83`: replace `core/syncworker.js` with `core/storeworker.js` in the comment text.

- [ ] **Step 6: Create `tests/storeworker.test.js`**

Copy `tests/syncworker.test.js`'s full content into `tests/storeworker.test.js`, with these renames (content, assertions, and test names otherwise identical):
- `require("../core/syncworker.js")` → `require("../core/storeworker.js")`
- `createAsyncSync` → `createStoreWorker` (every occurrence)
- Top comment: `core/syncworker.js` → `core/storeworker.js`, `"syncworker: "` → `"storeworker: "` in the final summary log line

- [ ] **Step 7: Delete the old test file**

```bash
git rm tests/syncworker.test.js
```

- [ ] **Step 8: Update `tests/sync-skip.test.js`**

At `tests/sync-skip.test.js:160-161`:
```js
    assert.ok(/createStoreWorker\(storeDir\)/.test(mainSrc), "façade constructed from the store dir");
    assert.ok(/ctx\.storeWorker = storeWorker/.test(mainSrc), "manual /api/sync/now must get the worker runner too");
```

- [ ] **Step 9: Run the renamed test and the full suite**

Run: `node tests/storeworker.test.js`
Expected: `storeworker: 3 passed, 0 failed` (same 3 tests as before, renamed).

Run: `node tests/sync-skip.test.js`
Expected: all tests pass, including the two updated assertions.

Run: `npm test`
Expected: `ALL TEST FILES PASSED` — zero behavior change, this task is a pure rename.

- [ ] **Step 10: Commit**

```bash
git add core/storeworker.js main.js core/server.js core/synctimers.js core/db.js tests/storeworker.test.js tests/sync-skip.test.js
git commit -m "Rename core/syncworker.js to core/storeworker.js

Pure rename, no behavior change — establishes the shared worker file and
exclusivity queue that Tasks 2-4 extend with backup/restore/movestore job
types. createAsyncSync -> createStoreWorker, ctx.syncRunner -> ctx.storeWorker.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Add a `"backup"` job type

**Files:**
- Modify: `core/storeworker.js` (worker-side `"backup"` handling; main-side `runBackup` method)
- Modify: `core/server.js:626-658,661-688` (both call sites: safety-backup-before-import, and the main `/api/backup` route)
- Test: `tests/storeworker.test.js` (new backup-specific tests)

**Interfaces:**
- Consumes: `core/backup.js`'s existing `runBackup(db, storeDir, opts)`, `verifyBackup(name, counts)`, `rotate(keep)` (all unchanged by this task) and `core/db.js`'s `openDb(storeDir)`.
- Produces: `ctx.storeWorker.runBackup(storeDir, { safety, keep })` → `Promise<{ok, verified, name, counts, error?}>` (safety-backup calls omit `keep`; the main `/api/backup` route passes it). Later tasks (`restore`, `movestore`) add sibling methods to the same object, following this exact call/return shape.

- [ ] **Step 1: Write the failing test**

Add to `tests/storeworker.test.js`, after the existing sync tests but before the final IIFE closes:

```js
  await run("backup job runs off-thread and matches the direct call's result shape", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia-wrk-backup-"));
    const storeDir = path.join(root, "store"); fs.mkdirSync(path.join(storeDir, "images"), { recursive: true });
    const backupRoot = path.join(root, "backups");
    const d = db.openDb(storeDir);
    db.upsertCard(d, { id: "c1", url: "http://x/1", ts: 1 });
    d.close();

    const backupMod = require("../core/backup.js");
    const originalDetect = backupMod.detectDropboxRoot;
    backupMod.detectDropboxRoot = function () { return backupRoot; };
    try {
      const storeWorker = createStoreWorker(storeDir);
      const out = await storeWorker.runBackup(storeDir, { keep: 3 });
      assert.strictEqual(out.ok, true, "backup job must succeed: " + (out.error || ""));
      assert.strictEqual(out.verified, true);
      assert.ok(out.name, "backup name returned");
      assert.strictEqual(out.counts.imported, 1);
      assert.strictEqual(backupMod.verifyBackup(out.name, out.counts), true, "the backup the worker created must independently verify from the main thread too");
    } finally {
      backupMod.detectDropboxRoot = originalDetect;
    }
  });

  await run("backup job resolves {ok:false}, never rejects, on a genuine failure", async () => {
    const storeWorker = createStoreWorker(path.join(os.tmpdir(), "ia-wrk-backup-missing-" + Date.now()));
    const out = await storeWorker.runBackup(path.join(os.tmpdir(), "ia-wrk-backup-missing-" + Date.now()), { keep: 3 });
    assert.strictEqual(out.ok, false);
    assert.ok(out.error);
  });
```

At the top of `tests/storeworker.test.js`, add:
```js
const { createStoreWorker } = require("../core/storeworker.js");
```
(replacing whatever Task 1 named this import as — confirm it matches Task 1's Step 6 rename.)

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/storeworker.test.js`
Expected: FAIL — `storeWorker.runBackup is not a function`.

- [ ] **Step 3: Write the implementation**

In `core/storeworker.js`, worker-side branch, add a `"backup"` case:

```js
    try {
      if (job.op === "publish") {
        sync.publishSnapshot(ctx, job.syncDir, job.deviceId, job.deviceLabel);
        result = { ok: true };
      } else if (job.op === "backup") {
        const backup = require("./backup");
        const out = backup.runBackup(ctx.db, job.storeDir, { safety: !!job.safety });
        const verified = backup.verifyBackup(out.name, out.counts);
        if (verified && !job.safety && job.keep) backup.rotate(job.keep);
        result = { ok: true, verified, name: out.name, counts: out.counts };
      } else {
        const r = sync.runSync(ctx, { syncDir: job.syncDir, deviceId: job.deviceId, deviceLabel: job.deviceLabel, publish: job.publish !== false, backupFn: job.noBackup ? function () {} : undefined });
        result = { ok: true, changed: r.changed, conflicts: r.conflicts, backupError: r.backupError || null, peers: r.peers, peersSkipped: r.peersSkipped, publishSkipped: r.publishSkipped };
      }
    } finally {
```

`ctx` (from `buildContext(job.storeDir)`) already opens its own `ctx.db` — `runBackup`'s existing signature takes a `db` handle for its WAL-checkpoint and counts() calls; the worker's freshly-opened `ctx.db` is a separate connection to the SAME sqlite file, and WAL checkpointing is file-level (not connection-level), so this is safe and correct without any change to `runBackup` itself.

Add the main-side method to `createStoreWorker`'s returned object:
```js
      runBackup(storeDir, opts) {
        opts = opts || {};
        return exclusive({ op: "backup", storeDir, safety: !!opts.safety, keep: opts.keep });
      },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/storeworker.test.js`
Expected: PASS, all tests including the 2 new ones.

- [ ] **Step 5: Wire `core/server.js`'s two call sites**

The `/api/import` route (`core/server.js:626-658`) is currently synchronous (`(req, res) => {`) and does its safety backup at lines 644-649:
```js
      let safety;
      try { safety = backup.runBackup(ctx.db, ctx.storeDir, { safety: true }); }
      catch (e) { e.code = "SAFETY_BACKUP_FAILED"; throw e; }
      if (!safety || !backup.verifyBackup(safety.name, safety.counts)) {
        return res.status(409).json({ error: "safety backup not verified" });
      }
```
Change the route handler signature to `app.post("/api/import", async (req, res) => {` and replace those 5 lines with:
```js
      let safety;
      try {
        const runner = (ctx.storeWorker && ctx.storeWorker.runBackup) ? ctx.storeWorker : { runBackup: (storeDir, opts) => Promise.resolve(backup.runBackup(ctx.db, storeDir, opts)) };
        safety = await runner.runBackup(ctx.storeDir, { safety: true });
      }
      catch (e) { e.code = "SAFETY_BACKUP_FAILED"; throw e; }
      if (!safety || !backup.verifyBackup(safety.name, safety.counts)) {
        return res.status(409).json({ error: "safety backup not verified" });
      }
```
Note this changes the safety-backup call's return shape from `runBackup`'s raw `{name, counts}` to the worker façade's `{ok, verified, name, counts}` — but only `.name`/`.counts` were ever read here (the very next line calls `backup.verifyBackup(safety.name, safety.counts)` independently), so the extra `ok`/`verified` fields are additive and harmless.

At `core/server.js:661-674` (the main `/api/backup` route), replace the synchronous body with:
```js
  app.post("/api/backup", async (req, res) => {
    try {
      const safety = !!(req.body && req.body.safety);
      let keep = Number(req.body && req.body.keep);
      if (!Number.isFinite(keep) || keep < 1) keep = 3;
      keep = Math.min(Math.floor(keep), 30);
      const runner = (ctx.storeWorker && ctx.storeWorker.runBackup) ? ctx.storeWorker : { runBackup: (storeDir, opts) => Promise.resolve((function () {
        const out = backup.runBackup(ctx.db, storeDir, { safety: opts.safety });
        const verified = backup.verifyBackup(out.name, out.counts);
        if (verified && !opts.safety && opts.keep) backup.rotate(opts.keep);
        return { ok: true, verified, name: out.name, counts: out.counts };
      })()) };
      const out = await runner.runBackup(ctx.storeDir, { safety, keep });
      res.json(out);
    } catch (e) {
      console.error("backup failed:", e);
      const msg = (e && e.message) || "";
      if (/images dir is missing|expects \d+ images but only/.test(msg)) {
        return res.status(409).json({ ok: false, error: msg });
      }
      res.status(500).json({ ok: false, error: "backup failed" });
    }
  });
```
This preserves the exact same client-facing response shape (`{ok, verified, name, counts}`) and the exact same 409-vs-500 error classification the existing route already has — only the execution path (worker vs. direct) changes based on whether `ctx.storeWorker` is present, matching the established sync fallback pattern exactly.

- [ ] **Step 6: Run the full suite**

Run: `node tests/syntax-check.js` (skip if this repo has no such gate for `core/`; this project's syntax gate is for `web/index.html`/`pwa/index.html` only — confirm and skip if inapplicable)
Run: `npm test`
Expected: `ALL TEST FILES PASSED` — every existing `tests/backup.test.js`/`tests/importer-api.test.js` test still calls `backup.runBackup` directly (no `ctx.storeWorker` set in those test harnesses) and is unaffected.

- [ ] **Step 7: Commit**

```bash
git add core/storeworker.js core/server.js tests/storeworker.test.js
git commit -m "Add a backup job type to the store worker

Backup + rotate move off the main thread, following the same
one-fresh-worker-per-run pattern already established for sync. Both
core/server.js call sites (the safety-backup-before-import, and the
main /api/backup route) fall back to the direct synchronous path when
ctx.storeWorker isn't set, matching the existing sync fallback pattern
— so every existing HTTP-level test is unaffected.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Add a `"movestore"` job type

**Files:**
- Modify: `core/storeworker.js` (worker-side `"movestore"` handling; main-side `moveStore` method)
- Modify: `core/server.js:760-773` (`/api/store-location/move`)
- Test: `tests/storeworker.test.js` (new movestore-specific test)

**Interfaces:**
- Consumes: `core/backup.js`'s existing `moveStore(target, ctx)` (unchanged by this task).
- Produces: `ctx.storeWorker.moveStore(storeDir, target)` → `Promise<{ok, path}>`.

- [ ] **Step 1: Write the failing test**

Add to `tests/storeworker.test.js`:

```js
  await run("movestore job copies+verifies off-thread; main thread only repoints", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia-wrk-move-"));
    const storeDir = path.join(root, "store"); fs.mkdirSync(path.join(storeDir, "images"), { recursive: true });
    const target = path.join(root, "moved");
    const d = db.openDb(storeDir);
    db.upsertCard(d, { id: "c1", url: "http://x/1", ts: 1 });
    d.close();

    const storeWorker = createStoreWorker(storeDir);
    const out = await storeWorker.moveStore(storeDir, target);
    assert.strictEqual(out.ok, true, "move must succeed: " + (out.error || ""));
    assert.ok(fs.existsSync(path.join(target, "interests.db")), "db copied to target");
    // Old copy is left on disk (matches moveStore's own documented behavior)
    assert.ok(fs.existsSync(path.join(storeDir, "interests.db")), "old store files left in place");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/storeworker.test.js`
Expected: FAIL — `storeWorker.moveStore is not a function`.

- [ ] **Step 3: Write the implementation**

`moveStore(target, ctx)` already does everything EXCEPT the final "close+repoint+reopen" without touching `ctx.db` directly for its own copy — it reads `counts(ctx.db)` at the very start (needs a db handle) and calls `ctx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)")` (also needs a handle) before copying. In the worker, the freshly-opened `ctx.db` (from `buildContext(job.storeDir)`) serves this exact purpose — same reasoning as Task 2's backup job. The worker's `ctx` is a THROWAWAY context (closed in the `finally` below); it never repoints anything — `moveStore`'s own step 3 ("verified → repoint + reopen") reassigns the WORKER's own throwaway `ctx.storeDir`/`ctx.db`, which is fine since that `ctx` is discarded when the worker exits regardless. The MAIN thread's real `ctx` is repointed separately, in the main-side method below, using the worker's returned `path`.

Worker-side, add a `"movestore"` case:
```js
      } else if (job.op === "movestore") {
        const backup = require("./backup");
        result = backup.moveStore(job.target, ctx);
      } else if (job.op === "backup") {
```
(Order among the `else if` branches doesn't matter; place consistently with Task 2's addition.)

Main-side method:
```js
      moveStore(storeDir, target) {
        return exclusive({ op: "movestore", storeDir, target });
      },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/storeworker.test.js`
Expected: PASS, all tests including the new one.

- [ ] **Step 5: Wire `core/server.js`'s `/api/store-location/move` route**

Replace the current route body (`core/server.js:760-773`, currently synchronous):
```js
  app.post("/api/store-location/move", async (req, res) => {
    let target = req.body && req.body.target;
    if (!target || typeof target !== "string" || !path.isAbsolute(target)) {
      return res.status(400).json({ ok: false, path: ctx.storeDir, error: "absolute target required" });
    }
    target = path.resolve(target);
    try {
      const usingWorker = !!(ctx.storeWorker && ctx.storeWorker.moveStore);
      const runner = usingWorker ? ctx.storeWorker : { moveStore: (storeDir, t) => Promise.resolve(backup.moveStore(t, ctx)) };
      const out = await runner.moveStore(ctx.storeDir, target);
      // The worker path's own internal ctx is a throwaway (closed inside the
      // worker thread) and never repoints anything — only the main thread's
      // real ctx can be safely repointed, so that happens here, once the
      // worker confirms success. The no-worker fallback calls
      // backup.moveStore(t, ctx) against the REAL ctx directly (exactly as
      // today) and already repoints it internally — guard against
      // double-repointing that path.
      if (usingWorker && out.ok) { ctx.setStorePath(target); ctx.storeDir = target; ctx.db = ctx.reopen(); }
      res.json({ ok: out.ok, path: ctx.storeDir });
    } catch (e) {
      console.error("store move failed:", e);
      res.status(500).json({ ok: false, path: ctx.storeDir, error: "move failed" });
    }
  });
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: `ALL TEST FILES PASSED` — existing `tests/store-safety.test.js` scenarios call `backup.moveStore` directly and are unaffected.

- [ ] **Step 7: Commit**

```bash
git add core/storeworker.js core/server.js tests/storeworker.test.js
git commit -m "Add a movestore job type to the store worker

moveStore already copied to a NEW target location and verified there
via its own throwaway DB connection — the same shape syncworker.js
already used, so this ports over almost as-is. Only the final
repoint+reopen (cheap, needs the real ctx) stays on the main thread.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Restore staging refactor + `"restore"` job type

**Files:**
- Modify: `core/backup.js` (new `stageRestore(name, storeDir)`; `restoreFromFolder` replaced by a main-thread `swapInStagedRestore(staged, ctx)`)
- Modify: `core/storeworker.js` (worker-side `"restore"` handling; main-side `restore` method)
- Modify: `core/server.js:704-716` (`/api/restore`)
- Test: `tests/backup.test.js` (update the existing restore tests for the new internal mechanics — same safety assertions, new call shape); `tests/storeworker.test.js` (new restore-specific test)

**Interfaces:**
- Consumes: `core/backup.js`'s existing `freezeMirrorForRestore()`, `verifyBackupFolder`, `verifyDbOnly`, `readMeta`, `overlayImages`, `copyImagesAndBuildManifest`, `imagesDir`, `dropboxBackupDir`, `rotateUnverifiedSnapshots`, `MIRROR_NAME`, `MIRROR_FREEZE_NAME`, `RESTORE_BACKUP_NAME` (all unchanged).
- Produces: `backup.stageRestore(name, storeDir)` → `{ok, stageFolder, error?}` (pure, path-based, worker-safe — no `ctx` argument at all). `backup.swapInStagedRestore(stageFolder, ctx)` → `{ok, error?}` (main-thread-only, needs `ctx.db`/`ctx.reopen`). `ctx.storeWorker.restore(storeDir, name)` → `Promise<{ok, error?}>` orchestrating both.

- [ ] **Step 1: Write the failing tests**

In `tests/backup.test.js`, find the existing restore tests (search for `t("restore snapshots current store`, `t("restore ABORTS before overwriting`, `t("restore recovers ctx.db to a live handle`). These stay conceptually the same but their SETUP/ASSERTIONS change shape since `restore(name, ctx)` no longer exists as a single synchronous call — it's replaced by the two-step `stageRestore`/`swapInStagedRestore`. Replace the whole block covering these three tests with:

```js
t("stageRestore verifies the source backup and stages it next to the live store, without touching ctx.db", () => {
  withBackupDir(function () {
    const store = newStore();
    const db1 = openDb(store);
    upsertCard(db1, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
    images.putImg(store, "c1", TINY_JPG);
    const made = backup.runBackup(db1, store);
    db1.close();

    // Change the live store after the backup, so we can tell restore actually
    // staged the OLD (backed-up) content, not the current live content.
    const db2 = openDb(store);
    upsertCard(db2, { id: "c2", url: "https://x/2", platform: "fb", cat: "Saved", ts: 2 });

    const staged = backup.stageRestore(made.name, store);
    assert.strictEqual(staged.ok, true, "stageRestore must succeed: " + (staged.error || ""));
    assert.ok(fs.existsSync(path.join(staged.stageFolder, "interests.db")), "staged db present");
    assert.ok(fs.existsSync(path.join(staged.stageFolder, "images", "c1.jpg")), "staged image present");
    // The live store must be completely untouched by stageRestore.
    const liveCounts = counts(db2);
    assert.strictEqual(liveCounts.cards, 2, "live store unchanged by stageRestore");
    db2.close();
    fs.rmSync(staged.stageFolder, { recursive: true, force: true });
  });
});

t("swapInStagedRestore closes db, swaps in the staged content, reopens db", () => {
  withBackupDir(function () {
    const store = newStore();
    const db1 = openDb(store);
    upsertCard(db1, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
    images.putImg(store, "c1", TINY_JPG);
    const made = backup.runBackup(db1, store);
    db1.close();

    const db2 = openDb(store);
    upsertCard(db2, { id: "c2", url: "https://x/2", platform: "fb", cat: "Saved", ts: 2 });
    const ctx = { db: db2, storeDir: store, reopen: function () { try { ctx.db.close(); } catch (e) {} ctx.db = openDb(ctx.storeDir); return ctx.db; } };

    const staged = backup.stageRestore(made.name, store);
    assert.strictEqual(staged.ok, true);
    const swapped = backup.swapInStagedRestore(staged.stageFolder, ctx);
    assert.strictEqual(swapped.ok, true, "swap must succeed: " + (swapped.error || ""));
    const restoredCounts = counts(ctx.db);
    assert.strictEqual(restoredCounts.cards, 1, "live store now reflects the restored (backed-up) content, not the pre-restore c2 card");
    ctx.db.close();
  });
});

t("restore ABORTS before overwriting the live store if stageRestore's safety snapshot fails", () => {
  withBackupDir(function () {
    const store = newStore();
    const db1 = openDb(store);
    upsertCard(db1, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1 });
    const made = backup.runBackup(db1, store);
    db1.close();
    const db2 = openDb(store);

    const originalCopy = fs.copyFileSync;
    let copyCalls = 0;
    fs.copyFileSync = function (src, dst) {
      // Fail specifically on the pre-restore safety-snapshot copy (the FIRST
      // copyFileSync call inside stageRestore), not the later staging copy.
      copyCalls++;
      if (copyCalls === 1) throw new Error("simulated disk full");
      return originalCopy.apply(fs, arguments);
    };
    let staged;
    try {
      staged = backup.stageRestore(made.name, store);
    } finally {
      fs.copyFileSync = originalCopy;
    }
    assert.strictEqual(staged.ok, false);
    assert.match(staged.error, /safety snapshot failed/);
    const liveCounts = counts(db2);
    assert.strictEqual(liveCounts.cards, 1, "live store untouched when the safety snapshot fails");
    db2.close();
  });
});

t("swapInStagedRestore recovers ctx.db to a live handle when the swap step throws mid-restore", () => {
  withBackupDir(function () {
    const store = newStore();
    const db1 = openDb(store);
    upsertCard(db1, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1 });
    const made = backup.runBackup(db1, store);
    db1.close();
    const db2 = openDb(store);
    const ctx = { db: db2, storeDir: store, reopen: function () { try { ctx.db.close(); } catch (e) {} ctx.db = openDb(ctx.storeDir); return ctx.db; } };
    const staged = backup.stageRestore(made.name, store);
    assert.strictEqual(staged.ok, true);

    const originalRename = fs.renameSync;
    fs.renameSync = function (src, dst) {
      if (String(src).indexOf("interests.db") >= 0 && String(dst).indexOf(staged.stageFolder) < 0 && String(dst).indexOf(store) >= 0 && String(dst).indexOf(".old") < 0) {
        // Fail the "rename staged db into place" step specifically.
        throw new Error("simulated rename failure");
      }
      return originalRename.apply(fs, arguments);
    };
    let swapped;
    try {
      swapped = backup.swapInStagedRestore(staged.stageFolder, ctx);
    } finally {
      fs.renameSync = originalRename;
    }
    assert.strictEqual(swapped.ok, false);
    assert.ok(ctx.db && typeof ctx.db.prepare === "function", "ctx.db must be a live, usable handle after a failed swap, not left closed");
    ctx.db.close();
  });
});
```

Remove any prior test bodies that called `backup.restore(name, ctx)` directly with the OLD single-call signature (the ones this step's replacements supersede) — search `tests/backup.test.js` for `backup.restore(` to find them all, including the mirror-freeze reconciliation test if it calls the old signature (if it calls `backup.restore(MIRROR_NAME, ctx)`, update it to call `stageRestore(MIRROR_NAME, store)` + `swapInStagedRestore(staged.stageFolder, ctx)` instead, keeping its existing assertions about the freeze folder being cleaned up).

Add to `tests/storeworker.test.js`:
```js
  await run("restore job stages+verifies off-thread, main thread does the fast swap", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia-wrk-restore-"));
    const storeDir = path.join(root, "store"); fs.mkdirSync(path.join(storeDir, "images"), { recursive: true });
    const backupRoot = path.join(root, "backups");
    const backupMod = require("../core/backup.js");
    const originalDetect = backupMod.detectDropboxRoot;
    backupMod.detectDropboxRoot = function () { return backupRoot; };
    try {
      const d1 = db.openDb(storeDir);
      db.upsertCard(d1, { id: "c1", url: "http://x/1", ts: 1 });
      const made = backupMod.runBackup(d1, storeDir);
      d1.close();

      const storeWorker = createStoreWorker(storeDir);
      const out = await storeWorker.restore(storeDir, made.name);
      assert.strictEqual(out.ok, true, "restore job must succeed: " + (out.error || ""));
      const d2 = db.openDb(storeDir);
      assert.ok(db.allCards(d2).some((c) => c.id === "c1"), "restored content present");
      d2.close();
    } finally {
      backupMod.detectDropboxRoot = originalDetect;
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/backup.test.js`
Expected: FAIL — `backup.stageRestore is not a function`, `backup.swapInStagedRestore is not a function`.

Run: `node tests/storeworker.test.js`
Expected: FAIL — `storeWorker.restore is not a function`.

- [ ] **Step 3: Write the implementation in `core/backup.js`**

Replace `restore(name, ctx)` and `restoreFromFolder(effectiveName, ctx)` (the two functions this task's tests supersede) with:

```js
// Stage a restore off the main thread: freeze the mirror if needed, verify
// the source backup, take the pre-restore safety snapshot of the CURRENT
// live store, and stage the incoming backup's db+images into a scratch
// folder next to storeDir. Pure path-based I/O — never touches a db handle,
// safe to run inside a worker thread. Returns everything the (cheap,
// main-thread-only) swapInStagedRestore needs.
function stageRestore(name, storeDir) {
  if (!isValidBackupName(name)) return { ok: false };
  let effectiveName = name;
  let didFreeze = false;
  if (name === MIRROR_NAME) {
    try { effectiveName = freezeMirrorForRestore(); didFreeze = true; }
    catch (e) { return { ok: false, error: "mirror freeze failed: " + (e && e.message || e) }; }
  }
  try {
    const backupFolder = path.join(dropboxBackupDir(), effectiveName);
    let hasDb = false;
    try { hasDb = fs.statSync(path.join(backupFolder, "interests.db")).isFile(); } catch (e) { hasDb = false; }
    if (!hasDb) return { ok: false };
    const backupMeta = readMeta(backupFolder);
    if (!backupMeta || !verifyBackupFolder(backupFolder, backupMeta._counts)) return { ok: false, error: "backup not verified" };

    // Pre-restore safety snapshot of the CURRENT live store — same content
    // and purpose as before, just relocated off the main thread (it does its
    // own full-image-library copy, exactly like the staging copy below, so it
    // belongs here, not left behind on the main thread).
    const snapName = "interests-backup-before-restore-" + Date.now();
    const snapFolder = path.join(dropboxBackupDir(), snapName);
    fs.mkdirSync(path.join(snapFolder, "images"), { recursive: true });
    try {
      fs.copyFileSync(path.join(storeDir, "interests.db"), path.join(snapFolder, "interests.db"));
    } catch (e) {
      return { ok: false, error: "safety snapshot failed" };
    }
    overlayImages(path.join(storeDir, "images"), path.join(snapFolder, "images"));

    // Stage the incoming backup on LOCAL disk next to the live store (not
    // inside the Dropbox-synced backups folder) so the swap step is a fast
    // same-volume rename, not a slow cross-location copy, and is immune to
    // the Dropbox-sync lock class documented on renameSyncWithRetry above.
    const token = process.pid + "-" + Date.now();
    const stageFolder = path.join(path.dirname(storeDir), "." + path.basename(storeDir) + ".restage-" + token);
    fs.mkdirSync(path.join(stageFolder, "images"), { recursive: true });
    fs.copyFileSync(path.join(backupFolder, "interests.db"), path.join(stageFolder, "interests.db"));
    const ids = (backupMeta._images || []).map(function (m) { return String(m.name || "").replace(/\.jpg$/, ""); });
    const manifest = copyImagesAndBuildManifest(imagesDir(backupFolder), path.join(stageFolder, "images"), ids);
    if (manifest.length !== (backupMeta._counts.images | 0) || !verifyDbOnly(path.join(stageFolder, "interests.db"), backupMeta._counts)) {
      try { fs.rmSync(stageFolder, { recursive: true, force: true }); } catch (e) {}
      return { ok: false, error: "staged restore failed to verify" };
    }
    return { ok: true, stageFolder: stageFolder };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  } finally {
    if (didFreeze) {
      try { fs.rmSync(path.join(dropboxBackupDir(), effectiveName), { recursive: true, force: true }); } catch (e) {}
      try { rotateUnverifiedSnapshots(dropboxBackupDir(), MIRROR_FREEZE_NAME, 0); } catch (e) {}
    }
  }
}

// The ONLY main-thread-only step: close ctx.db, swap the already-verified
// staged content into place via fast directory renames (not copies — the
// slow work already happened in stageRestore), reopen ctx.db. The displaced
// OLD live content is kept until the swap is confirmed (same "keep displaced
// until verified" posture runBackup's own publish step already uses), so a
// failure here leaves the live store exactly as it was.
function swapInStagedRestore(stageFolder, ctx) {
  try { ctx.db.close(); } catch (e) {}
  for (const ext of ["-wal", "-shm"]) { try { fs.rmSync(path.join(ctx.storeDir, "interests.db" + ext), { force: true }); } catch (e) {} }

  const oldAside = stageFolder + ".old";
  try {
    fs.mkdirSync(oldAside, { recursive: true });
    renameSyncWithRetry(path.join(ctx.storeDir, "interests.db"), path.join(oldAside, "interests.db"));
    renameSyncWithRetry(path.join(ctx.storeDir, "images"), path.join(oldAside, "images"));
    renameSyncWithRetry(path.join(stageFolder, "interests.db"), path.join(ctx.storeDir, "interests.db"));
    renameSyncWithRetry(path.join(stageFolder, "images"), path.join(ctx.storeDir, "images"));
  } catch (e) {
    try { renameSyncWithRetry(path.join(oldAside, "interests.db"), path.join(ctx.storeDir, "interests.db")); } catch (e2) {}
    try { renameSyncWithRetry(path.join(oldAside, "images"), path.join(ctx.storeDir, "images")); } catch (e2) {}
    try { ctx.db = ctx.reopen(); } catch (e2) {}
    return { ok: false, error: "restore swap failed: " + (e && e.message) };
  }
  try { fs.rmSync(oldAside, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(stageFolder, { recursive: true, force: true }); } catch (e) {}

  ctx.db = ctx.reopen();
  try { const rc = counts(ctx.db); recordLastCounts({ cards: rc.cards | 0, saved: rc.saved | 0 }); } catch (e) {}
  try { rotateUnverifiedSnapshots(dropboxBackupDir(), RESTORE_BACKUP_NAME, 2); } catch (e) {}
  return { ok: true };
}
```

Update the final `module.exports` line: replace `restore` with `stageRestore, swapInStagedRestore`.

- [ ] **Step 4: Wire the worker and `core/server.js`**

Worker-side, add a `"restore"` case in `core/storeworker.js`:
```js
      } else if (job.op === "restore") {
        const backup = require("./backup");
        result = backup.stageRestore(job.name, job.storeDir);
```

Main-side method:
```js
      restore(storeDir, name) {
        return exclusive({ op: "restore", storeDir, name });
      },
```

Note this method's result is the STAGED result, not the final swap — `core/server.js`'s route does the swap step itself afterward (it needs the real `ctx`, which a worker call can't touch). Replace `core/server.js:704-716`:
```js
  app.post("/api/restore", async (req, res) => {
    const name = req.body && req.body.name;
    if (!isAllowedBackupName(name)) {
      return res.status(400).json({ ok: false, error: "invalid backup name" });
    }
    try {
      const usingWorker = !!(ctx.storeWorker && ctx.storeWorker.restore);
      const staged = usingWorker ? await ctx.storeWorker.restore(ctx.storeDir, name) : backup.stageRestore(name, ctx.storeDir);
      if (!staged.ok) return res.json(staged);
      const out = backup.swapInStagedRestore(staged.stageFolder, ctx);
      res.json(out);
    } catch (e) {
      console.error("restore failed:", e);
      res.status(500).json({ ok: false, error: "restore failed" });
    }
  });
```
The swap step (`swapInStagedRestore`) always runs directly on the main thread's real `ctx` regardless of whether staging went through the worker — this is intentional: it's cheap (renames, not copies), and it needs the actual live `ctx.db`/`ctx.reopen`, which no worker call can provide.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node tests/backup.test.js`
Expected: PASS, `69 passed, 0 failed` or more (the 3 new/updated tests plus the pre-existing 66, minus however many old restore tests were replaced — confirm the count is sensible, not a drop).

Run: `node tests/storeworker.test.js`
Expected: PASS, all tests including the new restore one.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: `ALL TEST FILES PASSED`.

- [ ] **Step 7: Commit**

```bash
git add core/backup.js core/storeworker.js core/server.js tests/backup.test.js tests/storeworker.test.js
git commit -m "Refactor restore to stage-then-rename; add a restore job type

restore(name, ctx) is replaced by stageRestore(name, storeDir) (pure,
path-based, worker-safe — does the mirror-freeze, verification, safety
snapshot, and staging copy, all without touching ctx.db) and
swapInStagedRestore(stageFolder, ctx) (main-thread-only: close db, fast
directory-rename swap using the already-verified staged content, reopen
db). The displaced old live content is kept until the swap is confirmed,
matching runBackup's own publish-step safety posture.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Frontend "operation in progress" indicator

**Files:**
- Modify: `web/index.html`, `pwa/index.html` (new `storeOpInFlight` state + rendering, reusing the existing sync-indicator spinner styling; disable Backup Now / Restore / Move buttons while their own operation is in flight)
- Test: a new `tests/store-op-indicator.test.js` (parity + behavior), following the `tests/sync-endpoints.test.js`-style pattern already used for `syncIndicatorView`

**Interfaces:**
- Consumes: the existing `.syncing`/`spin` CSS classes and `toast()` (unchanged).
- Produces: `let _storeOpInFlight = null;` (string: `"backup"|"restore"|"move"|null`), `storeOpIndicatorHTML()` (returns the small spinner markup when `_storeOpInFlight` is set, empty string otherwise — same shape as the existing `syncIndicatorView`).

- [ ] **Step 1: Write the failing test**

First, find the existing frontend call sites for backup/restore/move (search `web/index.html` for `/api/backup`, `/api/restore`, `/api/store-location/move` — these are the functions this task wraps with the new in-flight state). Read them to confirm their exact current names before writing the test (do not guess the names — they are not yet established by this plan and must be taken from the real file).

Create `tests/store-op-indicator.test.js`:
```js
// tests/store-op-indicator.test.js — Task 5: the small "operation in
// progress" spinner shown while a backup/restore/store-move is in flight,
// reusing the existing sync indicator's .syncing/spin CSS pattern. Backup/
// restore/move are async now (Tasks 2-4), so their triggering buttons need an
// explicit in-flight state instead of relying on the old freeze to prevent
// double-submission.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }
function fn(src, name) { const m = extractFn(src, name); assert.ok(m, name + " not found in source"); return m; }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": storeOpIndicatorHTML renders nothing when no operation is in flight", () => {
    const factory = new Function("_storeOpInFlight", fn(src, "storeOpIndicatorHTML") + "\nreturn storeOpIndicatorHTML;");
    const storeOpIndicatorHTML = factory(null);
    assert.strictEqual(storeOpIndicatorHTML(), "");
  });

  t(label + ": storeOpIndicatorHTML shows a spinning indicator naming the in-flight operation", () => {
    const factory = new Function("_storeOpInFlight", fn(src, "storeOpIndicatorHTML") + "\nreturn storeOpIndicatorHTML;");
    const storeOpIndicatorHTML = factory("backup");
    const out = storeOpIndicatorHTML();
    assert.match(out, /spin/);
    assert.match(out, /[Bb]ack(ing)? ?up/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/store-op-indicator.test.js`
Expected: FAIL — `storeOpIndicatorHTML not found in source`.

- [ ] **Step 3: Write the implementation**

In `web/index.html`, near the existing `syncIndicatorView` function, add:
```js
let _storeOpInFlight = null;   // null | "backup" | "restore" | "move" — which store-mutating op (if any) is currently awaiting its response
function storeOpIndicatorHTML(){
  if(!_storeOpInFlight) return "";
  const label = _storeOpInFlight==="backup" ? "Backing up…" : (_storeOpInFlight==="restore" ? "Restoring…" : "Moving store…");
  return `<span class="syncing spin" title="${label}">${label}</span>`;
}
```
(Reuse the EXACT class names the existing sync indicator uses for its own spinner — confirm the precise class/markup shape by reading the existing `syncIndicatorView`'s spinning-state branch and match it exactly, rather than inventing new markup.)

Find the existing backup-trigger function (likely `backupNow()`/`doBackup()`'s frontend caller — the one that does `fetch("/api/backup", ...)`), the restore-trigger function, and the move-store-trigger function. Wrap each with the in-flight flag:
```js
async function backupNow(){
  _storeOpInFlight = "backup";
  renderSyncStatus();   // or whatever function currently re-renders the header area the sync indicator lives in — confirm the real name
  try{
    return await doBackup(true);
  } finally {
    _storeOpInFlight = null;
    renderSyncStatus();
  }
}
```
Apply the equivalent wrap to the restore-trigger and move-store-trigger functions — read their current bodies first and wrap them the same way (set `_storeOpInFlight` before the fetch, clear it in a `finally`, re-render before and after), preserving every line of their existing logic unchanged in between.

Also disable the triggering buttons while `_storeOpInFlight` is truthy — find wherever these buttons are rendered (Settings view) and add `${_storeOpInFlight?"disabled":""}` to each of the three buttons.

Apply the identical changes to `pwa/index.html`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/store-op-indicator.test.js`
Expected: PASS for both web and pwa.

- [ ] **Step 5: Run the full suite and syntax gate**

Run: `node tests/syntax-check.js && npm test`
Expected: both green. Specifically re-check any existing test that extracts `backupNow`/the restore-trigger/move-store-trigger functions via `new Function(...)` — if any exist and don't inject `_storeOpInFlight`/`renderSyncStatus` as new free variables those functions now reference, fix by injecting them with safe defaults (this project's plans have hit this exact cross-task test-fragility class repeatedly — check before committing, not after).

- [ ] **Step 6: Commit**

```bash
git add web/index.html pwa/index.html tests/store-op-indicator.test.js
git commit -m "Add an in-flight indicator for backup/restore/store-move

Now that these are async (Tasks 2-4), a click needs an explicit
in-progress signal instead of relying on the old freeze to prevent
double-submission. Reuses the existing sync indicator's spinner styling
— no new visual language. Triggering buttons disable for the duration
of their own operation.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Parity, full regression, SHELL_CACHE bump, data-safety review

**Files:**
- Modify: `pwa/sw.js` (SHELL_CACHE bump — Task 5 touched `pwa/index.html`)
- No new test file — this task is verification only.

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: nothing new.

- [ ] **Step 1: Confirm byte-identity of Task 5's new frontend functions**

Run a quick manual check (no new test file needed — this mirrors the exact verification technique used throughout this project's other UI plans):
```bash
node -e "
const fs=require('fs');
const {extractFn}=require('./tests/_extract');
const web=fs.readFileSync('web/index.html','utf8');
const pwa=fs.readFileSync('pwa/index.html','utf8');
for(const n of ['storeOpIndicatorHTML']){
  const a=extractFn(web,n), b=extractFn(pwa,n);
  console.log(n, a===b?'IDENTICAL':'DIFFERS');
}
"
```
Expected: `IDENTICAL`. If it differs, fix before proceeding.

- [ ] **Step 2: Bump SHELL_CACHE**

In `pwa/sw.js`, find the current `SHELL_CACHE` version string and increment its trailing number by one (Task 5 touched `pwa/index.html`; whatever value it's at when this task starts is the one to increment — this plan's earlier tasks don't touch `pwa/index.html` at all, only Task 5 does).

- [ ] **Step 3: Run the full suite and syntax gate**

Run: `node tests/syntax-check.js && npm test`
Expected: `ALL TEST FILES PASSED`, 0 failures, across every test file from Tasks 1-5 plus every pre-existing test in the repo — this is a safety-critical subsystem, so a genuinely full, clean run matters more here than in most plans.

- [ ] **Step 4: Commit**

```bash
git add pwa/sw.js
git commit -m "Store worker offload: SHELL_CACHE bump, final regression

Full npm test + syntax-check green across all 5 tasks.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 5: Data-safety review (not a code step — a process gate)**

Per this plan's Global Constraints, dispatch the `data-safety-reviewer` agent against the WHOLE branch diff before this plan is considered done — not just per-task (per-task reviews already happen via the subagent-driven-development process this plan is executed under; this is the additional whole-branch pass the Global Constraints call for, given the safety-critical nature of every file this plan touches). Pay particular attention to: the shared exclusivity queue actually serializing all 5 job types against each other (not just within their own type); the restore swap's rollback-on-failure path; and that `swapInStagedRestore`'s `oldAside` cleanup can never run before the swap is confirmed successful.

- [ ] **Step 6: Manual smoke check (reserved for after the final whole-branch review)**

Do this together with the user on the real desktop app, same precedent as prior plans in this session:
1. Trigger a manual backup ("Back Up Now" or equivalent Settings button) — confirm the UI shows the in-flight spinner and stays responsive (no freeze) for the whole duration, then a completion toast.
2. Restore from a backup — confirm the same responsiveness, and that the restored data is actually correct afterward.
3. Move the data store to a new folder — confirm the same responsiveness, and that the app is reading from the new location afterward (Settings → Data location reflects it).
4. With a backup in flight, try triggering a manual sync (or wait for the periodic sync timer) — confirm it visibly queues/waits rather than running concurrently (no way to directly observe the queue from the UI today, but confirm nothing errors or corrupts; this is the one behavior this plan's automated tests cover most directly, so the live check here is a light confirmation, not the primary verification).
