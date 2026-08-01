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
// same ctx.db/storeDir. The slot spans the WHOLE operation, including the
// main-thread continuation (restore's swap, move's repoint) that runs after
// the worker exits — see exclusive() below.
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

if (!isMainThread) {
  // ---- worker side: one job, then exit ----
  const { buildContext } = require("./appctx");
  const sync = require("./sync");
  const job = workerData || {};
  let result;
  try {
    if (job.op === "restore") {
      // Deliberately OUTSIDE buildContext: stageRestore is pure, path-based
      // I/O and must never touch a live database handle. buildContext opens the
      // live store (db.openDb sets journal_mode=WAL, a write to the db file),
      // which would mutate the very store this job is only supposed to read and
      // snapshot. No ctx is built, so there is none to close either.
      const backup = require("./backup");
      // job.witness was read from the LIVE handle on the main thread before the
      // job was queued (see core/server.js) and is only carried through here —
      // the worker has no db handle to read one with, which is the whole point.
      result = backup.stageRestore(job.name, job.storeDir, job.witness);
    } else {
      const ctx = buildContext(job.storeDir);
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
        } else if (job.op === "movestore") {
          const backup = require("./backup");
          // persistPointer:false — this ctx is a THROWAWAY built inside the
          // worker thread, but setStorePath writes the app's ONE durable
          // %APPDATA% store pointer, which is process-wide, not ctx-scoped.
          // Persisting it here meant a move whose ctx.reopen() then threw (a
          // transient EBUSY/AV lock on the just-written db) resolved
          // {ok:false} — the route correctly declined to repoint the REAL
          // ctx, so the running app kept serving the OLD store, while the
          // durable pointer already said `target`: the next launch silently
          // opened the new store and every write made in between was gone.
          // The ROUTE is now the sole writer of that pointer (it runs the
          // repoint as this job's `after` continuation, inside the same
          // exclusivity slot), and only after the new location has proven it
          // opens. See core/backup.js moveStore's opts documentation.
          result = backup.moveStore(job.target, ctx, { persistPointer: false });
        } else {
          // backupFn isn't serializable across the thread boundary; noBackup is
          // the test hook (production omits it and keeps the real safety backup).
          const r = sync.runSync(ctx, { syncDir: job.syncDir, deviceId: job.deviceId, deviceLabel: job.deviceLabel, publish: job.publish !== false, backupFn: job.noBackup ? function () {} : undefined });
          // backupError must cross the thread boundary: production prefers this
          // worker over the direct path, so dropping it here made the manual
          // sync's "merge was skipped" toast permanently unreachable.
          result = { ok: true, changed: r.changed, conflicts: r.conflicts, backupError: r.backupError || null, peers: r.peers, peersSkipped: r.peersSkipped, publishSkipped: r.publishSkipped };
        }
      } finally {
        try { ctx.db.close(); } catch (e) { /* already closed / never opened */ }
      }
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
    // Mutable, not a closed-over const: ctx.storeWorker and startSyncTimers's
    // `sync` reference are the SAME object (main.js constructs one storeWorker
    // and hands it to both), but runSync/publishSnapshot take no storeDir
    // argument — they always read whatever this object currently considers
    // "the store". A successful /api/store-location/move repoints the real
    // ctx.storeDir but, without this, would leave THIS object still pointed at
    // the OLD directory: the next periodic sync tick (or shutdown publish)
    // would silently keep merging/publishing against the abandoned store until
    // the app restarts. setStoreDir() lets the move route repoint this object
    // in place so both call sites pick it up immediately. (runBackup and
    // moveStore are unaffected — the route already passes ctx.storeDir fresh
    // on every call, shadowing this closure via their own per-call parameter.)
    let currentStoreDir = storeDir;
    let inFlight = null;
    // `job` is either a job object or a THUNK returning one. A thunk is
    // evaluated only once this call actually owns the slot, which is what makes
    // a queued job read state (currentStoreDir) as of its EXEC time rather than
    // its BUILD time. Building the object eagerly at call time — as this did —
    // meant a sync/publish queued behind a store move captured the pre-move
    // directory and then merged/published against the abandoned store, because
    // the recursive re-dispatch below re-passes the already-frozen object.
    //
    // `after` is the operation's MAIN-THREAD continuation (restore's swap,
    // move's repoint): the destructive half that only the route can run,
    // because only the route holds the real ctx. It runs on the job's result
    // BEFORE the slot is released, so the exclusivity window spans the WHOLE
    // operation, not just the worker half. Without it the swap/repoint ran in
    // the route's own continuation, OUTSIDE the queue, and stayed safe only by
    // accident of promise-reaction ordering — one inserted `await` between a
    // worker resolving and its swap would have let the next queued job spawn
    // its worker against a store mid-swap.
    //
    // An `after` that THROWS resolves {ok:false} rather than rejecting: the
    // façade's documented contract is that it never rejects, and — more
    // importantly — a rejected inFlight would otherwise propagate through the
    // queued `.then()` below and strand every job behind it.
    function exclusive(job, after) {
      if (inFlight) {
        const next = function () { return exclusive(job, after); };
        // Both handlers: the queue must drain on a settled predecessor
        // regardless of how it settled.
        return inFlight.then(next, next);
      }
      const spec = (typeof job === "function") ? job() : job;
      const p = runJob(spec)
        .then(function (r) { return after ? after(r) : r; })
        .catch(function (e) { return { ok: false, error: (e && e.message) || String(e) }; })
        .finally(function () { if (inFlight === p) inFlight = null; });
      inFlight = p;
      return p;
    }
    return {
      defaultSyncDir: syncMod.defaultSyncDir,
      // THUNKS, not objects: currentStoreDir must be read when this job reaches
      // the front of the queue, not when it was enqueued — a tick queued behind
      // an in-flight store move would otherwise target the pre-move directory.
      runSync(_ctx, opts) {
        return exclusive(function () { return { op: "run", storeDir: currentStoreDir, syncDir: opts.syncDir, deviceId: opts.deviceId, deviceLabel: opts.deviceLabel, publish: opts.publish, noBackup: !!opts.noBackup }; });
      },
      publishSnapshot(_ctx, syncDir, deviceId, deviceLabel) {
        return exclusive(function () { return { op: "publish", storeDir: currentStoreDir, syncDir, deviceId, deviceLabel }; });
      },
      runBackup(storeDir, opts) {
        opts = opts || {};
        return exclusive({ op: "backup", storeDir, safety: !!opts.safety, keep: opts.keep });
      },
      // `after` is /api/store-location/move's main-thread continuation: the
      // write-witness re-check and the ctx/pointer repoint. Passing it here
      // (rather than running it after awaiting this promise) is what keeps the
      // repoint INSIDE the exclusivity slot — no other job may spawn its worker
      // until currentStoreDir/ctx.storeDir have both been repointed.
      moveStore(storeDir, target, after) {
        return exclusive({ op: "movestore", storeDir, target }, after);
      },
      // Runs the staging half of a restore (backup.stageRestore) on the worker:
      // verify, safety-snapshot the live store, stage the incoming content. The
      // STAGED result ({ok, stageFolder, snapshotFolder, witness, storeDir}) is
      // then handed to `after` — /api/restore's main-thread continuation, which
      // runs backup.swapInStagedRestore(staged, ctx): the only part that needs
      // the real ctx.db / ctx.reopen, and cheap (renames, not copies).
      //
      // `after` runs INSIDE the exclusivity slot, so no other job can spawn its
      // worker while the store is mid-swap. Without it the swap ran in the
      // route's own continuation, outside the queue. This promise therefore
      // resolves the SWAP's result, not the staged one.
      //
      // `witness` is backup.storeWitness(ctx.db, storeDir) read on the main
      // thread just before this call; it rides through the worker untouched so
      // the swap can prove nothing was written to the live store meanwhile.
      // runJob resolves the worker's result object WHOLESALE — do not reshape
      // it into a field list here: dropping storeDir would make
      // swapInStagedRestore refuse every worker-path restore.
      restore(storeDir, name, witness, after) {
        return exclusive({ op: "restore", storeDir, name, witness }, after);
      },
      setStoreDir(newStoreDir) { currentStoreDir = newStoreDir; },
    };
  }

  module.exports = { createStoreWorker };
}
