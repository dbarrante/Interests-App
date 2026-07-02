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
  const mergeTimer = setIntervalFn(function () {
    try {
      const sc = deps.config.getSyncConfig();
      if (!sc.enabled) return;
      const syncDir = sc.dir || deps.sync.defaultSyncDir();
      if (!syncDir) return;

      const res = deps.sync.runSync(deps.ctx, {
        syncDir,
        deviceId: sc.deviceId,
        deviceLabel: sc.deviceLabel,
        publish: true,
      });
      if (res && res.changed) {
        try { deps.setKV(deps.ctx.db, "ia_sync_changed_at", String(Date.now())); } catch (e) {}
      }
    } catch (e) { deps.log("periodic sync error:", e && e.message); }
  }, mergeMs);

  // Debounced publish: every ~10s by default, if a write marked the store dirty,
  // publish our snapshot. Also re-reads config every tick.
  const publishTimer = setIntervalFn(function () {
    try {
      const sc = deps.config.getSyncConfig();
      if (!sc.enabled) return;
      const syncDir = sc.dir || deps.sync.defaultSyncDir();
      if (!syncDir) return;

      if (!deps.ctx || !deps.ctx.syncDirty) return;
      deps.ctx.syncDirty = false;
      try {
        deps.sync.publishSnapshot(deps.ctx, syncDir, sc.deviceId, sc.deviceLabel);
      } catch (e) { deps.log("debounced publish error:", e && e.message); }
    } catch (e) { deps.log("debounced publish error:", e && e.message); }
  }, publishMs);

  return {
    stop() {
      try { clearInterval(mergeTimer); } catch (e) {}
      try { clearInterval(publishTimer); } catch (e) {}
    },
  };
}

module.exports = { startSyncTimers };
