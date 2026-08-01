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

  // ---- CROSS-JOB-TYPE exclusivity (final review, F2/F6) --------------------
  // The plan's Global Constraint is that ALL FIVE job types serialize against
  // each other for ANY pairing — and, critically, that the slot is held for the
  // WHOLE operation: restore's swap and move's repoint run on the MAIN thread,
  // after the worker exits, and are the actually-destructive halves. Until F2
  // they ran in the route's own continuation, OUTSIDE the queue, and stayed
  // safe only by accident of promise-reaction ordering. The pre-existing
  // "concurrent calls serialize" test above is SAME-type (two syncs) and would
  // not have noticed. These two are the ones that would.
  await run("cross-job-type: a queued publish cannot start until the previous MOVE's main-thread repoint has finished", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia-wrk-xjob-move-"));
    const syncDir = path.join(root, "sync"); fs.mkdirSync(syncDir, { recursive: true });
    const storeDir = path.join(root, "store"); fs.mkdirSync(path.join(storeDir, "images"), { recursive: true });
    const target = path.join(root, "moved");
    const d = db.openDb(storeDir);
    db.upsertCard(d, { id: "beforeMove", url: "http://x/1", ts: 1 });
    d.close();

    const storeWorker = createStoreWorker(storeDir);
    const order = [];
    // Stands in for /api/store-location/move's main-thread continuation. The
    // real one is synchronous; an ASYNC one here is the stronger test — it
    // proves the slot is held across a Promise-returning `after` too, and it
    // widens the window that an early-releasing queue would race through into
    // something deterministic rather than timing-dependent.
    const movePromise = storeWorker.moveStore(storeDir, target, async function (r) {
      order.push("move:worker-done");
      await new Promise((res) => setTimeout(res, 150));
      // The repoint, in two observable halves: content only the post-repoint
      // store has, and the façade's own storeDir.
      const dd = db.openDb(target);
      db.upsertCard(dd, { id: "duringRepoint", url: "http://x/2", ts: 2 });
      dd.close();
      storeWorker.setStoreDir(target);
      order.push("move:repoint-done");
      return r;
    });
    // Queued behind the move — a DIFFERENT job type.
    const publishPromise = storeWorker.publishSnapshot(null, syncDir, "dev1", "Dev1")
      .then(function (r) { order.push("publish:done"); return r; });

    const [mv, pub] = await Promise.all([movePromise, publishPromise]);
    assert.strictEqual(mv.ok, true, "move must succeed: " + (mv.error || ""));
    assert.strictEqual(pub.ok, true, "queued publish must succeed: " + (pub.error || ""));
    assert.deepStrictEqual(order, ["move:worker-done", "move:repoint-done", "publish:done"],
      "the publish must not complete until the move's ENTIRE operation — repoint included — is done");

    const snap = JSON.parse(fs.readFileSync(path.join(syncDir, "dev1", "snapshot.json"), "utf8"));
    // Two independent proofs that the publish job did not merely finish late,
    // but did not START until the repoint landed:
    //  * duringRepoint was written INSIDE the after callback. A publish that
    //    spawned its worker when the move's WORKER exited would have read the
    //    store before that write existed.
    //  * setStoreDir(target) also happened inside it, and the job spec is built
    //    from currentStoreDir at EXEC time — a spec frozen at enqueue time (as
    //    it was before F2) would still name the pre-move directory.
    assert.ok(snap.cards.some((c) => c.id === "duringRepoint"),
      "the queued publish must see content written during the move's main-thread repoint step");
    assert.ok(snap.cards.some((c) => c.id === "beforeMove"),
      "…and the moved content, i.e. it published the NEW store, not the abandoned one");
  });

  await run("cross-job-type: backup → restore(+swap) → sync publish run strictly one at a time, and the publish sees the POST-SWAP store", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia-wrk-xjob-restore-"));
    const syncDir = path.join(root, "sync"); fs.mkdirSync(syncDir, { recursive: true });
    const storeDir = path.join(root, "store"); fs.mkdirSync(path.join(storeDir, "images"), { recursive: true });
    const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ia-wrk-xjob-dest-"));
    // Sandbox dropboxBackupDir() via config.backupDir — see the backup-job test
    // above for why monkeypatching detectDropboxRoot cannot work here.
    const orig = config.loadConfig();
    config.saveConfig(Object.assign({}, orig, { backupDir: backupRoot }));
    try {
      const backupMod = require("../core/backup.js");
      const d1 = db.openDb(storeDir);
      db.upsertCard(d1, { id: "inBackup", url: "http://x/1", ts: 1 });
      const made = backupMod.runBackup(d1, storeDir);
      db.upsertCard(d1, { id: "afterBackup", url: "http://x/2", ts: 2 });
      const witness = backupMod.storeWitness(d1, storeDir);
      d1.close();

      const ctx = { db: db.openDb(storeDir), storeDir, reopen: function () { try { ctx.db.close(); } catch (e) {} ctx.db = db.openDb(ctx.storeDir); return ctx.db; } };
      const storeWorker = createStoreWorker(storeDir);
      const order = [];
      // safety:true deliberately: a NON-safety backup would write to the SAME
      // dated name as `made` and overwrite it with the current (post-mutation)
      // live store, which would make the restore below a no-op. It also skips
      // rotate(), which could otherwise prune the backup under test.
      const p1 = storeWorker.runBackup(storeDir, { safety: true })
        .then(function (r) { order.push("backup"); return r; });
      // Queued behind the backup. Its `after` is /api/restore's continuation.
      const p2 = storeWorker.restore(storeDir, made.name, witness, async function (staged) {
        order.push("restore:staged");
        await new Promise((res) => setTimeout(res, 150));
        const swapped = backupMod.swapInStagedRestore(staged, ctx);
        order.push("restore:swapped");
        return swapped;
      }).then(function (r) { order.push("restore"); return r; });
      // Queued behind the restore. A third job type again.
      const p3 = storeWorker.publishSnapshot(null, syncDir, "dev1", "Dev1")
        .then(function (r) { order.push("publish"); return r; });

      const [b, rest, pub] = await Promise.all([p1, p2, p3]);
      assert.strictEqual(b.ok, true, "backup: " + (b.error || ""));
      assert.strictEqual(rest.ok, true, "restore (staged+swapped): " + (rest.error || ""));
      assert.strictEqual(pub.ok, true, "publish: " + (pub.error || ""));
      assert.deepStrictEqual(order, ["backup", "restore:staged", "restore:swapped", "restore", "publish"],
        "strict FIFO across three DIFFERENT job types, with the restore's main-thread swap inside the slot");

      const snap = JSON.parse(fs.readFileSync(path.join(syncDir, "dev1", "snapshot.json"), "utf8"));
      // The behavioural proof: a publish that started before the swap would
      // have read the pre-restore store and carried afterBackup with it.
      assert.ok(snap.cards.some((c) => c.id === "inBackup"), "publish sees the restored content");
      assert.ok(!snap.cards.some((c) => c.id === "afterBackup"),
        "the queued publish must not have read the store before the restore's swap replaced it");
      try { ctx.db.close(); } catch (e) {}
    } finally {
      config.saveConfig(orig || {});
    }
  });

  // ---- queue-wedge regression (final-review fix wave, 50c141a) -------------
  // exclusive()'s `.catch` sits BEFORE `.finally` specifically so that an
  // `after` callback which throws still resolves {ok:false} (per the façade's
  // documented never-rejects contract) instead of leaving `p` a rejected
  // promise. Verified by temporarily commenting out the `.catch` in
  // core/storeworker.js and confirming this test fails: without it, `await`ing
  // the throwing call's result (r1 below) rejects instead of resolving
  // {ok:false} — and every caller of this façade (core/server.js's routes)
  // relies on the never-rejects contract to avoid an unhandled rejection
  // (Node's default policy there is to terminate the process), which would
  // take down every future store operation with it, not just this one. The
  // fix was restored afterward and this test re-confirmed green.
  await run("exclusive(): an `after` that throws synchronously resolves {ok:false} and does not strand the queue", async () => {
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-wrk-wedge-"));
    fs.mkdirSync(path.join(storeDir, "images"), { recursive: true });
    const storeWorker = createStoreWorker(storeDir);

    // An invalid backup name is the cheapest real job: stageRestore resolves
    // {ok:false} immediately with no ctx/db work, but `after` still runs on
    // that result -- which is all this test needs to trigger the throw.
    const badRestore = (after) => storeWorker.restore(
      storeDir, "definitely-not-a-backup", { rev: 0, cards: 0, saved: 0, images: 0, kv: {} }, after
    );

    // NOT awaited between p1 and p2 -- p2 is genuinely queued behind p1's slot.
    const p1 = badRestore(function () { throw new Error("boom-from-after"); });
    const p2 = badRestore(null);

    const r1 = await p1;
    assert.strictEqual(r1.ok, false, "a throwing `after` must resolve {ok:false}, not hang or reject");

    const r2 = await Promise.race([
      p2, new Promise((res) => setTimeout(() => res("TIMEOUT-QUEUE-WEDGED"), 5000)),
    ]);
    assert.notStrictEqual(r2, "TIMEOUT-QUEUE-WEDGED",
      "the job queued behind the throwing `after` must still settle, not hang forever");

    // A THIRD job, queued only now (after p1/p2 have already settled), proves
    // the slot itself is reusable -- not merely that p2 happened to drain.
    const r3 = await Promise.race([
      badRestore(null), new Promise((res) => setTimeout(() => res("TIMEOUT"), 5000)),
    ]);
    assert.notStrictEqual(r3, "TIMEOUT",
      "a job queued fresh after the throw must still run -- the queue must not be permanently stranded");
  });

  console.log("storeworker: " + pass + " passed, " + fail + " failed");
  if (fail) process.exitCode = 1;
})();
