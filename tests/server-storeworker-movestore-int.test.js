// tests/server-storeworker-movestore-int.test.js — POST /api/store-location/move
// routed through a REAL core/storeworker.js worker thread (ctx.storeWorker set),
// not the direct synchronous fallback tests/server-backup-int.test.js covers.
//
// Task 3 (store-worker-offload) moved /api/store-location/move's execution onto
// the shared storeWorker when present. The worker's OWN internal ctx (built
// fresh per-run inside the worker thread) does the copy+verify+repoint dance
// against a THROWAWAY context that's closed when the worker exits — it can
// never touch the real main-thread ctx. Only the route handler, after the
// worker resolves {ok:true}, repoints the REAL ctx.storeDir/ctx.db. This file
// proves that repoint actually happens (not just that the worker "succeeds"),
// and that the on-disk config.json store pointer — written once by the
// worker's own internal moveStore() call, and (redundantly, by design) again
// by the route — ends up consistent rather than fighting itself.
const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ISOLATE the config in a temp APPDATA *before* requiring anything that loads
// core/config (core/backup.js's moveStore() calls setStorePath(), which writes
// the REAL %APPDATA%\Interests App\config.json) — same pattern as
// tests/server-backup-int.test.js / tests/storeworker.test.js. Without this a
// killed run would leave the real production store pointer aimed at a temp dir
// (the 2026-07-16 data-loss incident's root cause).
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-ad-"));

const { createServer } = require("../core/server.js");
const { createStoreWorker } = require("../core/storeworker.js");
const { openDb, upsertCard, counts } = require("../core/db.js");
const config = require("../core/config.js");

let pass = 0, fail = 0;
async function run(name, fn) {
  try { await fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); }
}

function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-srvwk-mvstore-"));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}
function listen(app) {
  return new Promise((res) => {
    const srv = http.createServer(app).listen(0, "127.0.0.1", () => {
      res({ srv, base: "http://127.0.0.1:" + srv.address().port });
    });
  });
}

(async () => {
  let srv;
  // No shared config sandbox to restore beyond the isolated APPDATA set above
  // (unlike the backup-int test, which sandboxes/restores config.backupDir).
  await run("POST /api/store-location/move with ctx.storeWorker set repoints the REAL ctx via a real worker thread", async () => {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1 });
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "ia-srvwk-mvtarget-"));
    const ctx = {
      db, storeDir: store,
      getStorePath: () => ctx.storeDir,
      setStorePath: config.setStorePath,
      reopen: function () { try { ctx.db.close(); } catch (e) {} ctx.db = openDb(ctx.storeDir); return ctx.db; },
      storeWorker: createStoreWorker(store),
    };
    const app = createServer(ctx);
    const listening = await listen(app);
    srv = listening.srv;

    const r = await (await fetch(listening.base + "/api/store-location/move", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ target })
    })).json();

    assert.strictEqual(r.ok, true, "move via worker must succeed: " + (r.error || ""));
    assert.strictEqual(r.path, target);
    // The route — not the worker's own throwaway ctx — must be the one that
    // repointed the REAL main-thread ctx.
    assert.strictEqual(ctx.storeDir, target, "real ctx.storeDir repointed by the route handler");
    // ctx.reopen() must have rebound a LIVE handle at the new location, not
    // left a closed one — the exact failure mode tests/server-backup-int.test.js
    // guards for on the direct (no-worker) path.
    assert.strictEqual(counts(ctx.db).cards, 1, "ctx.db reads through the NEW store after the move");
    // The worker's own internal moveStore() call already persisted the store
    // pointer via config.setStorePath(); the route calls ctx.setStorePath(target)
    // again afterward (belt-and-suspenders, since only the route can safely
    // repoint the real ctx). Both must agree, not fight over the last write.
    assert.strictEqual(config.loadConfig().storePath, target, "on-disk store pointer matches — worker's write and the route's write agree");
    assert.ok(fs.existsSync(path.join(target, "interests.db")), "db physically present at target");

    // End-to-end proof for the stale-storeDir-after-move gap: the route must
    // have called ctx.storeWorker.setStoreDir(target), not just repointed the
    // main-thread ctx. If it hadn't, ctx.storeWorker (the SAME object
    // startSyncTimers holds in main.js) would still target the OLD store dir
    // on its next call — the exact scenario that would silently strand the
    // periodic sync timer against an abandoned directory after a move.
    upsertCard(ctx.db, { id: "c2", url: "https://x/2", platform: "fb", cat: "Saved", ts: 2 });
    const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-srvwk-mvstore-sync-"));
    const pub = await ctx.storeWorker.publishSnapshot(ctx, syncDir, "dev1", "Dev1");
    assert.strictEqual(pub.ok, true, "post-move publish must succeed: " + (pub.error || ""));
    const snap = JSON.parse(fs.readFileSync(path.join(syncDir, "dev1", "snapshot.json"), "utf8"));
    assert.ok(snap.cards.some((c) => c.id === "c2"),
      "ctx.storeWorker must publish the NEW store's contents (c2, written only at target) — " +
      "proves the route's setStoreDir call actually repointed the worker, not just ctx");

    await new Promise((res) => srv.close(res));
    try { ctx.db.close(); } catch (e) {}
  });
  console.log(pass + " passed, " + fail + " failed");
  await new Promise((res) => setTimeout(res, 50));
  process.exit(fail ? 1 : 0);
})();
