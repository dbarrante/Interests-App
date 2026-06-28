// Verifies backups resolve to the user's REAL Dropbox root (which may be on any
// drive, e.g. D:\Dropbox) via Dropbox's info.json — not a hardcoded
// %USERPROFILE%\Dropbox. Isolated via temp APPDATA/LOCALAPPDATA.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const orig = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };

const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), "ia-ad-"));
process.env.APPDATA = tmpAppData; // isolate config (no stray config.backupDir)

const tmpLocal = fs.mkdtempSync(path.join(os.tmpdir(), "ia-la-"));
const fakeDropbox = fs.mkdtempSync(path.join(os.tmpdir(), "ia-dropbox-"));
fs.mkdirSync(path.join(tmpLocal, "Dropbox"), { recursive: true });
fs.writeFileSync(
  path.join(tmpLocal, "Dropbox", "info.json"),
  JSON.stringify({ personal: { path: fakeDropbox, is_team: false } })
);
process.env.LOCALAPPDATA = tmpLocal;

const backup = require("../core/backup");
const config = require("../core/config");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

t("dropboxBackupDir auto-detects the real Dropbox root from info.json", () => {
  assert.strictEqual(backup.dropboxBackupDir(), path.join(fakeDropbox, "Interests App", "backups"));
});

t("config.backupDir overrides detection", () => {
  config.saveConfig(Object.assign({}, config.loadConfig(), { backupDir: "X:/custom/backups" }));
  assert.strictEqual(backup.dropboxBackupDir(), "X:/custom/backups");
  const c = config.loadConfig(); delete c.backupDir; config.saveConfig(c);
  assert.strictEqual(backup.dropboxBackupDir(), path.join(fakeDropbox, "Interests App", "backups"));
});

process.env.APPDATA = orig.APPDATA;
process.env.LOCALAPPDATA = orig.LOCALAPPDATA;
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
