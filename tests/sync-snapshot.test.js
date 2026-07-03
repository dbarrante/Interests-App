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

test("runSync skips merge when backupFn throws (data-safety)", () => {
  const syncDir = tmp();
  // Peer B publishes a card.
  const storeB = tmpStore(); const dB = dbm.openDb(storeB);
  dbm.upsertCard(dB, { id: "c_B_safe", url: "https://b.com/safe" });
  sync.publishSnapshot({ db: dB, storeDir: storeB }, syncDir, "dev_B", "Laptop"); dB.close();
  // Device A runs sync with a backupFn that always throws.
  const storeA = tmpStore(); const dA = dbm.openDb(storeA);
  const res = sync.runSync({ db: dA, storeDir: storeA }, {
    syncDir,
    deviceId: "dev_A",
    deviceLabel: "Desktop",
    publish: true,
    backupFn: function () { throw new Error("backup boom"); },
  });
  assert.strictEqual(res.changed, false, "changed must be false when backup fails");
  assert.ok(!dbm.allCards(dA).some(c => c.id === "c_B_safe"), "peer card must NOT be applied when backup fails");
  dA.close();
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

test("merge DEFERS a winning idb card whose image hasn't propagated (no dangling ref)", () => {
  const syncDir = tmp();
  // B publishes a card with an idb image ref but NO image file in its folder.
  const storeB = tmpStore(); const dB = dbm.openDb(storeB);
  dbm.upsertCard(dB, { id: "c_noimg", url: "https://b.com/noimg", img: "idb:c_noimg" });
  sync.publishSnapshot({ db: dB, storeDir: storeB }, syncDir, "dev_B", "Laptop"); dB.close();
  // Sanity: peer folder really has no image, and meta.counts.images is 0.
  assert.ok(!fs.existsSync(path.join(syncDir, "dev_B", "images", "c_noimg.jpg")), "peer published no image file");
  // A runs a sync against a fresh store.
  const storeA = tmpStore(); const dA = dbm.openDb(storeA);
  const res = sync.runSync({ db: dA, storeDir: storeA }, { syncDir, deviceId: "dev_A", deviceLabel: "Desktop", publish: true, backupFn: function () {} });
  assert.ok(!dbm.allCards(dA).some(c => c.id === "c_noimg"), "card with absent image must NOT be applied (deferred)");
  assert.ok(!fs.existsSync(path.join(storeA, "images", "c_noimg.jpg")), "no dangling image file locally");
  assert.strictEqual(res.changed, false, "a fully-deferred cycle reports changed:false");
  dA.close();
});

test("merge SELF-HEALS: same card applies once its image propagates", () => {
  const syncDir = tmp();
  const storeB = tmpStore(); const dB = dbm.openDb(storeB);
  dbm.upsertCard(dB, { id: "c_heal", url: "https://b.com/heal", img: "idb:c_heal" });
  sync.publishSnapshot({ db: dB, storeDir: storeB }, syncDir, "dev_B", "Laptop"); dB.close();
  // First cycle: image absent → deferred.
  const storeA = tmpStore(); const dA = dbm.openDb(storeA);
  sync.runSync({ db: dA, storeDir: storeA }, { syncDir, deviceId: "dev_A", deviceLabel: "Desktop", publish: true, backupFn: function () {} });
  assert.ok(!dbm.allCards(dA).some(c => c.id === "c_heal"), "deferred on first cycle (no image yet)");
  // Image now propagates: B writes the file and republishes.
  const dB2 = dbm.openDb(storeB);
  fs.writeFileSync(path.join(storeB, "images", "c_heal.jpg"), "JPGBYTES");
  sync.publishSnapshot({ db: dB2, storeDir: storeB }, syncDir, "dev_B", "Laptop"); dB2.close();
  // Second cycle: image present → applies + copies.
  const res2 = sync.runSync({ db: dA, storeDir: storeA }, { syncDir, deviceId: "dev_A", deviceLabel: "Desktop", publish: true, backupFn: function () {} });
  assert.ok(res2.changed, "self-heal cycle reports changed");
  assert.ok(dbm.allCards(dA).some(c => c.id === "c_heal"), "card applied once image propagated");
  assert.ok(fs.existsSync(path.join(storeA, "images", "c_heal.jpg")), "image copied locally on self-heal");
  dA.close();
});

test("defaultSyncDir() resolves without throwing (returns string or null)", () => {
  const d = sync.defaultSyncDir();
  assert.ok(d === null || typeof d === "string", "defaultSyncDir returns string|null, never throws");
});

test("readSnapshot rejects a snapshot whose meta counts mismatch snapshot.json (torn write)", () => {
  const store = tmpStore(); const d = dbm.openDb(store);
  dbm.upsertCard(d, { id: "c_1", url: "https://a.com" });
  const syncDir = tmp();
  sync.publishSnapshot({ db: d, storeDir: store }, syncDir, "dev_A", "Desktop");
  const folder = path.join(syncDir, "dev_A");
  const meta = JSON.parse(fs.readFileSync(path.join(folder, "meta.json"), "utf8"));
  meta.counts.cards = 999;   // tamper: claim more cards than snapshot.json actually has
  fs.writeFileSync(path.join(folder, "meta.json"), JSON.stringify(meta));
  assert.strictEqual(sync.readSnapshot(folder), null, "a count mismatch must be rejected");
  d.close();
});

// Task 5 / M3: applyMerge must forward the peer's deletedAt into deleteCard/deleteSaved
// instead of letting them re-stamp Date.now() — otherwise a merge-applied delete looks
// newer at every hop and can swallow a legitimate re-add.
test("applyMerge passes the peer's deletedAt through to the tombstone, not Date.now()", () => {
  const store = tmpStore(); const d = dbm.openDb(store);
  dbm.upsertCard(d, { id: "c_del", url: "https://a.com/del" });
  const ctx = { db: d, storeDir: store };
  const plan = {
    upserts: [],
    deletes: [{ id: "c_del", kind: "card", deletedAt: 777 }],
    tombstones: [],
    imageCopies: [],
  };
  sync.applyMerge(ctx, plan);
  const tomb = dbm.allTombstones(d).find(t => t.id === "c_del" && t.kind === "card");
  assert.ok(tomb, "tombstone created");
  assert.strictEqual(tomb.deletedAt, 777, "deletedAt is the peer's original value, not Date.now()");
  d.close();
});

test("applyMerge passes the peer's deletedAt through for a saved-item delete too", () => {
  const store = tmpStore(); const d = dbm.openDb(store);
  dbm.upsertSaved(d, { id: "s_del", url: "https://a.com/sdel" });
  const ctx = { db: d, storeDir: store };
  const plan = {
    upserts: [],
    deletes: [{ id: "s_del", kind: "saved", deletedAt: 555 }],
    tombstones: [],
    imageCopies: [],
  };
  sync.applyMerge(ctx, plan);
  const tomb = dbm.allTombstones(d).find(t => t.id === "s_del" && t.kind === "saved");
  assert.ok(tomb, "tombstone created");
  assert.strictEqual(tomb.deletedAt, 555);
  d.close();
});

// Task 5 / M3 completion — REAL production path end-to-end: peer publishes a
// tombstone with a known old deletedAt; local runs a full sync cycle
// (readPeerSnapshots -> mergeSnapshots -> applyMerge). The local tombstone must
// keep the peer's ORIGINAL deletedAt (777), not get re-stamped ~Date.now() —
// note addTombstone keeps the MAX, so a Date.now() stamp anywhere in the path
// would win over 777 and this assertion would catch it.
test("full sync cycle keeps the peer tombstone's original deletedAt end-to-end", () => {
  const syncDir = tmp();
  // Peer B: no card, just a tombstone saying "c_x was deleted at t=777".
  const storeB = tmpStore(); const dB = dbm.openDb(storeB);
  dbm.addTombstone(dB, "c_x", "card", 777);
  sync.publishSnapshot({ db: dB, storeDir: storeB }, syncDir, "dev_B", "Laptop"); dB.close();
  // Device A still has the card, last updated BEFORE the delete (updatedAt 100 < 777).
  const storeA = tmpStore(); const dA = dbm.openDb(storeA);
  dbm.upsertCardSynced(dA, { id: "c_x", url: "https://a.com/x" }, 100);
  const res = sync.runSync({ db: dA, storeDir: storeA }, { syncDir, deviceId: "dev_A", deviceLabel: "Desktop", publish: false, backupFn: function () {} });
  assert.ok(res.changed, "delete applied");
  assert.ok(!dbm.allCards(dA).some(c => c.id === "c_x"), "card deleted locally");
  const tomb = dbm.allTombstones(dA).find(t => t.id === "c_x" && t.kind === "card");
  assert.ok(tomb, "tombstone recorded locally");
  assert.strictEqual(tomb.deletedAt, 777, "tombstone keeps the peer's ORIGINAL deletedAt, not ~Date.now()");
  dA.close();
});

// --- Task 4: clock-skew snapshot guard ---------------------------------------
// Hand-write a peer folder with a chosen publishedAt so we can drive the guard.
function writeRawPeer(syncDir, name, publishedAt, cards) {
  const folder = path.join(syncDir, name);
  fs.mkdirSync(path.join(folder, "images"), { recursive: true });
  const snap = {
    schemaVersion: dbm.SCHEMA_VERSION, deviceId: name, deviceLabel: name,
    publishedAt: publishedAt, cards: cards || [], saved: [], tombstones: [],
  };
  if (publishedAt === "OMIT") { delete snap.publishedAt; }
  fs.writeFileSync(path.join(folder, "snapshot.json"), JSON.stringify(snap));
  const meta = { schemaVersion: dbm.SCHEMA_VERSION, deviceId: name, deviceLabel: name,
    counts: { cards: (cards || []).length, saved: 0, images: 0 } };
  if (publishedAt !== "OMIT") meta.publishedAt = publishedAt;
  fs.writeFileSync(path.join(folder, "meta.json"), JSON.stringify(meta));
}

test("clock-skew: peer 25h in the future is SKIPPED, counted, not merged", () => {
  const syncDir = tmp();
  const now = Date.now();
  writeRawPeer(syncDir, "dev_FUTURE", now + 25 * 3600 * 1000,
    [{ id: "c_future", url: "https://f.com", updatedAt: now + 25 * 3600 * 1000 }]);
  const storeA = tmpStore(); const dA = dbm.openDb(storeA);
  const res = sync.runSync({ db: dA, storeDir: storeA },
    { syncDir, deviceId: "dev_A", deviceLabel: "Desktop", publish: false, backupFn: function () {} });
  assert.strictEqual(res.skewSkipped, 1, "skewSkipped incremented");
  assert.ok(!dbm.allCards(dA).some(c => c.id === "c_future"), "future-skewed card must NOT be merged");
  dA.close();
});

test("clock-skew: peer 23h in the future is merged normally (within tolerance)", () => {
  const syncDir = tmp();
  const now = Date.now();
  writeRawPeer(syncDir, "dev_NEAR", now + 23 * 3600 * 1000,
    [{ id: "c_near", url: "https://n.com", updatedAt: now + 23 * 3600 * 1000 }]);
  const storeA = tmpStore(); const dA = dbm.openDb(storeA);
  const res = sync.runSync({ db: dA, storeDir: storeA },
    { syncDir, deviceId: "dev_A", deviceLabel: "Desktop", publish: false, backupFn: function () {} });
  assert.strictEqual(res.skewSkipped, 0, "23h peer not skipped");
  assert.ok(dbm.allCards(dA).some(c => c.id === "c_near"), "23h-future card merged normally");
  dA.close();
});

test("clock-skew: peer with NO publishedAt is trusted (merged, not skipped)", () => {
  const syncDir = tmp();
  writeRawPeer(syncDir, "dev_OLD", "OMIT",
    [{ id: "c_old", url: "https://o.com", updatedAt: Date.now() }]);
  const storeA = tmpStore(); const dA = dbm.openDb(storeA);
  const res = sync.runSync({ db: dA, storeDir: storeA },
    { syncDir, deviceId: "dev_A", deviceLabel: "Desktop", publish: false, backupFn: function () {} });
  assert.strictEqual(res.skewSkipped, 0, "absent publishedAt not counted as skew");
  assert.ok(dbm.allCards(dA).some(c => c.id === "c_old"), "publishedAt-less peer is trusted and merged");
  dA.close();
});

// --- Task 4: fp de-published ------------------------------------------------
test("publishSnapshot writes NO fp key into snapshot.json", () => {
  const store = tmpStore(); const d = dbm.openDb(store);
  dbm.upsertCard(d, { id: "c_1", url: "https://a.com" });
  dbm.setFp(d, "c_1", "somefingerprint");   // fp exists in DB…
  const syncDir = tmp();
  sync.publishSnapshot({ db: d, storeDir: store }, syncDir, "dev_A", "Desktop");
  const raw = JSON.parse(fs.readFileSync(path.join(syncDir, "dev_A", "snapshot.json"), "utf8"));
  assert.ok(!("fp" in raw), "published snapshot must not contain an fp key");
  d.close();
});

test("an OLD snapshot that still carries an fp key merges without error (fp ignored)", () => {
  const syncDir = tmp();
  const folder = path.join(syncDir, "dev_LEGACY");
  fs.mkdirSync(path.join(folder, "images"), { recursive: true });
  const snap = {
    schemaVersion: dbm.SCHEMA_VERSION, deviceId: "dev_LEGACY", deviceLabel: "Legacy",
    publishedAt: Date.now(),
    cards: [{ id: "c_legacy", url: "https://legacy.com", updatedAt: Date.now() }],
    saved: [], fp: { c_legacy: "oldfp" }, tombstones: [],   // legacy fp key present
  };
  fs.writeFileSync(path.join(folder, "snapshot.json"), JSON.stringify(snap));
  fs.writeFileSync(path.join(folder, "meta.json"), JSON.stringify({
    schemaVersion: dbm.SCHEMA_VERSION, deviceId: "dev_LEGACY", deviceLabel: "Legacy",
    publishedAt: snap.publishedAt, counts: { cards: 1, saved: 0, images: 0 },
  }));
  const storeA = tmpStore(); const dA = dbm.openDb(storeA);
  assert.doesNotThrow(function () {
    sync.runSync({ db: dA, storeDir: storeA },
      { syncDir, deviceId: "dev_A", deviceLabel: "Desktop", publish: false, backupFn: function () {} });
  }, "legacy fp-bearing snapshot must merge without error");
  assert.ok(dbm.allCards(dA).some(c => c.id === "c_legacy"), "legacy card merged despite fp key");
  dA.close();
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
