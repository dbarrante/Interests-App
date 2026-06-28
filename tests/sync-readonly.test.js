const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path");
const dbm = require("../core/db");
const sync = require("../core/sync");
let passed = 0, failed = 0;
function test(n, fn){ try{ fn(); passed++; }catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }
function tmpStore(){ const d = fs.mkdtempSync(path.join(os.tmpdir(),"ia-ro-")); fs.mkdirSync(path.join(d,"images"),{recursive:true}); return d; }
function snapshotTree(dir){ const out = {}; (function walk(d, rel){ for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const st = fs.statSync(p); const r = rel + "/" + n; if (st.isDirectory()) walk(p, r); else out[r] = st.mtimeMs + ":" + st.size; } })(dir, ""); return out; }

test("runSync never writes inside a peer's folder (read-only on peers)", () => {
  const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-dbx-"));
  // Peer B publishes a snapshot we will read.
  const storeB = tmpStore(); const dB = dbm.openDb(storeB);
  dbm.upsertCard(dB, { id: "c_B", url: "https://b.com" });
  sync.publishSnapshot({ db: dB, storeDir: storeB }, syncDir, "dev_B", "Laptop"); dB.close();
  const before = snapshotTree(path.join(syncDir, "dev_B"));
  // Device A runs a sync.
  const storeA = tmpStore(); const dA = dbm.openDb(storeA);
  sync.runSync({ db: dA, storeDir: storeA }, { syncDir: syncDir, deviceId: "dev_A", deviceLabel: "Desktop", publish: true, backupFn: function () {} });
  const after = snapshotTree(path.join(syncDir, "dev_B"));
  assert.deepStrictEqual(after, before, "peer folder must be untouched");
  dA.close();
});

// Hand-craft a peer folder (NOT via publishSnapshot) so we control the raw
// snapshot.json/meta.json bytes — including a poison id and a lying deviceId.
function writePeerFolder(syncDir, folderName, snapshot, counts) {
  const folder = path.join(syncDir, folderName);
  fs.mkdirSync(path.join(folder, "images"), { recursive: true });
  fs.writeFileSync(path.join(folder, "snapshot.json"), JSON.stringify(snapshot));
  fs.writeFileSync(path.join(folder, "meta.json"), JSON.stringify({
    schemaVersion: snapshot.schemaVersion,
    deviceId: snapshot.deviceId,
    deviceLabel: snapshot.deviceLabel,
    publishedAt: snapshot.publishedAt,
    counts: counts,
  }));
  return folder;
}

test("runSync skips a peer card with an unsafe id (poison), still applies a safe one, never throws", () => {
  const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-dbx-"));
  const now = Date.now();
  // Peer folder: TWO cards — one with an unsafe id (+ idb image ref), one safe.
  writePeerFolder(syncDir, "dev_P", {
    schemaVersion: dbm.SCHEMA_VERSION,
    deviceId: "dev_P",
    deviceLabel: "Poison",
    publishedAt: now,
    cards: [
      { id: "bad id", url: "https://bad.com", img: "idb:bad id", updatedAt: now },
      { id: "c_ok", url: "https://ok.com", updatedAt: now },
    ],
    saved: [],
    fp: {},
    tombstones: [],
  }, { cards: 2, saved: 0, images: 0 });

  const storeA = tmpStore(); const dA = dbm.openDb(storeA);
  assert.doesNotThrow(function () {
    sync.runSync({ db: dA, storeDir: storeA }, {
      syncDir: syncDir, deviceId: "dev_A", deviceLabel: "Desktop",
      publish: true, backupFn: function () {},
    });
  }, "runSync must not throw on a poison peer id");

  const cards = dbm.allCards(dA);
  assert.ok(cards.some(c => c.id === "c_ok"), "safe card c_ok must be applied");
  assert.ok(!cards.some(c => c.id === "bad id"), "card with unsafe id must NOT be applied");
  // No unsafe-named image file leaked into the local store.
  const imgs = fs.readdirSync(path.join(storeA, "images"));
  assert.ok(!imgs.some(n => /[^A-Za-z0-9_.\-]/.test(n)), "no unsafe-named image file written locally");
  assert.ok(!fs.existsSync(path.join(storeA, "images", "bad id.jpg")), "no 'bad id.jpg' written locally");
  dA.close();
});

test("runSync uses the on-disk peer folder name, not the snapshot's self-asserted deviceId", () => {
  const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-dbx-"));
  const now = Date.now();
  // Folder is named dev_REAL but the snapshot LIES that deviceId is dev_LIE.
  const folder = writePeerFolder(syncDir, "dev_REAL", {
    schemaVersion: dbm.SCHEMA_VERSION,
    deviceId: "dev_LIE",
    deviceLabel: "Liar",
    publishedAt: now,
    cards: [{ id: "c_real", url: "https://real.com", img: "idb:c_real", updatedAt: now }],
    saved: [],
    fp: {},
    tombstones: [],
  }, { cards: 1, saved: 0, images: 1 });
  fs.writeFileSync(path.join(folder, "images", "c_real.jpg"), "JPGBYTES");
  // syncDir/dev_LIE does not exist — if code trusted deviceId it would fail the copy.
  assert.ok(!fs.existsSync(path.join(syncDir, "dev_LIE")), "dev_LIE folder must not exist");

  const storeA = tmpStore(); const dA = dbm.openDb(storeA);
  sync.runSync({ db: dA, storeDir: storeA }, {
    syncDir: syncDir, deviceId: "dev_A", deviceLabel: "Desktop",
    publish: true, backupFn: function () {},
  });
  assert.ok(dbm.allCards(dA).some(c => c.id === "c_real"), "card merged via real on-disk folder dev_REAL");
  assert.ok(fs.existsSync(path.join(storeA, "images", "c_real.jpg")), "image copied from real on-disk folder");
  dA.close();
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
