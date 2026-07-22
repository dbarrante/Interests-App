const { autoImportEnabled } = require("./chrome-launch");

const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

function createChromeAvailabilityMonitor(opts) {
  opts = opts || {};
  const readSettings = opts.readSettings;
  const ensureChrome = opts.ensureChrome;
  const now = opts.now || Date.now;
  const setTimeoutFn = opts.setTimeoutFn || setTimeout;
  const setIntervalFn = opts.setIntervalFn || setInterval;
  const clearTimeoutFn = opts.clearTimeoutFn || clearTimeout;
  const clearIntervalFn = opts.clearIntervalFn || clearInterval;
  const intervalMs = opts.intervalMs || DEFAULT_INTERVAL_MS;
  const cooldownMs = opts.cooldownMs || DEFAULT_COOLDOWN_MS;
  const log = opts.log || function () {};

  let stopped = false;
  let inFlight = false;
  let startupTimer = null;
  let intervalTimer = null;
  let lastLaunchAt = -Infinity;

  function settingsRaw() {
    try { return readSettings(); } catch (_) { return null; }
  }

  function launchStillAllowed() {
    if (stopped || now() - lastLaunchAt < cooldownMs) return false;
    return autoImportEnabled(settingsRaw());
  }

  async function check() {
    if (stopped) return { action: "stopped" };
    if (inFlight) return { action: "skipped-in-flight" };
    inFlight = true;
    try {
      const result = await ensureChrome({ settingsRaw: settingsRaw(), shouldLaunch: launchStillAllowed });
      if (result && result.action === "launched") lastLaunchAt = now();
      return result;
    } catch (e) {
      try { log(e); } catch (_) {}
      return { action: "error", error: String(e && e.message || e) };
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (startupTimer !== null || intervalTimer !== null) return;
    stopped = false;
    startupTimer = setTimeoutFn(() => { check(); }, 0);
    intervalTimer = setIntervalFn(() => { check(); }, intervalMs);
  }

  function stop() {
    stopped = true;
    if (startupTimer !== null) { clearTimeoutFn(startupTimer); startupTimer = null; }
    if (intervalTimer !== null) { clearIntervalFn(intervalTimer); intervalTimer = null; }
  }

  return { start, stop, check };
}

module.exports = { createChromeAvailabilityMonitor, DEFAULT_INTERVAL_MS, DEFAULT_COOLDOWN_MS };
