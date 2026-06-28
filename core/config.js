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

function saveConfig(obj) {
  fs.mkdirSync(appDataDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(obj || {}, null, 2), "utf8");
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

function getSyncConfig() {
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
  setSyncConfig,
};
