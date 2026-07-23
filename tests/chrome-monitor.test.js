const assert = require("assert");
const { createChromeAvailabilityMonitor } = require("../core/chrome-monitor");

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.error("  FAIL " + name + "\n    " + (e && e.stack || e)); }
}

(async () => {
  await t("start schedules immediate and minute checks; stop clears both", () => {
    const calls = { timeouts: [], intervals: [], clearedTimeouts: [], clearedIntervals: [] };
    const m = createChromeAvailabilityMonitor({
      readSettings: () => "{}", ensureChrome: async () => ({ action: "disabled" }),
      setTimeoutFn: (fn, ms) => { calls.timeouts.push([fn, ms]); return 11; },
      setIntervalFn: (fn, ms) => { calls.intervals.push([fn, ms]); return 22; },
      clearTimeoutFn: (id) => calls.clearedTimeouts.push(id),
      clearIntervalFn: (id) => calls.clearedIntervals.push(id),
    });
    m.start();
    assert.strictEqual(calls.timeouts[0][1], 0);
    assert.strictEqual(calls.intervals[0][1], 60 * 1000);
    m.stop();
    assert.deepStrictEqual(calls.clearedTimeouts, [11]);
    assert.deepStrictEqual(calls.clearedIntervals, [22]);
  });

  await t("overlapping checks are suppressed", async () => {
    let release, ensureCalls = 0;
    const m = createChromeAvailabilityMonitor({
      readSettings: () => JSON.stringify({ autoImportOn: true }),
      ensureChrome: () => { ensureCalls++; return new Promise((resolve) => { release = resolve; }); },
    });
    const first = m.check();
    const second = await m.check();
    assert.deepStrictEqual(second, { action: "skipped-in-flight" });
    assert.strictEqual(ensureCalls, 1);
    release({ action: "already-running" });
    await first;
  });

  await t("stop during a pending check cancels launch", async () => {
    let release;
    const m = createChromeAvailabilityMonitor({
      readSettings: () => JSON.stringify({ autoImportOn: true }),
      ensureChrome: ({ shouldLaunch }) => new Promise((resolve) => {
        release = () => resolve({ action: shouldLaunch() ? "launched" : "cancelled" });
      }),
    });
    const pending = m.check();
    m.stop();
    release();
    assert.deepStrictEqual(await pending, { action: "cancelled" });
  });

  await t("setting is re-read immediately before launch", async () => {
    let settings = JSON.stringify({ autoImportOn: true });
    const m = createChromeAvailabilityMonitor({
      readSettings: () => settings,
      ensureChrome: async ({ shouldLaunch }) => {
        settings = JSON.stringify({ autoImportOn: false });
        return { action: shouldLaunch() ? "launched" : "cancelled" };
      },
    });
    assert.deepStrictEqual(await m.check(), { action: "cancelled" });
  });

  await t("launch cooldown prevents minute-by-minute window storms", async () => {
    let now = 1000;
    const m = createChromeAvailabilityMonitor({
      readSettings: () => JSON.stringify({ autoImportOn: true }), now: () => now,
      ensureChrome: async ({ shouldLaunch }) => ({ action: shouldLaunch() ? "launched" : "cancelled" }),
    });
    assert.strictEqual((await m.check()).action, "launched");
    now += 60 * 1000;
    assert.strictEqual((await m.check()).action, "cancelled");
    now += 5 * 60 * 1000;
    assert.strictEqual((await m.check()).action, "launched");
  });

  console.log("chrome-monitor: " + passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
