// tests/server-storeworker-movestore-int.test.js — POST /api/store-location/move
// routed through a REAL core/storeworker.js worker thread (ctx.storeWorker set),
// not the direct synchronous fallback tests/server-backup-int.test.js covers.
//
// Task 3 (store-worker-offload) moved /api/store-location/move's execution onto
// the shared storeWorker when present. The worker's OWN internal ctx (built
// fresh per-run inside the worker thread) does the copy+verify against a
// THROWAWAY context that's closed when the worker exits — it can never touch
// the real main-thread ctx.
//
// The final review closed three gaps this file now pins down:
//   * F3 — the worker's internal moveStore() used to persist the durable
//     %APPDATA% store pointer itself (setStorePath). A move whose reopen then
//     failed left the pointer at the target while the app kept serving the
//     source: the next launch silently opened the new store and lost every
//     write in between. The ROUTE is now the SOLE writer of that pointer.
//   * F1 — the move had no write-witness. A count-neutral write landing during
//     the off-thread copy (a tag edit, a settings change) lands only in the
//     abandoned source, and moveStore's srcCounts-vs-targetCounts check does
//     not notice. The route now re-checks a write-witness in the same
//     synchronous block as the repoint and refuses instead.
//   * F4 — ia_tabs is now a witnessed kv key, so exactly such a count-neutral
//     write does trip the check.
const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ISOLATE the config in a temp APPDATA *before* requiring anything that loads
// core/config (the ROUTE calls setStorePath(), which writes the REAL
// %APPDATA%\Interests App\config.json) — same pattern as
// tests/server-backup-int.test.js / tests/storeworker.test.js. Without this a
// killed run would leave the real production store pointer aimed at a temp dir
// (the 2026-07-16 data-loss incident's root cause).
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-ad-"));

const { createServer } = require("../core/server.js");
const { createStoreWorker } = require("../core/storeworker.js");
const { openDb, upsertCard, counts, setKV } = require("../core/db.js");
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
// Builds a ctx whose storeWorker is a REAL worker façade, with a hook that runs
// at the exact instant the worker job resolved but BEFORE the route's own
// main-thread continuation (witness re-check + repoint). That is the only point
// from which "did the WORKER persist the pointer?" can be observed separately
// from "did the ROUTE persist it?", and the only point at which a write can be
// injected deterministically into the during-the-copy window.
function makeCtx(store, onWorkerDone) {
  const db = openDb(store);
  const realWorker = createStoreWorker(store);
  const ctx = {
    db, storeDir: store,
    getStorePath: () => ctx.storeDir,
    setStorePath: config.setStorePath,
    reopen: function () { try { ctx.db.close(); } catch (e) {} ctx.db = openDb(ctx.storeDir); return ctx.db; },
    storeWorker: Object.assign(Object.create(null), realWorker, {
      moveStore: function (storeDir, target, after) {
        return realWorker.moveStore(storeDir, target, function (r) {
          if (onWorkerDone) onWorkerDone(r, ctx);
          return after ? after(r) : r;
        });
      },
    }),
  };
  return ctx;
}

(async () => {
  await run("worker-path move: the ROUTE is the sole writer of the durable store pointer, and repoints the REAL ctx", async () => {
    const store = newStore();
    let ctx = null;
    let pointerSeenAfterWorker = "__unset__";
    ctx = makeCtx(store, function () {
      // The worker has finished its copy+verify and exited; the route has not
      // repointed anything yet. Pre-fix, backup.moveStore ran with
      // persistPointer defaulting true INSIDE the worker thread, so the durable
      // pointer already read `target` at this instant.
      pointerSeenAfterWorker = config.loadConfig().storePath;
    });
    upsertCard(ctx.db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1 });
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "ia-srvwk-mvtarget-"));
    const pointerBefore = config.loadConfig().storePath;

    const app = createServer(ctx);
    const listening = await listen(app);

    const r = await (await fetch(listening.base + "/api/store-location/move", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ target })
    })).json();

    assert.strictEqual(r.ok, true, "move via worker must succeed: " + (r.error || ""));
    assert.strictEqual(r.path, target);
    // ---- F3: the worker must NOT have persisted the pointer -----------------
    // This is the assertion that fails against the pre-fix code: with the
    // worker's own setStorePath call in place, pointerSeenAfterWorker === target.
    assert.notStrictEqual(pointerSeenAfterWorker, "__unset__", "the hook must have run — otherwise this proves nothing");
    assert.strictEqual(pointerSeenAfterWorker, pointerBefore,
      "the worker's throwaway ctx must NOT persist the durable store pointer — only the route may, and only after the new location proves it opens");
    // ...and the route then did write it.
    assert.strictEqual(config.loadConfig().storePath, target, "the route persisted the pointer once the move succeeded");
    // The route — not the worker's own throwaway ctx — must be the one that
    // repointed the REAL main-thread ctx.
    assert.strictEqual(ctx.storeDir, target, "real ctx.storeDir repointed by the route handler");
    // ctx.reopen() must have rebound a LIVE handle at the new location, not
    // left a closed one — the exact failure mode tests/server-backup-int.test.js
    // guards for on the direct (no-worker) path.
    assert.strictEqual(counts(ctx.db).cards, 1, "ctx.db reads through the NEW store after the move");
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

    await new Promise((res) => listening.srv.close(res));
    try { ctx.db.close(); } catch (e) {}
  });

  await run("F1/F4: a COUNT-NEUTRAL write during the copy aborts the move instead of being silently dropped", async () => {
    const store = newStore();
    let ctx = null;
    // Injected at the exact instant the worker's copy finished and before the
    // route re-checks its witness — i.e. semantically "a write that landed
    // while the copy was running". ia_tabs (the user's custom tab definitions)
    // is deliberately count-neutral: it changes no card/saved/image count and
    // no mutation revision, so moveStore's own srcCounts-vs-targetCounts check
    // passes and, pre-fix, the move repointed anyway — stranding the new tab in
    // the abandoned source directory. It is also one of the two keys F4 added
    // to WITNESSED_KV_KEYS: without that addition this write is invisible to
    // the witness and this test fails.
    ctx = makeCtx(store, function (r, c) {
      setKV(c.db, "ia_tabs", JSON.stringify([{ id: "t1", name: "Reading", tag: "reading" }]));
    });
    upsertCard(ctx.db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1 });
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "ia-srvwk-mvtarget-abort-"));
    const pointerBefore = config.loadConfig().storePath;

    const app = createServer(ctx);
    const listening = await listen(app);
    const r = await (await fetch(listening.base + "/api/store-location/move", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ target })
    })).json();

    assert.strictEqual(r.ok, false, "the move must REFUSE, not repoint over a write it would strand");
    assert.ok(/received new items/.test(r.error || ""),
      "the abort reason must reach the client (the UI shows result.error): " + JSON.stringify(r.error));
    assert.strictEqual(r.path, store, "the reported path must still be the store the app is actually serving");
    assert.strictEqual(ctx.storeDir, store, "ctx must NOT have been repointed");
    assert.strictEqual(config.loadConfig().storePath, pointerBefore, "the durable pointer must be untouched");
    assert.strictEqual(counts(ctx.db).cards, 1, "ctx.db is still a live handle on the ORIGINAL store");
    // The tab write survives: it is still readable through the live store,
    // which is the whole point — pre-fix it existed only in the abandoned dir.
    assert.ok(fs.existsSync(path.join(store, "interests.db")), "source store intact");
    // Deliberately NOT cleaned up: moveStore never destroys the source, so a
    // refusal leaves the app serving exactly what it was serving and the user
    // can simply retry. Removing the target here would be a delete next to
    // user data that the refusal does not require.
    assert.ok(fs.existsSync(path.join(target, "interests.db")),
      "the worker's copied target is left in place — a refusal must not delete anything");

    await new Promise((res) => listening.srv.close(res));
    try { ctx.db.close(); } catch (e) {}
  });

  await run("F3: a move whose reopen fails leaves NO pointer/ctx split-brain", async () => {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1 });
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "ia-srvwk-mvtarget-reopenfail-"));
    const pointerBefore = config.loadConfig().storePath;

    // Simulate the transient EBUSY / AV-scanner lock on the just-copied db that
    // F3 is about: the FIRST reopen (the one aimed at `target`) throws; the
    // rollback reopen that follows succeeds.
    let failNextReopen = true;
    const realWorker = createStoreWorker(store);
    const ctx = {
      db, storeDir: store,
      getStorePath: () => ctx.storeDir,
      setStorePath: config.setStorePath,
      reopen: function () {
        if (failNextReopen) { failNextReopen = false; throw new Error("EBUSY: simulated AV lock on the just-copied db"); }
        try { ctx.db.close(); } catch (e) {}
        ctx.db = openDb(ctx.storeDir);
        return ctx.db;
      },
      storeWorker: realWorker,
    };

    const app = createServer(ctx);
    const listening = await listen(app);
    const r = await (await fetch(listening.base + "/api/store-location/move", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ target })
    })).json();

    assert.strictEqual(r.ok, false, "a move that cannot open its new location must report failure");
    // THE point of F3. Pre-fix the worker's own moveStore had already written
    // setStorePath(target) by now, so the durable pointer said `target` while
    // the app kept serving `store` — and the next launch opened the new store,
    // silently discarding everything written in between.
    assert.strictEqual(config.loadConfig().storePath, pointerBefore,
      "the durable store pointer must NOT have moved when the app is still serving the old store");
    assert.strictEqual(ctx.storeDir, store, "the live ctx must have been rolled back to the store it is serving");
    assert.strictEqual(counts(ctx.db).cards, 1, "ctx.db must still be a usable handle on the old store");
    assert.strictEqual(r.path, store, "the reported path matches what is actually being served");

    await new Promise((res) => listening.srv.close(res));
    try { ctx.db.close(); } catch (e) {}
  });

  console.log(pass + " passed, " + fail + " failed");
  await new Promise((res) => setTimeout(res, 50));
  process.exit(fail ? 1 : 0);
})();
