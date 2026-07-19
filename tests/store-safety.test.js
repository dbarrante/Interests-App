// tests/store-safety.test.js — 2026-07-17 incident hardening guards:
// isTempPath / evaluateStoreSafety / lastCounts persistence / backupDir
// temp-poison rejection.
//
// APPDATA ISOLATION (hard rule from the 07-17 incident): this test WRITES
// config.json via core/config, so it must never see the real %APPDATA%.
// Self-isolates BEFORE requiring core modules; tests/run.js adds a blanket
// throwaway APPDATA for children as well.
const fs = require("fs");
const os = require("os");
const path = require("path");
const APPDATA_FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), "ia-safety-appdata-"));
process.env.APPDATA = APPDATA_FIXTURE;

const assert = require("assert");
const config = require("../core/config.js");

let passed = 0, failed = 0;
function t(n, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + n + "\n  " + (e && e.stack || e)); } }

const TMP = os.tmpdir();

/* ---------- isTempPath ---------- */
t("isTempPath: a dir inside os.tmpdir() is temp", () => {
  assert.strictEqual(config.isTempPath(path.join(TMP, "ia-mv-dst-123", "data")), true);
});
t("isTempPath: os.tmpdir() itself is temp", () => {
  assert.strictEqual(config.isTempPath(TMP), true);
});
t("isTempPath: a normal profile path is NOT temp", () => {
  assert.strictEqual(config.isTempPath("C:\\Users\\u\\AppData\\Roaming\\Interests App\\data"), false);
});
t("isTempPath: prefix cousin dir does NOT count (Temp2 vs Temp)", () => {
  assert.strictEqual(config.isTempPath(TMP + "2" + path.sep + "x"), false);
});
t("isTempPath: case-insensitive on win32", function () {
  if (process.platform !== "win32") return;
  assert.strictEqual(config.isTempPath(path.join(TMP.toUpperCase(), "sub")), true);
});
t("isTempPath: null/empty/non-string -> false, no throw", () => {
  assert.strictEqual(config.isTempPath(null), false);
  assert.strictEqual(config.isTempPath(""), false);
  assert.strictEqual(config.isTempPath(42), false);
});
t("isTempPath: injectable tmpdir for tests", () => {
  assert.strictEqual(config.isTempPath("/fake/tmp/x", "/fake/tmp"), true);
  assert.strictEqual(config.isTempPath("/real/data", "/fake/tmp"), false);
});

/* ---------- evaluateStoreSafety ---------- */
t("safety: healthy store, no lastCounts -> ok", () => {
  const s = config.evaluateStoreSafety({ storeDir: "D:\\app\\data", counts: { cards: 6000, saved: 180 }, lastCounts: null });
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.tempStore, false);
  assert.strictEqual(s.collapsedCounts, null);
});
t("safety: temp store flagged", () => {
  const s = config.evaluateStoreSafety({ storeDir: path.join(TMP, "ia-fixture"), counts: { cards: 2, saved: 0 }, lastCounts: null });
  assert.strictEqual(s.tempStore, true);
  assert.strictEqual(s.ok, false);
});
t("safety: collapsed counts flagged (2 cards vs 6673 recorded — the incident shape)", () => {
  const s = config.evaluateStoreSafety({ storeDir: "D:\\app\\data", counts: { cards: 2, saved: 0 }, lastCounts: { cards: 6673, saved: 187, at: 1 } });
  assert.ok(s.collapsedCounts, "flagged");
  assert.strictEqual(s.collapsedCounts.nowCards, 2);
  assert.strictEqual(s.collapsedCounts.lastCards, 6673);
  assert.strictEqual(s.ok, false);
});
t("safety: a small library is never flagged as collapsed (record < 100 cards)", () => {
  const s = config.evaluateStoreSafety({ storeDir: "D:\\app\\data", counts: { cards: 3, saved: 0 }, lastCounts: { cards: 90, saved: 0, at: 1 } });
  assert.strictEqual(s.collapsedCounts, null);
  assert.strictEqual(s.ok, true);
});
t("safety: normal shrinkage (user deletions) not flagged — 10% threshold", () => {
  const s = config.evaluateStoreSafety({ storeDir: "D:\\app\\data", counts: { cards: 5000, saved: 100 }, lastCounts: { cards: 6673, saved: 187, at: 1 } });
  assert.strictEqual(s.collapsedCounts, null);
});

/* ---------- lastCounts persistence (isolated APPDATA) ---------- */
t("recordLastCounts/getLastCounts round-trip via the DEDICATED sidecar file", () => {
  config.recordLastCounts({ cards: 6673, saved: 187 });
  const lc = config.getLastCounts();
  assert.strictEqual(lc.cards, 6673);
  assert.strictEqual(lc.saved, 187);
  assert.ok(lc.at > 0, "timestamped");
  const onDisk = JSON.parse(fs.readFileSync(path.join(config.appDataDir(), "lastcounts.json"), "utf8"));
  assert.strictEqual(onDisk.cards, 6673, "persisted outside the store, in its own file");
});
t("REVIEW HIGH: recordLastCounts NEVER rewrites config.json (worker-thread race guard)", () => {
  // runBackup runs on the sync worker thread; a whole-config read-modify-write
  // there could revert a concurrent main-thread setStorePath (incident class).
  config.saveConfig(Object.assign({}, config.loadConfig(), { storePath: "D:\\somewhere\\data" }));
  const before = fs.readFileSync(config.configPath(), "utf8");
  config.recordLastCounts({ cards: 1, saved: 1 });
  const after = fs.readFileSync(config.configPath(), "utf8");
  assert.strictEqual(after, before, "config.json byte-identical across recordLastCounts");
  const src = fs.readFileSync(path.join(__dirname, "..", "core", "config.js"), "utf8");
  const body = src.slice(src.indexOf("function recordLastCounts"), src.indexOf("function getLastCounts"));
  assert.ok(!/loadConfig|saveConfig/.test(body), "no config.json read-modify-write in recordLastCounts");
});

/* ---------- backupDir temp-poison rejection (SANDBOX-AWARE) ----------
   Production (real %APPDATA%): a temp backupDir is a poisoned pointer — ignored.
   Sandbox (APPDATA itself under temp, i.e. an isolated test): a temp backupDir
   is exactly right and MUST be honored — the first version of this guard
   redirected a sandboxed test's backup writes into the REAL Dropbox backups
   folder (live 2026-07-19: overwrote the day's real backup with a fixture db).
   This test process IS sandboxed, so the honored branch is what we can
   exercise live; the production branch is locked by source asserts. */
t("SANDBOX: a temp backupDir is HONORED when APPDATA is itself isolated under temp", () => {
  const sandboxDir = path.join(TMP, "ia-sandbox-backups-" + process.pid);
  config.saveConfig(Object.assign({}, config.loadConfig(), { backupDir: sandboxDir }));
  delete require.cache[require.resolve("../core/backup.js")];
  const backup = require("../core/backup.js");
  assert.strictEqual(path.resolve(backup.dropboxBackupDir()), path.resolve(sandboxDir),
    "sandboxed tests must NEVER be redirected toward the real Dropbox folder");
});
t("PRODUCTION guard locked in source: temp backupDir ignored only when NOT sandboxed", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "core", "backup.js"), "utf8");
  assert.ok(/const sandboxed = isTempPath\(appDataDir\(\)\);/.test(src), "sandbox detection present");
  assert.ok(/cfg\.backupDir && !sandboxed && isTempPath\(cfg\.backupDir\)/.test(src), "guard fires only outside sandbox");
  assert.ok(/else if \(cfg\.backupDir\) return cfg\.backupDir;/.test(src), "legitimate configured dir honored");
});

/* ---------- wiring source-asserts ---------- */
t("runBackup records lastCounts to config.json after a successful backup", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "core", "backup.js"), "utf8");
  assert.ok(/recordLastCounts\(\{ cards: cnt\.imported, saved: cnt\.saved \}\)/.test(src));
});
t("/api/health exposes the safety evaluation", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "core", "server.js"), "utf8");
  assert.ok(/evaluateStoreSafety\(\{/.test(src) && /safety/.test(src));
});
t("main.js boot guard: blocking dialog, Quit is default, no auto-heal", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert.ok(/evaluateStoreSafety\(\{/.test(src), "evaluates at boot");
  assert.ok(/showMessageBoxSync\(\{/.test(src), "blocking dialog");
  assert.ok(/"Quit \(recommended\)", "Continue anyway"/.test(src), "quit-first buttons");
  assert.ok(/defaultId: 0, cancelId: 0/.test(src), "Quit is the default AND the escape");
  assert.ok(!/setStorePath|saveConfig\(.*storePath/.test(src.slice(src.indexOf("evaluateStoreSafety"), src.indexOf("evaluateStoreSafety") + 2500)), "guard never rewrites the pointer");
});

console.log("store-safety: " + passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
