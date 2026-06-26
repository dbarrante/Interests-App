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

function getStorePath() {
  const cfg = loadConfig();
  const dir = cfg.storePath || defaultStoreDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}

function setStorePath(p) {
  const cfg = loadConfig();
  cfg.storePath = p;
  saveConfig(cfg);
}

module.exports = {
  appDataDir,
  configPath,
  loadConfig,
  saveConfig,
  defaultStoreDir,
  getStorePath,
  setStorePath,
};
