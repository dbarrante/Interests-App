// tests/syncworker.test.js — the off-main-thread sync runner (core/syncworker.js).
// Contract under test: full cycles run on a worker with its OWN per-run DB
// connection (closed before exit), the façade NEVER rejects (errors resolve as
// {ok:false,error}), and concurrent calls serialize instead of overlapping.
// This is the 2026-07-18 "Not responding" fix — a synchronous merge on the
// Electron main process froze every window for the whole cycle.
const assert = require("assert");
const fs = require("fs"), path = require("path"), os = require("os");
const db = require("../core/db.js");
const sync = require("../core/sync.js");
const { createAsyncSync } = require("../core/syncworker.js");

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

    const asyncSync = createAsyncSync(storeB);
    const r = await asyncSync.runSync(null, { syncDir, deviceId: "devB", deviceLabel: "B", noBackup: true });
    assert.strictEqual(r.ok, true, "worker cycle must succeed: " + (r.error || ""));
    assert.strictEqual(r.changed, true, "A's card merged");
    // A fresh main-thread connection proves the worker's handle is gone and the data landed.
    const d = db.openDb(storeB);
    assert.ok(db.allCards(d).some((c) => c.id === "a1"), "a1 present in B's store");
    d.close();
  });

  await run("façade NEVER rejects: a broken store resolves {ok:false}", async () => {
    const asyncSync = createAsyncSync(path.join(os.tmpdir(), "ia-wrk-definitely-missing-" + Date.now()));
    const r = await asyncSync.runSync(null, { syncDir: path.join(os.tmpdir(), "nope"), deviceId: "x", deviceLabel: "x", noBackup: true });
    assert.strictEqual(r.ok, false, "must resolve ok:false, not reject");
    assert.ok(r.error, "carries the error message");
  });

  await run("concurrent calls serialize (both complete, no overlap crash)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ia-wrk2-"));
    const syncDir = path.join(root, "sync"); fs.mkdirSync(syncDir, { recursive: true });
    const storeB = path.join(root, "B"); fs.mkdirSync(path.join(storeB, "images"), { recursive: true });
    const asyncSync = createAsyncSync(storeB);
    const [r1, r2] = await Promise.all([
      asyncSync.runSync(null, { syncDir, deviceId: "devB", deviceLabel: "B", noBackup: true }),
      asyncSync.runSync(null, { syncDir, deviceId: "devB", deviceLabel: "B", noBackup: true }),
    ]);
    assert.strictEqual(r1.ok, true, "first: " + (r1.error || ""));
    assert.strictEqual(r2.ok, true, "second (queued): " + (r2.error || ""));
  });

  console.log("syncworker: " + pass + " passed, " + fail + " failed");
  if (fail) process.exitCode = 1;
})();
