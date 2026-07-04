// tests/sync-settings.test.js — cross-device settings sync (secrets excluded, LWW merge).
const assert = require("assert");
const fs = require("fs"), path = require("path"), os = require("os");
const db = require("../core/db.js");
const { mergeSnapshots } = require("../core/merge.js");

let pass = 0, fail = 0;
function run(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }
function newDb() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-syncset-")); fs.mkdirSync(path.join(dir, "images"), { recursive: true }); return db.openDb(dir); }

run("settingsForSync strips keys + oprKey, keeps the rest, reads updatedAt", () => {
  const d = newDb();
  db.setKV(d, "ia_settings", JSON.stringify({ about: "me", interests: "x", weights: { personal: 8 }, keys: { openrouter: "SECRET" }, oprKey: "OPRSECRET" }));
  db.setKV(d, "ia_settings_updatedAt", "1700");
  const s = db.settingsForSync(d);
  assert.strictEqual(s.updatedAt, 1700);
  assert.strictEqual(s.data.about, "me");
  assert.strictEqual(s.data.weights.personal, 8);
  assert.ok(!("keys" in s.data), "provider keys must NOT sync");
  assert.ok(!("oprKey" in s.data), "OPR key must NOT sync");
});

run("settingsForSync on an empty store → nothing to sync", () => {
  const d = newDb();
  const s = db.settingsForSync(d);
  assert.strictEqual(s.data, null);
  assert.strictEqual(s.updatedAt, 0);
});

run("applySyncedSettings overlays incoming but PRESERVES local keys/oprKey + bumps stamp", () => {
  const d = newDb();
  db.setKV(d, "ia_settings", JSON.stringify({ about: "old", provider: "openrouter", keys: { openrouter: "MYKEY" }, oprKey: "MYOPR" }));
  db.applySyncedSettings(d, { about: "new", interests: "synced", provider: "openrouter" }, 2000);
  const merged = JSON.parse(db.getKV(d, "ia_settings"));
  assert.strictEqual(merged.about, "new");
  assert.strictEqual(merged.interests, "synced");
  assert.strictEqual(merged.keys.openrouter, "MYKEY", "local provider key preserved");
  assert.strictEqual(merged.oprKey, "MYOPR", "local OPR key preserved");
  assert.strictEqual(db.getKV(d, "ia_settings_updatedAt"), "2000");
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
run("END-TO-END: device A's settings publish + merge into device B; secrets never travel; B keeps its own key", () => {
  const rootd = fs.mkdtempSync(path.join(os.tmpdir(), "ia-synce2e-"));
  const storeA = path.join(rootd, "A"); fs.mkdirSync(path.join(storeA, "images"), { recursive: true });
  const storeB = path.join(rootd, "B"); fs.mkdirSync(path.join(storeB, "images"), { recursive: true });
  const syncDir = path.join(rootd, "sync"); fs.mkdirSync(syncDir, { recursive: true });
  const ctxA = { db: db.openDb(storeA), storeDir: storeA };
  const ctxB = { db: db.openDb(storeB), storeDir: storeB };
  db.setKV(ctxA.db, "ia_settings", JSON.stringify({ about: "A about", interests: "woodworking", keys: { openrouter: "AKEY_SECRET" }, oprKey: "AOPR_SECRET" }));
  db.setKV(ctxA.db, "ia_settings_updatedAt", "5000");
  db.setKV(ctxB.db, "ia_settings", JSON.stringify({ about: "B old", keys: { openrouter: "BKEY" } }));
  db.setKV(ctxB.db, "ia_settings_updatedAt", "1000");

  sync.runSync(ctxA, { syncDir: syncDir, deviceId: "devA", deviceLabel: "A", backupFn: function () {} });
  // (1) the published snapshot carries settings but NO secrets
  const snapRaw = fs.readFileSync(path.join(syncDir, "devA", "snapshot.json"), "utf8");
  assert.ok(snapRaw.indexOf("A about") >= 0, "published snapshot must include settings (regression: was omitted → no-op)");
  assert.ok(snapRaw.indexOf("AKEY_SECRET") < 0, "provider key must NEVER be published");
  assert.ok(snapRaw.indexOf("AOPR_SECRET") < 0, "OPR key must NEVER be published");

  sync.runSync(ctxB, { syncDir: syncDir, deviceId: "devB", deviceLabel: "B", backupFn: function () {} });
  const bSettings = JSON.parse(db.getKV(ctxB.db, "ia_settings"));
  assert.strictEqual(bSettings.about, "A about", "A's newer settings propagated to B");
  assert.strictEqual(bSettings.interests, "woodworking");
  assert.strictEqual(bSettings.keys.openrouter, "BKEY", "B kept its OWN provider key (keys never sync)");
});

console.log("sync-settings: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
