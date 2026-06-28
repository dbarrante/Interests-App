const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path");
const sync = require("../core/sync");
const dbm = require("../core/db");
let passed = 0, failed = 0;
function test(n, fn){ try{ fn(); passed++; }catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }
function tmp(){ return fs.mkdtempSync(path.join(os.tmpdir(), "ia-snap-")); }
function tmpStore(){ const d = fs.mkdtempSync(path.join(os.tmpdir(),"ia-store-")); fs.mkdirSync(path.join(d,"images"),{recursive:true}); return d; }

test("peerDirs lists other device folders, excluding self and non-dirs", () => {
  const syncDir = tmp();
  fs.mkdirSync(path.join(syncDir, "dev_A"));
  fs.mkdirSync(path.join(syncDir, "dev_B"));
  fs.writeFileSync(path.join(syncDir, "notadir.txt"), "x");
  const peers = sync.peerDirs(syncDir, "dev_A").map(p => p.deviceId).sort();
  assert.deepStrictEqual(peers, ["dev_B"]);
});

test("publishSnapshot writes meta.json last; readSnapshot round-trips", () => {
  const store = tmpStore(); const d = dbm.openDb(store);
  dbm.upsertCard(d, { id: "c_1", url: "https://a.com" });
  const ctx = { db: d, storeDir: store };
  const syncDir = tmp();
  sync.publishSnapshot(ctx, syncDir, "dev_A", "Desktop");
  const folder = path.join(syncDir, "dev_A");
  assert.ok(fs.existsSync(path.join(folder, "meta.json")), "meta.json present");
  const snap = sync.readSnapshot(folder);
  assert.ok(snap && snap.cards.length === 1 && snap.deviceId === "dev_A");
  d.close();
});

test("readSnapshot rejects a snapshot missing meta.json (incomplete)", () => {
  const store = tmpStore(); const d = dbm.openDb(store);
  dbm.upsertCard(d, { id: "c_1", url: "https://a.com" });
  const ctx = { db: d, storeDir: store };
  const syncDir = tmp();
  sync.publishSnapshot(ctx, syncDir, "dev_A", "Desktop");
  fs.rmSync(path.join(syncDir, "dev_A", "meta.json"));     // simulate a torn write
  assert.strictEqual(sync.readSnapshot(path.join(syncDir, "dev_A")), null);
  d.close();
});

test("device A merges in device B's card + image", () => {
  const syncDir = tmp();
  // B publishes a card with an image file.
  const storeB = tmpStore(); const dB = dbm.openDb(storeB);
  dbm.upsertCard(dB, { id: "c_B", url: "https://b.com", img: "idb:c_B" });
  fs.writeFileSync(path.join(storeB, "images", "c_B.jpg"), "JPGBYTES");
  sync.publishSnapshot({ db: dB, storeDir: storeB }, syncDir, "dev_B", "Laptop"); dB.close();
  // A runs a sync.
  const storeA = tmpStore(); const dA = dbm.openDb(storeA);
  const res = sync.runSync({ db: dA, storeDir: storeA }, { syncDir, deviceId: "dev_A", deviceLabel: "Desktop", publish: true, backupFn: function () {} });
  assert.ok(res.changed, "merge changed local data");
  assert.ok(dbm.allCards(dA).some(c => c.id === "c_B"), "B's card merged into A");
  assert.ok(fs.existsSync(path.join(storeA, "images", "c_B.jpg")), "B's image copied to A");
  dA.close();
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
