// tests/auto-update.test.js — in-app auto-update (electron-updater against the private
// repo via a user-supplied read-only token). Critically: the token is a credential and
// must NEVER sync (like the provider/OPR keys). Real db asserts + source asserts.
const assert = require("assert");
const fs = require("fs"), path = require("path"), os = require("os");
const db = require("../core/db.js");

let pass = 0, fail = 0;
function run(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }
function newDb() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-upd-")); fs.mkdirSync(path.join(dir, "images"), { recursive: true }); return db.openDb(dir); }

// --- Security: the update token must never leave the machine ---
run("settingsForSync strips updateToken (credential never syncs)", () => {
  const d = newDb();
  db.setKV(d, "ia_settings", JSON.stringify({ about: "me", updateToken: "github_pat_SECRET", keys: { openrouter: "K" } }));
  const s = db.settingsForSync(d);
  assert.ok(!("updateToken" in s.data), "updateToken must NOT be in the synced blob");
  assert.strictEqual(s.data.about, "me");
});

run("applySyncedSettings preserves this device's own updateToken", () => {
  const d = newDb();
  db.setKV(d, "ia_settings", JSON.stringify({ about: "old", updateToken: "github_pat_LOCAL" }));
  db.applySyncedSettings(d, { about: "new" }, 3000);   // incoming has no token
  const merged = JSON.parse(db.getKV(d, "ia_settings"));
  assert.strictEqual(merged.about, "new");
  assert.strictEqual(merged.updateToken, "github_pat_LOCAL", "local token preserved across a sync apply");
});

// --- Wiring: preload bridge, main handler, renderer flow ---
const preload = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pkg = require("../package.json");

ok("preload exposes checkUpdates/installUpdate/onUpdateStatus", /checkUpdates:/.test(preload) && /installUpdate:/.test(preload) && /onUpdateStatus:/.test(preload));
ok("main guards dev (app.isPackaged) before checking", /ia:check-updates[\s\S]{0,120}?app\.isPackaged/.test(main));
ok("main requires a non-empty token", /ia:check-updates[\s\S]{0,220}?no-token/.test(main));
ok("main feeds the private GitHub repo with the passed token", /setFeedURL\(\{[\s\S]{0,120}?private:\s*true[\s\S]{0,60}?token:/.test(main));
ok("main installs via quitAndInstall", /ia:install-update[\s\S]{0,120}?quitAndInstall/.test(main));
ok("renderer checkForUpdates uses the native updater when present", /window\.ia && window\.ia\.checkUpdates/.test(html));
ok("renderer falls back to the releases page without a token/updater", /openReleasesPage\(\)/.test(html));
ok("renderer registers an update-status listener", /onUpdateStatus\(function/.test(html));

// --- Build/CI: electron-updater dep + publish config + latest.yml on the release ---
ok("electron-updater is a runtime dependency", !!(pkg.dependencies && pkg.dependencies["electron-updater"]));
ok("build.publish points at the GitHub repo (generates latest.yml/app-update.yml)", Array.isArray(pkg.build.publish) && pkg.build.publish[0].provider === "github");
const ci = fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "release.yml"), "utf8");
ok("CI attaches latest.yml + blockmap to the release", /dist\/latest\.yml/.test(ci) && /\.exe\.blockmap/.test(ci));

console.log("auto-update: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
