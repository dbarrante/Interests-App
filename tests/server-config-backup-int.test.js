// tests/server-config-backup-int.test.js — POST /api/config-backup/export
// and /import over real HTTP, against a real Core service instance.
const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");

process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-ad-"));

const { createServer } = require("../core/server.js");
const { openDb, setKV, getKV } = require("../core/db.js");
const config = require("../core/config.js");

let pass = 0, fail = 0;
async function run(name, fn) {
  try { await fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); }
}
function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-cbsrv-store-"));
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
  const store = newStore();
  let db = openDb(store);
  const ctx = { db, storeDir: store, getStorePath: () => store, setStorePath: () => {}, reopen: () => openDb(ctx.storeDir) };
  const app = createServer(ctx);
  const { srv, base } = await listen(app);

  await run("POST /api/config-backup/export requires a password (400, not 500)", async () => {
    const r = await fetch(base + "/api/config-backup/export", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
    assert.strictEqual(r.status, 400);
    const j = await r.json();
    assert.strictEqual(j.ok, false);
  });

  setKV(ctx.db, "ia_settings", JSON.stringify({ provider: "gemini", keys: { gemini: "super-secret-key" }, updateToken: "device-A-token", itemCount: 7 }));
  config.setNotionConfig({ token: "notion-secret", parentPageId: "page-1" });
  config.setSafeBrowsingKey("sb-secret");

  let envelope;
  await run("POST /api/config-backup/export returns an envelope whose ciphertext does not contain the plaintext key", async () => {
    const r = await (await fetch(base + "/api/config-backup/export", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct-horse" }),
    })).json();
    assert.strictEqual(r.ok, true);
    assert.ok(r.envelope && r.envelope.ciphertext);
    assert.ok(r.envelope.ciphertext.indexOf("super-secret-key") === -1, "the raw key must never appear in the ciphertext blob");
    envelope = r.envelope;
  });

  await run("POST /api/config-backup/import with the WRONG password leaves ia_settings byte-for-byte unchanged", async () => {
    const before = getKV(ctx.db, "ia_settings");
    const r = await fetch(base + "/api/config-backup/import", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "totally-wrong", envelope }),
    });
    assert.strictEqual(r.status, 400);
    const j = await r.json();
    assert.strictEqual(j.ok, false);
    assert.ok(/wrong password/i.test(j.error));
    assert.strictEqual(getKV(ctx.db, "ia_settings"), before, "a failed decrypt must never touch the live store");
  });

  // Simulate "restoring onto a DIFFERENT device": that device's own settings
  // (including its OWN updateToken) are different from what was exported above.
  setKV(ctx.db, "ia_settings", JSON.stringify({ provider: "openai", updateToken: "device-B-own-token", itemCount: 1 }));

  await run("POST /api/config-backup/import with the RIGHT password full-replaces settings but preserves THIS device's updateToken", async () => {
    const r = await (await fetch(base + "/api/config-backup/import", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct-horse", envelope }),
    })).json();
    assert.strictEqual(r.ok, true);
    const after = JSON.parse(getKV(ctx.db, "ia_settings"));
    assert.strictEqual(after.provider, "gemini", "provider must come from the imported (device A's) settings");
    assert.strictEqual(after.keys.gemini, "super-secret-key");
    assert.strictEqual(after.itemCount, 7);
    assert.strictEqual(after.updateToken, "device-B-own-token", "updateToken must stay THIS device's own, never device A's (it wasn't even in the export)");
  });

  await run("Notion token / parent page / Safe Browsing key round-trip through the same import", async () => {
    const n = config.getNotionConfig();
    assert.strictEqual(n.token, "notion-secret");
    assert.strictEqual(n.parentPageId, "page-1");
    assert.strictEqual(config.getSafeBrowsingKey(), "sb-secret");
  });

  await run("A pre-import safety snapshot was written before the import applied", async () => {
    const snapPath = path.join(config.appDataDir(), "config-import-safety.json");
    assert.ok(fs.existsSync(snapPath));
    const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));
    assert.strictEqual(snap.settings.provider, "openai", "must capture device B's PRE-import state, not device A's just-applied settings");
  });

  await run("POST /api/config-backup/import with no envelope is a 400, not a 500", async () => {
    const r = await fetch(base + "/api/config-backup/import", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "correct-horse" }),
    });
    assert.strictEqual(r.status, 400);
  });

  await new Promise((res) => srv.close(res));
  try { ctx.db.close(); } catch (e) {}
  console.log(pass + " passed, " + fail + " failed");
  await new Promise((res) => setTimeout(res, 50));
  process.exit(fail ? 1 : 0);
})();
