// Periodic Dropbox sync timers, extracted from main.js so they can be unit-tested
// and so they honor runtime enable/disable of sync without an app restart.
//
// Design: EVERY tick (merge and publish alike) re-reads deps.config.getSyncConfig()
// fresh. If sync is currently disabled, the tick is a no-op — it does not remember
// whatever was true when startSyncTimers() was called. That means callers can call
// this unconditionally at startup; the timers self-gate on live config, so flipping
// sync on/off in Settings takes effect on the very next tick.
//
// deps = {
//   ctx,                 // app context: { db, syncDirty, ... }
//   config,               // core/config.js — needs getSyncConfig()
//   sync,                 // core/sync.js — needs runSync(ctx, opts), defaultSyncDir()
//   setKV,                // core/db.js's setKV(db, key, value)
//   log,                  // error logger, e.g. console.error
//   setIntervalFn,        // optional — override for testing (defaults to global setInterval)
//   mergeMs, publishMs,    // optional interval overrides (defaults below)
// }
function startSyncTimers(deps) {
  const setIntervalFn = deps.setIntervalFn || setInterval;
  const mergeMs = deps.mergeMs || 3 * 60 * 1000;
  const publishMs = deps.publishMs || 10 * 1000;

  // Periodic merge + publish (~3 min by default). On a change, signal the renderer
  // via a kv flag. Re-reads config every tick so enable/disable takes effect live.
  //
  // deps.sync may be SYNCHRONOUS (core/sync.js, tests) or ASYNC (the
  // core/syncworker.js façade that runs cycles off the main process —
  // 2026-07-18 "Not responding" fix). Promise.resolve() handles both; the
  // busy guards stop a slow async cycle from overlapping the next tick.
  let mergeBusy = false;
  const mergeTimer = setIntervalFn(function () {
    try {
      const sc = deps.config.getSyncConfig();
      if (!sc.enabled) return;
      const syncDir = sc.dir || deps.sync.defaultSyncDir();
      if (!syncDir) return;
      if (mergeBusy) return;
      mergeBusy = true;
      Promise.resolve(deps.sync.runSync(deps.ctx, {
        syncDir,
        deviceId: sc.deviceId,
        deviceLabel: sc.deviceLabel,
        publish: true,
      })).then(function (res) {
        if (res && res.ok === false) { deps.log("periodic sync error:", res.error); return; }
        if (res && res.changed) {
          try { deps.setKV(deps.ctx.db, "ia_sync_changed_at", String(Date.now())); } catch (e) {}
        }
      }).catch(function (e) {
        deps.log("periodic sync error:", e && e.message);
      }).finally(function () { mergeBusy = false; });
    } catch (e) { mergeBusy = false; deps.log("periodic sync error:", e && e.message); }
  }, mergeMs);

  // Debounced publish: every ~10s by default, if a write marked the store dirty,
  // publish our snapshot. Also re-reads config every tick. On an async failure
  // the dirty flag is restored so the publish retries next tick.
  let publishBusy = false;
  const publishTimer = setIntervalFn(function () {
    try {
      const sc = deps.config.getSyncConfig();
      if (!sc.enabled) return;
      const syncDir = sc.dir || deps.sync.defaultSyncDir();
      if (!syncDir) return;

      if (!deps.ctx || !deps.ctx.syncDirty) return;
      if (publishBusy) return;
      publishBusy = true;
      deps.ctx.syncDirty = false;
      Promise.resolve(deps.sync.publishSnapshot(deps.ctx, syncDir, sc.deviceId, sc.deviceLabel))
        .then(function (r) {
          if (r && r.ok === false) { deps.ctx.syncDirty = true; deps.log("debounced publish error:", r.error); }
        })
        .catch(function (e) { deps.ctx.syncDirty = true; deps.log("debounced publish error:", e && e.message); })
        .finally(function () { publishBusy = false; });
    } catch (e) { publishBusy = false; deps.log("debounced publish error:", e && e.message); }
  }, publishMs);

  return {
    stop() {
      try { clearInterval(mergeTimer); } catch (e) {}
      try { clearInterval(publishTimer); } catch (e) {}
    },
  };
}

module.exports = { startSyncTimers };
