// tests/server-storeworker-backup-int.test.js — POST /api/backup routed through
// a REAL core/storeworker.js worker thread (ctx.storeWorker set), not the
// direct synchronous fallback tests/server-backup-int.test.js covers.
//
// Task 2 (store-worker-offload) moved /api/backup's execution onto the shared
// storeWorker when present. That changed HOW the route classifies a genuine
// backup failure: core/storeworker.js's façade never rejects — a worker-side
// failure resolves {ok:false, error} instead of throwing — so the route's
// catch-block regex (images dir missing / expects N images but only M) must
// be applied to that resolved error too, not just to a thrown exception. This
// file proves both the success path AND that 409 classification survive going
// through the real worker (a mock would not have caught the case where the
// route forgot the extra classification and returned HTTP 200 with {ok:false}).
const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ISOLATE the config in a temp APPDATA *before* requiring anything that loads
// core/config (core/backup.js does) — same pattern as
// tests/server-backup-int.test.js / tests/backup.test.js.
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-ad-"));

const { createServer } = require("../core/server.js");
const { createStoreWorker } = require("../core/storeworker.js");
const { openDb, upsertCard } = require("../core/db.js");
const images = require("../core/images.js");
const config = require("../core/config.js");

const TINY_JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwAH/9k=";

let pass = 0, fail = 0;
async function run(name, fn) {
  try { await fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); }
}

function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-srvwk-store-"));
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
  const bdir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-srvwk-dest-"));
  const orig = config.loadConfig();
  config.saveConfig(Object.assign({}, orig, { backupDir: bdir }));
  let srv;
  try {
    await run("POST /api/backup with ctx.storeWorker set succeeds via the real worker thread", async () => {
      const store = newStore();
      const db = openDb(store);
      upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
      images.putImg(store, "c1", TINY_JPG);
      const ctx = {
        db, storeDir: store,
        getStorePath: () => store, setStorePath: () => {}, reopen: () => openDb(ctx.storeDir),
        storeWorker: createStoreWorker(store),
      };
      const app = createServer(ctx);
      const listening = await listen(app);
      srv = listening.srv;
      const r = await (await fetch(listening.base + "/api/backup", { method: "POST" })).json();
      assert.strictEqual(r.ok, true, "backup via worker must succeed: " + (r.error || ""));
      assert.ok(/^interests-backup-\d{4}-\d{2}-\d{2}$/.test(r.name));
      assert.deepStrictEqual(r.counts, { imported: 1, saved: 0, images: 1 });
      assert.ok(fs.existsSync(path.join(bdir, r.name, "interests.db")), "backup landed at the sandboxed backupRoot");
      await new Promise((res) => srv.close(res));
      try { ctx.db.close(); } catch (e) {}
    });

    await run("POST /api/backup with ctx.storeWorker set still 409s on a genuine store-sanity refusal", async () => {
      // A card that expects a local image but no images/ dir on disk at all —
      // assertStoreLooksSane's "images dir is missing" refusal (core/backup.js).
      // Via the worker this resolves {ok:false, error} rather than throwing, so
      // this specifically exercises the route's post-await classification.
      const store = fs.mkdtempSync(path.join(os.tmpdir(), "ia-srvwk-store-noimg-"));
      // NOTE: deliberately no images/ dir created.
      const db = openDb(store);
      upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
      const ctx = {
        db, storeDir: store,
        getStorePath: () => store, setStorePath: () => {}, reopen: () => openDb(ctx.storeDir),
        storeWorker: createStoreWorker(store),
      };
      const app = createServer(ctx);
      const listening = await listen(app);
      srv = listening.srv;
      const resp = await fetch(listening.base + "/api/backup", { method: "POST" });
      const body = await resp.json();
      assert.strictEqual(resp.status, 409, "must classify the worker's {ok:false} the same way the direct path's throw would");
      assert.strictEqual(body.ok, false);
      assert.ok(/images dir is missing/.test(body.error || ""), "the actionable message must reach the client, not a generic one");
      await new Promise((res) => srv.close(res));
      try { ctx.db.close(); } catch (e) {}
    });
  } finally {
    config.saveConfig(orig || {});
  }
  console.log(pass + " passed, " + fail + " failed");
  await new Promise((res) => setTimeout(res, 50));
  process.exit(fail ? 1 : 0);
})();
