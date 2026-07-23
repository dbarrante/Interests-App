const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createServer } = require("../core/server");
const db = require("../core/db");
const backup = require("../core/backup");

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
function mkTmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// Synthetic backup folder.
const src = mkTmp("ia-apisrc-");
const dataJson = {
  _app: "interests-app", _version: 3, shards: 1,
  _counts: { imported: 1, saved: 0, likes: 0, images: 1 },
  keys: {
    ia_imported: JSON.stringify([{ id: "c1", url: "https://ex.com/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" }]),
    ia_saved: JSON.stringify([]),
    ia_settings: JSON.stringify({ dark: false })
  }
};
fs.writeFileSync(path.join(src, "data.json"), JSON.stringify(dataJson));
fs.writeFileSync(path.join(src, "img-0.json"), JSON.stringify({ c1: PNG }));

// Tmp store + server.
const storeDir = mkTmp("ia-apistore-");
fs.mkdirSync(path.join(storeDir, "images"), { recursive: true });
const database = db.openDb(storeDir);
const app = createServer({ db: database, storeDir: storeDir, getStorePath: () => storeDir, setStorePath: () => {} });
const server = http.createServer(app);

async function run() {
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const port = server.address().port;
  const base = "http://127.0.0.1:" + port;

  const realRunBackup = backup.runBackup;
  const realVerifyBackup = backup.verifyBackup;
  backup.runBackup = function () { return { name: "synthetic-safety", counts: { imported: 0, saved: 0, images: 0 } }; };
  backup.verifyBackup = function () { return true; };
  let ok;
  try {
    ok = await fetch(base + "/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ srcDir: src })
    });
  } finally {
    backup.runBackup = realRunBackup;
    backup.verifyBackup = realVerifyBackup;
  }
  const body = await ok.json();

  await t("POST /api/import returns 200", () => { assert.strictEqual(ok.status, 200); });
  await t("body reports 1 card, 0 saved, 1 image, empty missing", () => {
    assert.strictEqual(body.cards, 1);
    assert.strictEqual(body.saved, 0);
    assert.strictEqual(body.images, 1);
    assert.deepStrictEqual(body.missing, []);
  });
  await t("rows landed: GET /api/cards returns the imported card", async () => {
    const r = await fetch(base + "/api/cards");
    const j = await r.json();
    assert.strictEqual(j.cards.length, 1);
    assert.strictEqual(j.cards[0].id, "c1");
  });

  await t("legacy import fails closed when the safety backup cannot be written", async () => {
    const original = backup.runBackup;
    backup.runBackup = function () { throw new Error("simulated disk full"); };
    try {
      const blocked = await fetch(base + "/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ srcDir: src })
      });
      assert.strictEqual(blocked.status, 409);
      const cards = await (await fetch(base + "/api/cards")).json();
      assert.strictEqual(cards.cards.length, 1, "failed safety backup must not alter the live store");
    } finally { backup.runBackup = original; }
  });

  // Bad srcDir (no data.json) -> 400.
  const badDir = mkTmp("ia-apibad-");
  const bad = await fetch(base + "/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ srcDir: badDir })
  });
  await t("missing data.json -> HTTP 400 with error", async () => {
    assert.strictEqual(bad.status, 400);
    const bj = await bad.json();
    assert.strictEqual(typeof bj.error, "string");
  });

  await new Promise((res) => server.close(res));
  try { database.close(); } catch (e) {}
  console.log(pass + " passed, " + fail + " failed");
  // Set exitCode and let the event loop drain naturally instead of calling
  // process.exit(): on Node v25/Windows a forced exit while undici's keep-alive
  // sockets are mid-close aborts with UV_HANDLE_CLOSING. Closing the global
  // dispatcher releases those handles so the process exits promptly and cleanly.
  process.exitCode = fail ? 1 : 0;
  try { const { getGlobalDispatcher } = require("undici"); getGlobalDispatcher().close(); } catch (_) {}
}
run();
