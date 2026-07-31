// tests/storeworker.test.js — the off-main-thread store-mutating operations runner (core/storeworker.js).
// Contract under test: full cycles run on a worker with its OWN per-run DB
// connection (closed before exit), the façade NEVER rejects (errors resolve as
// {ok:false,error}), and concurrent calls serialize instead of overlapping.
// This is the 2026-07-18 "Not responding" fix — a synchronous merge on the
// Electron main process froze every window for the whole cycle.

// ISOLATE the config in a temp APPDATA *before* requiring anything that loads
// core/config (core/sync.js -> core/backup.js does, at require time) — the
// backup-job tests below make a REAL backup, and a killed run must never leave
// that pointed at the real Dropbox backups folder (2026-07-19 near-miss: a
// temp-path guard redirected a sandboxed test INTO real Dropbox backups). Same
// pattern as tests/backup.test.js.
const fs = require("fs"), path = require("path"), os = require("os");
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-ad-"));

const assert = require("assert");
const db = require("../core/db.js");
const sync = require("../core/sync.js");
const config = require("../core/config.js");
const { createStoreWorker } = require("../core/storeworker.js");

let pass = 0, fail = 0;
async function run(name, fn) {
  try { await fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); }
}

(async () => {
  await run("worker runs a full cycle off-thread; its DB handle is closed on exit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia-wrk-"));
    const syncDir = path.join(root, "sync"); fs.mkdirSync(syncDir, { recursive: true });
    const storeA = path.join(root, "A"); fs.mkdirSync(path.join(storeA, "images"), { recursive: true });
    const storeB = path.join(root, "B"); fs.mkdirSync(path.join(storeB, "images"), { recursive: true });
    const ctxA = { db: db.openDb(storeA), storeDir: storeA };
    db.upsertCard(ctxA.db, { id: "a1", url: "http://a/1", ts: 1 });
    sync.runSync(ctxA, { syncDir, deviceId: "devA", deviceLabel: "A", backupFn: function () {} });
    ctxA.db.close();

    const storeWorker = createStoreWorker(storeB);
    const r = await storeWorker.runSync(null, { syncDir, deviceId: "devB", deviceLabel: "B", noBackup: true });
    assert.strictEqual(r.ok, true, "worker cycle must succeed: " + (r.error || ""));
    assert.strictEqual(r.changed, true, "A's card merged");
    // A fresh main-thread connection proves the worker's handle is gone and the data landed.
    const d = db.openDb(storeB);
    assert.ok(db.allCards(d).some((c) => c.id === "a1"), "a1 present in B's store");
    d.close();
  });

  await run("façade NEVER rejects: a broken store resolves {ok:false}", async () => {
    const storeWorker = createStoreWorker(path.join(os.tmpdir(), "ia-wrk-definitely-missing-" + Date.now()));
    const r = await storeWorker.runSync(null, { syncDir: path.join(os.tmpdir(), "nope"), deviceId: "x", deviceLabel: "x", noBackup: true });
    assert.strictEqual(r.ok, false, "must resolve ok:false, not reject");
    assert.ok(r.error, "carries the error message");
  });

  await run("concurrent calls serialize (both complete, no overlap crash)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia-wrk2-"));
    const syncDir = path.join(root, "sync"); fs.mkdirSync(syncDir, { recursive: true });
    const storeB = path.join(root, "B"); fs.mkdirSync(path.join(storeB, "images"), { recursive: true });
    const storeWorker = createStoreWorker(storeB);
    const [r1, r2] = await Promise.all([
      storeWorker.runSync(null, { syncDir, deviceId: "devB", deviceLabel: "B", noBackup: true }),
      storeWorker.runSync(null, { syncDir, deviceId: "devB", deviceLabel: "B", noBackup: true }),
    ]);
    assert.strictEqual(r1.ok, true, "first: " + (r1.error || ""));
    assert.strictEqual(r2.ok, true, "second (queued): " + (r2.error || ""));
  });

  await run("backup job runs off-thread and matches the direct call's result shape", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia-wrk-backup-"));
    const storeDir = path.join(root, "store"); fs.mkdirSync(path.join(storeDir, "images"), { recursive: true });
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ia-wrk-backup-dest-"));
    const d = db.openDb(storeDir);
    db.upsertCard(d, { id: "c1", url: "http://x/1", ts: 1 });
    d.close();

    // Sandbox dropboxBackupDir() at backupRoot via config.backupDir (same
    // technique as tests/backup.test.js's withBackupDir), NOT by monkeypatching
    // core/backup.js's exported detectDropboxRoot: dropboxBackupDir() calls
    // detectDropboxRoot() as a bare module-scope reference (not through
    // module.exports), so overwriting the export is a no-op even in the same
    // thread — and the worker thread re-requires("./backup") in its own fresh
    // module registry regardless, so a main-thread monkeypatch could never
    // cross the boundary anyway. Without real sandboxing this would silently
    // resolve the REAL Dropbox root and write/rotate against real backups —
    // exactly the 2026-07-19 near-miss shape.
    const orig = config.loadConfig();
    config.saveConfig(Object.assign({}, orig, { backupDir: backupRoot }));
    try {
      const backupMod = require("../core/backup.js");
      const storeWorker = createStoreWorker(storeDir);
      const out = await storeWorker.runBackup(storeDir, { keep: 3 });
      assert.strictEqual(out.ok, true, "backup job must succeed: " + (out.error || ""));
      assert.strictEqual(out.verified, true);
      assert.ok(out.name, "backup name returned");
      assert.strictEqual(out.counts.imported, 1);
      assert.ok(fs.existsSync(path.join(backupRoot, out.name)),
        "backup must land under the sandboxed backupRoot, proving the sandbox actually took");
      assert.strictEqual(backupMod.verifyBackup(out.name, out.counts), true,
        "the backup the worker created must independently verify from the main thread too");
    } finally {
      config.saveConfig(orig || {});
    }
  });

  await run("backup job resolves {ok:false}, never rejects, on a genuine failure", async () => {
    const storeWorker = createStoreWorker(path.join(os.tmpdir(), "ia-wrk-backup-missing-" + Date.now()));
    const out = await storeWorker.runBackup(path.join(os.tmpdir(), "ia-wrk-backup-missing-" + Date.now()), { keep: 3 });
    assert.strictEqual(out.ok, false);
    assert.ok(out.error);
  });

  await run("setStoreDir repoints an existing storeWorker: publishSnapshot follows it, not the construction-time closure", async () => {
    // Regression test for the stale-storeDir-after-move gap: ctx.storeWorker
    // and startSyncTimers's `sync` reference are the SAME object in main.js,
    // and runSync/publishSnapshot took no storeDir argument — they always read
    // whatever createStoreWorker closed over AT CONSTRUCTION. A successful
    // /api/store-location/move repoints ctx.storeDir but, without setStoreDir,
    // this object would keep targeting the OLD directory until app restart.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia-wrk-repoint-"));
    const syncDir = path.join(root, "sync"); fs.mkdirSync(syncDir, { recursive: true });
    const storeA = path.join(root, "A"); fs.mkdirSync(path.join(storeA, "images"), { recursive: true });
    const storeB = path.join(root, "B"); fs.mkdirSync(path.join(storeB, "images"), { recursive: true });
    const dA = db.openDb(storeA);
    db.upsertCard(dA, { id: "onlyInA", url: "http://a/1", ts: 1 });
    dA.close();
    const dB = db.openDb(storeB);
    db.upsertCard(dB, { id: "onlyInB", url: "http://b/1", ts: 1 });
    dB.close();

    const storeWorker = createStoreWorker(storeA);
    let r = await storeWorker.publishSnapshot(null, syncDir, "dev1", "Dev1");
    assert.strictEqual(r.ok, true, "publish against A must succeed: " + (r.error || ""));
    let snap = JSON.parse(fs.readFileSync(path.join(syncDir, "dev1", "snapshot.json"), "utf8"));
    assert.ok(snap.cards.some((c) => c.id === "onlyInA"), "before setStoreDir: snapshot reflects store A");
    assert.ok(!snap.cards.some((c) => c.id === "onlyInB"), "before setStoreDir: snapshot must NOT contain B's card");

    storeWorker.setStoreDir(storeB);
    r = await storeWorker.publishSnapshot(null, syncDir, "dev1", "Dev1");
    assert.strictEqual(r.ok, true, "publish against B must succeed: " + (r.error || ""));
    snap = JSON.parse(fs.readFileSync(path.join(syncDir, "dev1", "snapshot.json"), "utf8"));
    assert.ok(snap.cards.some((c) => c.id === "onlyInB"), "after setStoreDir: snapshot must now reflect store B");
    assert.ok(!snap.cards.some((c) => c.id === "onlyInA"), "after setStoreDir: snapshot must NOT still reflect the old store A");
  });

  await run("movestore job copies+verifies off-thread; main thread only repoints", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia-wrk-move-"));
    const storeDir = path.join(root, "store"); fs.mkdirSync(path.join(storeDir, "images"), { recursive: true });
    const target = path.join(root, "moved");
    const d = db.openDb(storeDir);
    db.upsertCard(d, { id: "c1", url: "http://x/1", ts: 1 });
    d.close();

    const storeWorker = createStoreWorker(storeDir);
    const out = await storeWorker.moveStore(storeDir, target);
    assert.strictEqual(out.ok, true, "move must succeed: " + (out.error || ""));
    assert.ok(fs.existsSync(path.join(target, "interests.db")), "db copied to target");
    // Old copy is left on disk (matches moveStore's own documented behavior)
    assert.ok(fs.existsSync(path.join(storeDir, "interests.db")), "old store files left in place");
  });

  await run("restore job stages+verifies off-thread, main thread does the fast swap", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia-wrk-restore-"));
    const storeDir = path.join(root, "store"); fs.mkdirSync(path.join(storeDir, "images"), { recursive: true });
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ia-wrk-restore-dest-"));

    // Sandbox dropboxBackupDir() via config.backupDir, NOT by monkeypatching
    // backup.detectDropboxRoot — see the backup-job test above for why that
    // technique is inert AND cannot cross the thread boundary. It matters even
    // more here: the restore job WRITES a pre-restore safety snapshot into the
    // backups folder and then rotates that family, so an unsandboxed run would
    // both write to and DELETE from the real Dropbox backups.
    const orig = config.loadConfig();
    config.saveConfig(Object.assign({}, orig, { backupDir: backupRoot }));
    try {
      const backupMod = require("../core/backup.js");
      const d1 = db.openDb(storeDir);
      db.upsertCard(d1, { id: "c1", url: "http://x/1", ts: 1 });
      const made = backupMod.runBackup(d1, storeDir);
      // Mutate the live store AFTER the backup, so a correct restore must roll
      // it back to the 1-card state rather than being a no-op.
      db.upsertCard(d1, { id: "c2", url: "http://x/2", ts: 2 });
      // The write-witness can only be read from a LIVE handle on this thread —
      // the worker deliberately has none. Capture it before staging starts.
      const witness = backupMod.storeWitness(d1, storeDir);
      d1.close();

      const storeWorker = createStoreWorker(storeDir);
      const staged = await storeWorker.restore(storeDir, made.name, witness);
      assert.strictEqual(staged.ok, true, "restore job must succeed: " + (staged.error || ""));
      assert.deepStrictEqual(staged.witness, witness,
        "the witness must ride through the worker intact, or the main-thread swap can never verify it");
      // Same contract for storeDir: swapInStagedRestore refuses unless
      // staged.storeDir === ctx.storeDir (security review F-3). runJob resolves
      // the worker's result object wholesale, so this holds today — but a
      // handler that reshaped the message into a field list would drop it and
      // make EVERY worker-path restore fail closed while the direct-call tests
      // in backup.test.js all stayed green. Assert it explicitly.
      assert.strictEqual(staged.storeDir, storeDir,
        "storeDir must ride through the worker intact, or the main-thread swap refuses every restore");
      assert.ok(fs.existsSync(path.join(staged.stageFolder, "interests.db")),
        "the worker staged real content the main thread can now swap in");
      assert.ok(fs.readdirSync(backupRoot).some((n) => n.indexOf("interests-backup-before-restore-") === 0),
        "the worker took the pre-restore safety snapshot under the sandboxed backupRoot, proving the sandbox took");

      // The swap is main-thread-only: it needs the real ctx.db/ctx.reopen.
      const ctx = { db: db.openDb(storeDir), storeDir, reopen: function () { try { ctx.db.close(); } catch (e) {} ctx.db = db.openDb(ctx.storeDir); return ctx.db; } };
      const out = backupMod.swapInStagedRestore(staged, ctx);
      assert.strictEqual(out.ok, true, "swap must succeed: " + (out.error || ""));
      const ids = db.allCards(ctx.db).map((c) => c.id);
      assert.ok(ids.indexOf("c1") >= 0, "restored content present");
      assert.ok(ids.indexOf("c2") < 0, "the post-backup live card must be gone — a restore that leaves it is a no-op");
      ctx.db.close();
    } finally {
      config.saveConfig(orig || {});
    }
  });

  console.log("storeworker: " + pass + " passed, " + fail + " failed");
  if (fail) process.exitCode = 1;
})();
