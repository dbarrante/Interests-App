// tests/sync-skip.test.js — watermark + signature skipping (desktop).
// Safety property under test: skips NEVER change what a cycle would have
// produced — they only avoid re-reading/re-writing bytes that provably
// didn't change. Every doubt-path must fall back to full behavior.
const assert = require("assert");
const fs = require("fs"), path = require("path"), os = require("os");
const db = require("../core/db.js");
const sync = require("../core/sync.js");

let pass = 0, fail = 0;
function run(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }
function mkCtx(root, name) { const s = path.join(root, name); fs.mkdirSync(path.join(s, "images"), { recursive: true }); return { db: db.openDb(s), storeDir: s }; }
const noBackup = function () {};

run("second no-change cycle skips peer re-read AND publish; a real edit un-skips both", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia-skip-"));
  const syncDir = path.join(root, "sync"); fs.mkdirSync(syncDir, { recursive: true });
  const A = mkCtx(root, "A"), B = mkCtx(root, "B");
  db.upsertCard(A.db, { id: "a1", url: "http://a/1", ts: 1 });

  sync.runSync(A, { syncDir, deviceId: "devA", deviceLabel: "A", backupFn: noBackup });
  const r1 = sync.runSync(B, { syncDir, deviceId: "devB", deviceLabel: "B", backupFn: noBackup });
  assert.strictEqual(r1.peersSkipped, 0, "first sight of A must full-read");
  assert.strictEqual(r1.publishSkipped, false, "first publish must run");
  assert.ok(db.allCards(B.db).some(c => c.id === "a1"), "a1 merged into B");

  const bSnap = path.join(syncDir, "devB", "snapshot.json");
  const mtime1 = fs.statSync(bSnap).mtimeMs;
  const r2 = sync.runSync(B, { syncDir, deviceId: "devB", deviceLabel: "B", backupFn: noBackup });
  assert.strictEqual(r2.peersSkipped, 1, "unchanged A must be skipped (watermark)");
  assert.strictEqual(r2.publishSkipped, true, "unchanged B must not republish");
  assert.strictEqual(fs.statSync(bSnap).mtimeMs, mtime1, "snapshot.json untouched on skip");

  db.upsertCard(A.db, { id: "a2", url: "http://a/2", ts: 2 });
  sync.runSync(A, { syncDir, deviceId: "devA", deviceLabel: "A", backupFn: noBackup });
  const r3 = sync.runSync(B, { syncDir, deviceId: "devB", deviceLabel: "B", backupFn: noBackup });
  assert.strictEqual(r3.peersSkipped, 0, "changed A must be re-read");
  assert.ok(db.allCards(B.db).some(c => c.id === "a2"), "a2 arrived");
  assert.strictEqual(r3.publishSkipped, false, "merge applied → B must republish");
});

run("deferred upsert (peer image missing) blocks watermark advance → peer re-read next cycle heals", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia-skip2-"));
  const syncDir = path.join(root, "sync"); fs.mkdirSync(syncDir, { recursive: true });
  const A = mkCtx(root, "A"), B = mkCtx(root, "B");
  // a1 references an idb: image that does NOT exist in A's store → after A
  // publishes, B's merge defers the upsert (image uncopyable).
  db.upsertCard(A.db, { id: "a1", url: "http://a/1", ts: 1, img: "idb:a1" });
  sync.runSync(A, { syncDir, deviceId: "devA", deviceLabel: "A", backupFn: noBackup });

  const r1 = sync.runSync(B, { syncDir, deviceId: "devB", deviceLabel: "B", backupFn: noBackup });
  assert.ok(!db.allCards(B.db).some(c => c.id === "a1"), "a1 deferred (no image)");
  const r2 = sync.runSync(B, { syncDir, deviceId: "devB", deviceLabel: "B", backupFn: noBackup });
  assert.strictEqual(r2.peersSkipped, 0, "dirty cycle must NOT advance the watermark — peer re-read");

  // heal: give A the image file and republish (content unchanged → force via edit)
  fs.writeFileSync(path.join(A.storeDir, "images", "a1.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  db.upsertCard(A.db, { id: "a1", url: "http://a/1b", ts: 1, img: "idb:a1" });
  sync.runSync(A, { syncDir, deviceId: "devA", deviceLabel: "A", backupFn: noBackup });
  sync.runSync(B, { syncDir, deviceId: "devB", deviceLabel: "B", backupFn: noBackup });
  assert.ok(db.allCards(B.db).some(c => c.id === "a1"), "a1 healed after image appeared");
  const r4 = sync.runSync(B, { syncDir, deviceId: "devB", deviceLabel: "B", backupFn: noBackup });
  assert.strictEqual(r4.peersSkipped, 1, "clean cycle finally advances the watermark");
});

run("readPeerSnapshots without seenByDevice (old callers) behaves exactly as before", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia-skip3-"));
  const syncDir = path.join(root, "sync"); fs.mkdirSync(syncDir, { recursive: true });
  const A = mkCtx(root, "A");
  db.upsertCard(A.db, { id: "a1", url: "http://a/1", ts: 1 });
  sync.runSync(A, { syncDir, deviceId: "devA", deviceLabel: "A", backupFn: noBackup });
  const rp = sync.readPeerSnapshots(syncDir, "devB");
  assert.strictEqual(rp.peers.length, 1);
  assert.strictEqual(rp.peersSkipped, 0);
});

run("a THROWN upsert dirties the cycle: watermark must not advance past un-merged peer data (final review Finding 1)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia-skip4-"));
  const syncDir = path.join(root, "sync"); fs.mkdirSync(syncDir, { recursive: true });
  const A = mkCtx(root, "A"), B = mkCtx(root, "B");
  db.upsertCard(A.db, { id: "a1", url: "http://a/1", ts: 1 });
  sync.runSync(A, { syncDir, deviceId: "devA", deviceLabel: "A", backupFn: noBackup });

  // Transient failure: the shared db module's upsertCardSynced throws ONCE
  // (SQLITE_BUSY / disk blip stand-in). Pre-fix, the cycle still counted as
  // clean, the watermark advanced, and — because A's own publish-skip freezes
  // its publishedAt — a1 would have been hidden from B FOREVER.
  const real = db.upsertCardSynced;
  db.upsertCardSynced = function () { throw new Error("simulated transient SQLITE_BUSY"); };
  let r1;
  try { r1 = sync.runSync(B, { syncDir, deviceId: "devB", deviceLabel: "B", backupFn: noBackup }); }
  finally { db.upsertCardSynced = real; }
  assert.ok(!db.allCards(B.db).some(c => c.id === "a1"), "a1 not applied (throw swallowed per-upsert)");

  const r2 = sync.runSync(B, { syncDir, deviceId: "devB", deviceLabel: "B", backupFn: noBackup });
  assert.strictEqual(r2.peersSkipped, 0, "dirty cycle must NOT have advanced the watermark — A re-read");
  assert.ok(db.allCards(B.db).some(c => c.id === "a1"), "a1 arrives on the retry");
  const r3 = sync.runSync(B, { syncDir, deviceId: "devB", deviceLabel: "B", backupFn: noBackup });
  assert.strictEqual(r3.peersSkipped, 1, "clean retry advances the watermark normally");
});

run("publish-skip refuses when the published folder was wiped out-of-band (final review Finding 2b)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia-skip5-"));
  const syncDir = path.join(root, "sync"); fs.mkdirSync(syncDir, { recursive: true });
  const B = mkCtx(root, "B");
  db.upsertCard(B.db, { id: "b1", url: "http://b/1", ts: 1 });
  sync.runSync(B, { syncDir, deviceId: "devB", deviceLabel: "B", backupFn: noBackup });
  const r1 = sync.runSync(B, { syncDir, deviceId: "devB", deviceLabel: "B", backupFn: noBackup });
  assert.strictEqual(r1.publishSkipped, true, "steady state: skip established");

  fs.rmSync(path.join(syncDir, "devB"), { recursive: true, force: true });   // Dropbox rewind / manual wipe
  const r2 = sync.runSync(B, { syncDir, deviceId: "devB", deviceLabel: "B", backupFn: noBackup });
  assert.strictEqual(r2.publishSkipped, false, "missing meta.json must force a real publish");
  assert.ok(fs.existsSync(path.join(syncDir, "devB", "meta.json")), "snapshot re-created");
});

console.log("sync-skip: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
