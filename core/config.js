// Store-location pointer + config persistence for the Interests App.
// %APPDATA%\Interests App\config.json holds { storePath?: string, ... }.
// Lives OUTSIDE the install dir so it survives reinstalls/updates.
const fs = require("fs");
const path = require("path");

// Electron is optional here: this module must be require()-able from plain Node tests.
let app = null;
try { app = require("electron").app; } catch (_) { /* not under Electron */ }

function appDataDir() {
  const base = process.env.APPDATA || path.join(require("os").homedir(), "AppData", "Roaming");
  return path.join(base, "Interests App");
}

function configPath() {
  return path.join(appDataDir(), "config.json");
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) || {};
  } catch (_) {
    return {};
  }
}

// Atomic write: write to a tmp sidecar then rename into place (same pattern as
// core/sync.js _writeAtomic). A torn write directly on config.json would make the
// app forget its configured storePath — i.e. "all my data is gone" on next launch.
// rename() is atomic on the same volume, so config.json is never observed half-written.
function saveConfig(obj) {
  fs.mkdirSync(appDataDir(), { recursive: true });
  const target = configPath();
  const tmpFile = target + ".tmp." + process.pid;
  fs.writeFileSync(tmpFile, JSON.stringify(obj || {}, null, 2), "utf8");
  try {
    fs.renameSync(tmpFile, target);
  } catch (e) {
    // Rename failed (e.g. cross-device, locked file) — the tmp sidecar would otherwise
    // linger forever. Clean it up before rethrowing so the caller sees the real error.
    try { fs.unlinkSync(tmpFile); } catch (_) {}
    throw e;
  }
}

function defaultStoreDir() {
  if (app && app.isPackaged) {
    return path.join(path.dirname(app.getPath("exe")), "data");
  }
  return path.resolve("data");
}

// True if `dir` can be created and written to. Used to detect a non-writable
// preferred store dir (e.g. a per-machine install under C:\Program Files).
function isWritableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".wtest-" + process.pid);
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return true;
  } catch (_) {
    return false;
  }
}

// Always-writable per-user fallback (next to config.json in %APPDATA%).
function fallbackStoreDir() {
  return path.join(appDataDir(), "data");
}

function getStorePath() {
  const cfg = loadConfig();
  let dir = cfg.storePath || defaultStoreDir();
  // If the preferred location isn't writable (e.g. a Program Files install dir),
  // fall back to a guaranteed-writable per-user folder and remember it, so the
  // app always opens instead of crashing on an un-creatable store.
  if (!isWritableDir(dir)) {
    dir = fallbackStoreDir();
    fs.mkdirSync(dir, { recursive: true });
    if (cfg.storePath !== dir) { cfg.storePath = dir; saveConfig(cfg); }
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}

function setStorePath(p) {
  const cfg = loadConfig();
  cfg.storePath = p;
  saveConfig(cfg);
}

// Pure read: applies in-memory defaults for deviceId/deviceLabel if missing but
// does NOT persist them. Safe to call on every timer tick (core/synctimers.js
// calls this every ~10s) without touching disk. Call ensureSyncConfig() once at
// startup to persist the generated deviceId/deviceLabel so they stay stable
// across restarts.
function getSyncConfig() {
  const cfg = loadConfig();
  return {
    enabled: !!cfg.syncEnabled,
    dir: cfg.syncDir || null,
    deviceId: cfg.deviceId || ("dev_" + require("crypto").randomUUID()),
    deviceLabel: cfg.deviceLabel || (require("os").hostname() || "device"),
  };
}

// Write-defaults side effect, split out of getSyncConfig(): generates and
// persists deviceId/deviceLabel the first time they're missing. Call once at
// startup (before anything reads sync config) so the device identity is stable.
function ensureSyncConfig() {
  const cfg = loadConfig();
  let changed = false;
  if (!cfg.deviceId) { cfg.deviceId = "dev_" + require("crypto").randomUUID(); changed = true; }
  if (!cfg.deviceLabel) { cfg.deviceLabel = require("os").hostname() || "device"; changed = true; }
  if (changed) saveConfig(cfg);
  return {
    enabled: !!cfg.syncEnabled,
    dir: cfg.syncDir || null,
    deviceId: cfg.deviceId,
    deviceLabel: cfg.deviceLabel,
  };
}

function setSyncConfig(partial) {
  const cfg = loadConfig();
  const map = { enabled: "syncEnabled", dir: "syncDir", deviceLabel: "deviceLabel" };
  for (const k of Object.keys(partial || {})) {
    if (map[k]) cfg[map[k]] = partial[k];
  }
  saveConfig(cfg);
}

function getSafeBrowsingKey() {
  const cfg = loadConfig();
  return typeof cfg.safeBrowsingKey === "string" ? cfg.safeBrowsingKey : "";
}

function setSafeBrowsingKey(key) {
  const cfg = loadConfig();
  cfg.safeBrowsingKey = typeof key === "string" ? key.trim() : "";
  saveConfig(cfg);
}

module.exports = {
  appDataDir,
  configPath,
  loadConfig,
  saveConfig,
  defaultStoreDir,
  fallbackStoreDir,
  isWritableDir,
  getStorePath,
  setStorePath,
  getSyncConfig,
  ensureSyncConfig,
  setSyncConfig,
  getSafeBrowsingKey,
  setSafeBrowsingKey,
};
