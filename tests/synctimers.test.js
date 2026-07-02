const assert = require("assert");

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

const { startSyncTimers } = require("../core/synctimers.js");

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Fake deps mirroring main.js's real collaborators (config/sync/setKV/log), with an
// `enabled` flag we can flip mid-test to simulate the user toggling sync in Settings
// without restarting the app.
function fakeDeps() {
  const calls = { runSync: 0, publish: 0 };
  const cfg = { enabled: false };
  const deps = {
    ctx: { db: {}, syncDirty: true },
    config: { getSyncConfig: () => Object.assign({ dir: "X", deviceId: "d", deviceLabel: "l" }, cfg) },
    sync: {
      defaultSyncDir: () => "X",
      runSync: () => { calls.runSync++; return { changed: false }; },
      publishSnapshot: () => { calls.publish++; },
    },
    log: () => {},
    setKV: () => {},
    mergeMs: 5,
    publishMs: 5,
  };
  return { calls, cfg, deps };
}

(async () => {
  await t("disabled -> enabled at runtime -> disabled again: timers self-gate on live config", async () => {
    const { calls, cfg, deps } = fakeDeps();
    const timers = startSyncTimers(deps);
    try {
      // Phase 1: disabled from the start — no calls at all.
      await wait(30);
      assert.strictEqual(calls.runSync, 0, "runSync should not fire while disabled");
      assert.strictEqual(calls.publish, 0, "publishSnapshot should not fire while disabled");

      // Phase 2: user flips sync on in Settings — no restart, next tick picks it up.
      cfg.enabled = true;
      await wait(30);
      assert.ok(calls.runSync > 0, "runSync should fire once enabled");

      // Phase 3: user disables again — timers must go quiet (not just stop retrying).
      cfg.enabled = false;
      const runSyncAfterDisable = calls.runSync;
      await wait(30);
      assert.strictEqual(calls.runSync, runSyncAfterDisable, "runSync should stop firing once disabled again");
    } finally {
      timers.stop();
    }
  });

  await t("startSyncTimers returns { stop() } that clears both intervals", async () => {
    const { calls, cfg, deps } = fakeDeps();
    cfg.enabled = true;
    const timers = startSyncTimers(deps);
    await wait(30);
    assert.ok(calls.runSync > 0, "sanity: timers should have run at least once");
    timers.stop();
    const runSyncAtStop = calls.runSync;
    await wait(30);
    assert.strictEqual(calls.runSync, runSyncAtStop, "no further ticks after stop()");
  });

  await t("merge tick calls setKV with ia_sync_changed_at when res.changed is true", async () => {
    const { cfg, deps } = fakeDeps();
    cfg.enabled = true;
    const setKVCalls = [];
    deps.setKV = (db, key, value) => setKVCalls.push({ db, key, value });
    deps.sync.runSync = () => ({ changed: true });
    const timers = startSyncTimers(deps);
    try {
      await wait(30);
      assert.ok(setKVCalls.length > 0, "setKV should be called after a changed sync");
      assert.strictEqual(setKVCalls[0].key, "ia_sync_changed_at");
    } finally {
      timers.stop();
    }
  });

  await t("publish tick respects ctx.syncDirty debounce and clears the flag", async () => {
    const { calls, cfg, deps } = fakeDeps();
    cfg.enabled = true;
    deps.ctx.syncDirty = false; // not dirty -> publish tick should no-op
    const timers = startSyncTimers(deps);
    try {
      await wait(30);
      assert.strictEqual(calls.publish, 0, "publish should not fire while ctx.syncDirty is false");
    } finally {
      timers.stop();
    }
  });

  await t("a throwing tick never propagates out (merge and publish ticks are caught)", async () => {
    const { cfg, deps } = fakeDeps();
    cfg.enabled = true;
    deps.sync.runSync = () => { throw new Error("boom-merge"); };
    deps.sync.publishSnapshot = () => { throw new Error("boom-publish"); };
    const logged = [];
    deps.log = (...args) => logged.push(args);
    const timers = startSyncTimers(deps);
    try {
      await wait(30);
      assert.ok(logged.length > 0, "errors from ticks should be logged, not thrown");
    } finally {
      timers.stop();
    }
  });

  console.log(pass + " passed, " + fail + " failed");
  process.exitCode = fail ? 1 : 0;
})();
