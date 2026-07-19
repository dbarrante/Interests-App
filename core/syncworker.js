"use strict";
// Runs sync cycles OFF the Electron main process. A synchronous runSync on the
// main process froze every window into Windows' "Not responding" for the whole
// merge (live 2026-07-18) — the main process pumps the native message loop, so
// blocking it freezes the UI regardless of the renderer being a separate
// process.
//
// Design: ONE FRESH worker per run. ~50ms spawn cost every few minutes buys
// crash isolation and zero lifecycle management, and — critically — the worker
// opens its OWN DatabaseSync connection per run and closes it before exiting,
// so restore/store-move flows never race a long-lived cross-thread DB handle.
// WAL + busy_timeout (core/db.js openDb) absorb brief write-lock contention
// with renderer writes happening through the main process's connection.
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
        // backupFn isn't serializable across the thread boundary; noBackup is
        // the test hook (production omits it and keeps the real safety backup).
        const r = sync.runSync(ctx, { syncDir: job.syncDir, deviceId: job.deviceId, deviceLabel: job.deviceLabel, publish: job.publish !== false, backupFn: job.noBackup ? function () {} : undefined });
        result = { ok: true, changed: r.changed, conflicts: r.conflicts, peers: r.peers, peersSkipped: r.peersSkipped, publishSkipped: r.publishSkipped };
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
      w.once("exit", (code) => done({ ok: false, error: "sync worker exited (" + code + ") before reporting" }));
    });
  }

  // Async façade matching core/sync.js's call shapes — injectable wherever a
  // blocking sync call used to sit (synctimers, the launch merge, POST
  // /api/sync/now). NEVER rejects: every outcome is a resolved object, error
  // outcomes as {ok:false, error}. One cycle at a time — two concurrent merges
  // on two connections would fight over the same rows; extra calls queue.
  function createAsyncSync(storeDir) {
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

  module.exports = { createAsyncSync };
}
