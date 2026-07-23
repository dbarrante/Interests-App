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

// --- Pairing token (DORMANT auth scaffolding for a future LAN mode) ---
// A 32-byte random token a future phone client would present as
// `Authorization: Bearer <token>` once LAN serving is enabled. It is NOT
// generated at startup — ensurePairingToken() is called only on first future
// use (the day lanEnabled is flipped and the bind address changes). Until then
// getPairingToken() returns null and the Bearer middleware is a pass-through.
function ensurePairingToken() {
  const cfg = loadConfig();
  if (!cfg.pairingToken) {
    cfg.pairingToken = require("crypto").randomBytes(32).toString("hex");
    saveConfig(cfg);   // persisted once via the atomic saveConfig
  }
  return cfg.pairingToken;
}

// Pure read: returns the persisted pairing token, or null if it has never been
// generated. Never writes — safe to call on every request.
function getPairingToken() {
  const cfg = loadConfig();
  return typeof cfg.pairingToken === "string" && cfg.pairingToken ? cfg.pairingToken : null;
}

function setPairingRequired(required) {
  const cfg = loadConfig();
  cfg.extensionPairingRequired = !!required;
  if (required && !cfg.pairingToken) cfg.pairingToken = require("crypto").randomBytes(32).toString("hex");
  saveConfig(cfg);
}

// --- Store-safety guards (2026-07-17 incident hardening) --------------------
// Killed test runs once left config.json's storePath/backupDir pointing at
// throwaway %TEMP% fixture dirs; the next app restart silently booted on a
// 2-card fixture store and daily backups landed in temp. These helpers let
// boot (main.js + /api/health) and backup resolution refuse/flag that state.

// True when p is os.tmpdir() itself or any path inside it. Case-insensitive
// on win32 (C:\Users\X\AppData\Local\Temp vs c:\users\...). tmpdirOverride is
// for tests only.
function isTempPath(p, tmpdirOverride) {
  if (!p || typeof p !== "string") return false;
  let tmp = tmpdirOverride || require("os").tmpdir();
  let a = path.resolve(String(p)), b = path.resolve(tmp);
  if (process.platform === "win32") { a = a.toLowerCase(); b = b.toLowerCase(); }
  return a === b || a.startsWith(b + path.sep);
}

// Last-known-healthy library counts, persisted OUTSIDE the store precisely so
// a swapped-in fixture store can't vouch for itself. Written after each
// successful backup (core/backup.js).
//
// OWN SIDECAR FILE (%APPDATA%\Interests App\lastcounts.json), deliberately
// NOT config.json (data-safety review 2026-07-19, HIGH): runBackup also runs
// on the SYNC WORKER thread, and a read-modify-write of the whole config.json
// there can race a main-thread setStorePath/setSyncConfig — last-writer-wins
// on the whole document could silently REVERT the store pointer (the exact
// incident class this feature guards against). A dedicated file whose only
// content is the counts record makes concurrent whole-file overwrites
// harmless. Tmp sidecar name includes pid + a random suffix because worker
// threads SHARE process.pid.
function lastCountsPath() {
  return path.join(appDataDir(), "lastcounts.json");
}
function recordLastCounts(counts) {
  fs.mkdirSync(appDataDir(), { recursive: true });
  const target = lastCountsPath();
  const tmpFile = target + ".tmp." + process.pid + "." + Math.random().toString(36).slice(2, 8);
  const rec = {
    cards: (counts && counts.cards) | 0,
    saved: (counts && counts.saved) | 0,
    at: Date.now(),
  };
  fs.writeFileSync(tmpFile, JSON.stringify(rec), "utf8");
  try { fs.renameSync(tmpFile, target); }
  catch (e) { try { fs.unlinkSync(tmpFile); } catch (_) {} throw e; }
}
function getLastCounts() {
  try {
    const rec = JSON.parse(fs.readFileSync(lastCountsPath(), "utf8"));
    return rec && typeof rec === "object" ? rec : null;
  } catch (_) { return null; }
}

// Pure evaluation of boot-time store safety. Flags, never fixes: the caller
// (main.js dialog / /api/health) surfaces the state and the HUMAN decides —
// auto-"healing" either direction can freeze real data (the 07-16 incident's
// temp store WAS the healthy one for a day).
//   tempStore:      the live store dir sits under os.tmpdir()
//   collapsedCounts: cards collapsed to <10% of the last-backup record
//                    (only when the record is substantial — >=100 cards)
function evaluateStoreSafety(opts) {
  opts = opts || {};
  const tempStore = isTempPath(opts.storeDir, opts.tmpdir);
  let collapsedCounts = null;
  const last = opts.lastCounts;
  const now = opts.counts;
  if (last && now && (last.cards | 0) >= 100 && (now.cards | 0) < (last.cards | 0) * 0.1) {
    collapsedCounts = { nowCards: now.cards | 0, lastCards: last.cards | 0, lastAt: last.at || 0 };
  }
  return { tempStore: tempStore, collapsedCounts: collapsedCounts, ok: !tempStore && !collapsedCounts };
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
  ensurePairingToken,
  getPairingToken,
  setPairingRequired,
  getSafeBrowsingKey,
  setSafeBrowsingKey,
  isTempPath,
  recordLastCounts,
  getLastCounts,
  evaluateStoreSafety,
};
