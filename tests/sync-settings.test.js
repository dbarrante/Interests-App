// tests/sync-settings.test.js — cross-device settings sync (keys union-merge, updateToken local-only, LWW merge).
const assert = require("assert");
const fs = require("fs"), path = require("path"), os = require("os");
const db = require("../core/db.js");
const { mergeSnapshots } = require("../core/merge.js");

let pass = 0, fail = 0;
function run(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }
function newDb() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-syncset-")); fs.mkdirSync(path.join(dir, "images"), { recursive: true }); return db.openDb(dir); }

run("settingsForSync keeps keys + oprKey (they sync now), strips only updateToken, reads updatedAt", () => {
  const d = newDb();
  db.setKV(d, "ia_settings", JSON.stringify({ about: "me", interests: "x", weights: { personal: 8 }, keys: { openrouter: "ORKEY" }, oprKey: "OPRKEY", updateToken: "GH_LOCAL" }));
  db.setKV(d, "ia_settings_updatedAt", "1700");
  const s = db.settingsForSync(d);
  assert.strictEqual(s.updatedAt, 1700);
  assert.strictEqual(s.data.about, "me");
  assert.strictEqual(s.data.weights.personal, 8);
  assert.strictEqual(s.data.keys.openrouter, "ORKEY", "provider keys sync (2026-07-16 decision)");
  assert.strictEqual(s.data.oprKey, "OPRKEY", "OPR key syncs (2026-07-16 decision)");
  assert.ok(!("updateToken" in s.data), "GitHub update token must NEVER sync");
});

run("settingsForSync on an empty store → nothing to sync", () => {
  const d = newDb();
  const s = db.settingsForSync(d);
  assert.strictEqual(s.data, null);
  assert.strictEqual(s.updatedAt, 0);
});

run("applySyncedSettings union-merges keys: incoming wins per provider, local-only survives, stamp bumps", () => {
  const d = newDb();
  db.setKV(d, "ia_settings", JSON.stringify({ about: "old", keys: { openrouter: "MYKEY", groq: "MYGROQ" }, oprKey: "MYOPR", updateToken: "GH_LOCAL" }));
  db.applySyncedSettings(d, { about: "new", keys: { openrouter: "PEERKEY", gemini: "PEERGEM" }, oprKey: "", updateToken: "PEER_GH_MUST_NOT_LAND" }, 2000);
  const merged = JSON.parse(db.getKV(d, "ia_settings"));
  assert.strictEqual(merged.about, "new");
  assert.strictEqual(merged.keys.openrouter, "PEERKEY", "incoming provider key wins");
  assert.strictEqual(merged.keys.groq, "MYGROQ", "local-only provider key survives");
  assert.strictEqual(merged.keys.gemini, "PEERGEM", "new provider key arrives");
  assert.strictEqual(merged.oprKey, "MYOPR", "empty incoming oprKey doesn't clobber");
  assert.strictEqual(merged.updateToken, "GH_LOCAL", "updateToken always local");
  assert.strictEqual(db.getKV(d, "ia_settings_updatedAt"), "2000");
});

run("applySyncedSettings: a fresh device's keyless blob can't wipe local keys", () => {
  const d = newDb();
  db.setKV(d, "ia_settings", JSON.stringify({ keys: { openrouter: "MYKEY" } }));
  db.applySyncedSettings(d, { about: "fresh device edit" }, 3000);
  const merged = JSON.parse(db.getKV(d, "ia_settings"));
  assert.strictEqual(merged.keys.openrouter, "MYKEY");
});

function lib(settings) { return { cards: {}, saved: {}, tombstones: {}, settings: settings }; }
function peer(settings) { return { cards: [], saved: [], tombstones: [], settings: settings }; }

run("mergeSnapshots: a strictly-newer peer's settings win", () => {
  const out = mergeSnapshots(lib({ data: { about: "local" }, updatedAt: 100 }), [peer({ data: { about: "peer" }, updatedAt: 200 })]);
  assert.ok(out.settings, "plan carries settings");
  assert.strictEqual(out.settings.data.about, "peer");
  assert.strictEqual(out.settings.updatedAt, 200);
});

run("mergeSnapshots: older or equal peer settings do NOT clobber local", () => {
  assert.ok(!mergeSnapshots(lib({ data: { about: "local" }, updatedAt: 300 }), [peer({ data: { about: "peer" }, updatedAt: 200 })]).settings, "older ignored");
  assert.ok(!mergeSnapshots(lib({ data: { about: "local" }, updatedAt: 300 }), [peer({ data: { about: "peer" }, updatedAt: 300 })]).settings, "equal ignored (local wins ties)");
});

run("mergeSnapshots: peer with null settings data is ignored; picks newest across peers", () => {
  assert.ok(!mergeSnapshots(lib({ data: { about: "local" }, updatedAt: 100 }), [peer({ data: null, updatedAt: 999 })]).settings, "null-data ignored");
  const out = mergeSnapshots(lib({ data: { about: "local" }, updatedAt: 100 }), [peer({ data: { about: "p1" }, updatedAt: 150 }), peer({ data: { about: "p2" }, updatedAt: 250 })]);
  assert.strictEqual(out.settings.data.about, "p2", "newest peer wins");
});

const sync = require("../core/sync.js");
run("END-TO-END: A's settings+keys publish and merge into B; B-only key survives; updateToken never travels", () => {
  const rootd = fs.mkdtempSync(path.join(os.tmpdir(), "ia-synce2e-"));
  const storeA = path.join(rootd, "A"); fs.mkdirSync(path.join(storeA, "images"), { recursive: true });
  const storeB = path.join(rootd, "B"); fs.mkdirSync(path.join(storeB, "images"), { recursive: true });
  const syncDir = path.join(rootd, "sync"); fs.mkdirSync(syncDir, { recursive: true });
  const ctxA = { db: db.openDb(storeA), storeDir: storeA };
  const ctxB = { db: db.openDb(storeB), storeDir: storeB };
  db.setKV(ctxA.db, "ia_settings", JSON.stringify({ about: "A about", interests: "woodworking", keys: { openrouter: "AKEY" }, oprKey: "AOPR", updateToken: "A_GH_TOKEN" }));
  db.setKV(ctxA.db, "ia_settings_updatedAt", "5000");
  db.setKV(ctxB.db, "ia_settings", JSON.stringify({ about: "B old", keys: { groq: "B_GROQ_ONLY" } }));
  db.setKV(ctxB.db, "ia_settings_updatedAt", "1000");

  sync.runSync(ctxA, { syncDir: syncDir, deviceId: "devA", deviceLabel: "A", backupFn: function () {} });
  const snapRaw = fs.readFileSync(path.join(syncDir, "devA", "snapshot.json"), "utf8");
  assert.ok(snapRaw.indexOf("A about") >= 0, "published snapshot must include settings");
  assert.ok(snapRaw.indexOf("AKEY") >= 0, "provider key must publish (2026-07-16 decision)");
  assert.ok(snapRaw.indexOf("AOPR") >= 0, "OPR key must publish");
  assert.ok(snapRaw.indexOf("A_GH_TOKEN") < 0, "updateToken must NEVER be published");

  sync.runSync(ctxB, { syncDir: syncDir, deviceId: "devB", deviceLabel: "B", backupFn: function () {} });
  const bSettings = JSON.parse(db.getKV(ctxB.db, "ia_settings"));
  assert.strictEqual(bSettings.about, "A about", "A's newer settings propagated to B");
  assert.strictEqual(bSettings.keys.openrouter, "AKEY", "A's provider key arrived on B");
  assert.strictEqual(bSettings.keys.groq, "B_GROQ_ONLY", "B's own key survived the merge");
  assert.ok(!("updateToken" in bSettings), "no updateToken landed on B");
});

console.log("sync-settings: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
