// tests/server-backup-int.test.js — backup/restore/health endpoints over HTTP
const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");

const { createServer } = require("../core/server.js");
const { openDb, upsertCard, counts } = require("../core/db.js");
const images = require("../core/images.js");
const config = require("../core/config.js");

const TINY_JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwAH/9k=";

let pass = 0, fail = 0;
function t(name) { return name; }
async function run(name, fn) {
  try { await fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); }
}

function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-srvbk-store-"));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}
function listen(app) {
  return new Promise(function (res) {
    const srv = http.createServer(app).listen(0, "127.0.0.1", function () {
      res({ srv, base: "http://127.0.0.1:" + srv.address().port });
    });
  });
}

(async function () {
  const bdir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-srvbk-dest-"));
  const orig = config.loadConfig();
  config.saveConfig(Object.assign({}, orig, { backupDir: bdir }));
  try {
    const store = newStore();
    let db = openDb(store);
    upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
    images.putImg(store, "c1", TINY_JPG);

    const ctx = {
      db, storeDir: store,
      getStorePath: function () { return store; },
      setStorePath: function () {},
      reopen: function () { return openDb(store); }
    };
    const app = createServer(ctx);
    const { srv, base } = await listen(app);

    await run(t("GET /api/health reports store path + counts"), async () => {
      const h = await (await fetch(base + "/api/health")).json();
      assert.strictEqual(h.storePath, store);
      assert.deepStrictEqual(h.counts, { cards: 1, saved: 0, images: 1 });
      assert.strictEqual(h.lastBackup, null);
    });

    let backupName;
    await run(t("POST /api/backup creates a verified dated backup"), async () => {
      const r = await (await fetch(base + "/api/backup", { method: "POST" })).json();
      assert.strictEqual(r.ok, true);
      assert.ok(/^interests-backup-\d{4}-\d{2}-\d{2}$/.test(r.name));
      assert.deepStrictEqual(r.counts, { imported: 1, saved: 0, images: 1 });
      backupName = r.name;
      assert.ok(fs.existsSync(path.join(bdir, r.name, "interests.db")));
    });

    await run(t("GET /api/backups lists the new backup"), async () => {
      const r = await (await fetch(base + "/api/backups")).json();
      assert.ok(Array.isArray(r.backups));
      assert.strictEqual(r.backups[0].name, backupName);
    });

    await run(t("GET /api/health now shows lastBackup"), async () => {
      const h = await (await fetch(base + "/api/health")).json();
      assert.ok(h.lastBackup && h.lastBackup.name === backupName);
    });

    await run(t("POST /api/restore round-trips and rebinds ctx.db"), async () => {
      // mutate live to 2 cards, then restore the 1-card backup
      upsertCard(ctx.db, { id: "c2", url: "https://x/2", platform: "fb", cat: "Saved", ts: 2, img: "" });
      assert.strictEqual(counts(ctx.db).cards, 2);
      const r = await (await fetch(base + "/api/restore", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: backupName })
      })).json();
      assert.strictEqual(r.ok, true);
      assert.strictEqual(counts(ctx.db).cards, 1, "ctx.db rebound to restored 1-card store");
    });

    await run(t("GET /api/store-location reports path + counts"), async () => {
      const r = await (await fetch(base + "/api/store-location")).json();
      assert.strictEqual(r.path, ctx.storeDir);
      assert.ok(r.counts && typeof r.counts.images === "number");
    });

    await run(t("POST /api/store-location/move relocates the store"), async () => {
      const target = fs.mkdtempSync(path.join(os.tmpdir(), "ia-srvbk-mv-"));
      const r = await (await fetch(base + "/api/store-location/move", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ target })
      })).json();
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.path, target);
      assert.strictEqual(ctx.storeDir, target, "ctx repointed");
      assert.ok(fs.existsSync(path.join(target, "interests.db")), "db at target");
    });

    await new Promise(function (res) { srv.close(res); });
    try { ctx.db.close(); } catch (e) {}
  } finally {
    config.saveConfig(orig || {});
  }
  console.log(pass + " passed, " + fail + " failed");
  // Let libuv finish finalizing the sqlite handle that restore closed in-request
  // before process.exit (avoids a Windows UV_HANDLE_CLOSING abort that would mask
  // the real pass/fail exit code).
  await new Promise(function (res) { setTimeout(res, 50); });
  process.exit(fail ? 1 : 0);
})();
