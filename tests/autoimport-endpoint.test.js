// tests/autoimport-endpoint.test.js — POST/GET /api/auto-import* mounted on a
// real createServer() instance (ephemeral port), driven over HTTP. Same
// pattern as tests/bstumble-mailbox.test.js and tests/pairing-auth.test.js.
const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");

const { createServer } = require("../core/server.js");
const { openDb, setKV } = require("../core/db.js");
const config = require("../core/config.js");

let pass = 0, fail = 0;
async function run(name, fn) {
  try { await fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.stack || e)); }
}
function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-autoimport-ep-"));
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
function jget(base, route, headers) { return fetch(base + route, { headers }).then((r) => r.json().then((j) => ({ status: r.status, body: j }))); }
function jpost(base, route, body, headers) {
  return fetch(base + route, { method: "POST", headers: Object.assign({ "content-type": "application/json" }, headers), body: JSON.stringify(body) })
    .then((r) => r.json().then((j) => ({ status: r.status, body: j })).catch(() => ({ status: r.status, body: null })));
}
function fbItem(over) {
  return Object.assign({ url: "https://facebook.com/posts/aaa", title: "A saved post", image: "", platformKey: "fb_ep_1" }, over);
}

(async function () {
  const store = newStore();
  const db = openDb(store);
  const ctx = { db, storeDir: store, getStorePath: () => store, setStorePath: () => {}, reopen: () => openDb(ctx.storeDir) };
  const app = createServer(ctx);
  const { srv, base } = await listen(app);

  await run("config: defaults off / both platforms on when ia_settings is unset", async () => {
    const r = await jget(base, "/api/auto-import/config");
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { on: false, platforms: { fb: true, ig: true } });
  });

  await run("config: reflects ia_settings JSON once the renderer writes it via PUT /api/kv", async () => {
    await fetch(base + "/api/kv/ia_settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: JSON.stringify({ autoImportOn: true, autoImportIg: false }) }) });
    const r = await jget(base, "/api/auto-import/config");
    assert.deepStrictEqual(r.body, { on: true, platforms: { fb: true, ig: false } });
  });

  await run("request mailbox: POST sets it, GET reads it, POST {request:null} clears it (mirrors /api/capture-request)", async () => {
    await jpost(base, "/api/auto-import/request", { request: { manual: true, nonce: "n1" } });
    let r = await jget(base, "/api/auto-import/request");
    assert.strictEqual(r.body.request.nonce, "n1");
    await jpost(base, "/api/auto-import/request", { request: null });
    r = await jget(base, "/api/auto-import/request");
    assert.strictEqual(r.body.request, null);
  });

  await run("POST /api/auto-import: unknown platform -> 400", async () => {
    const r = await jpost(base, "/api/auto-import", { platform: "tw", status: "ok", items: [] });
    assert.strictEqual(r.status, 400);
  });

  await run("POST /api/auto-import: >200 items -> 400 (batch rejected, not truncated)", async () => {
    const items = [];
    for (let i = 0; i < 201; i++) items.push(fbItem({ url: "https://facebook.com/flood/" + i, platformKey: "flood_" + i }));
    const r = await jpost(base, "/api/auto-import", { platform: "fb", status: "ok", checkedAt: 1, items });
    assert.strictEqual(r.status, 400);
    const caps = await jget(base, "/api/captures");
    assert.strictEqual(caps.body.captures.length, 0, "nothing from the rejected flood reaches the mailbox");
  });

  await run("POST /api/auto-import: oversized body (>1MB) -> 413", async () => {
    const huge = "A".repeat(1024 * 1024 + 100);
    const r = await jpost(base, "/api/auto-import", { platform: "fb", status: "ok", checkedAt: 1, items: [fbItem({ image: huge })] });
    assert.strictEqual(r.status, 413);
  });

  await run("POST /api/auto-import: happy path lands the survivor in the capture mailbox, ledgers it, records status", async () => {
    const r = await jpost(base, "/api/auto-import", { platform: "fb", status: "ok", checkedAt: 12345, items: [fbItem()] });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { ok: true, added: 1, duplicates: 0, status: "ok" });

    // Drains via the SAME GET /api/captures the extension's manual captures use.
    const caps = await jget(base, "/api/captures");
    assert.strictEqual(caps.body.captures.length, 1);
    const c = caps.body.captures[0];
    assert.strictEqual(c.url, "https://facebook.com/posts/aaa");
    assert.strictEqual(c.title, "A saved post");
    assert.ok(!c.clip, "no clip flag — source is the discriminator, routing is the renderer's job");
    assert.strictEqual(c.source, "fb-auto");
    assert.strictEqual(c.ts, 12345);

    // GET /api/captures clears the mailbox — drained exactly once.
    const caps2 = await jget(base, "/api/captures");
    assert.strictEqual(caps2.body.captures.length, 0);

    const status = await jget(base, "/api/auto-import/status");
    assert.strictEqual(status.body.fb.added, 1);
    assert.strictEqual(status.body.fb.duplicates, 0);
    assert.strictEqual(status.body.fb.status, "ok");
    assert.strictEqual(status.body.ig, null);
  });

  await run("POST /api/auto-import: a second identical batch is fully ledger-blocked (even though the capture mailbox was already drained — deleted-in-app scenario)", async () => {
    const r = await jpost(base, "/api/auto-import", { platform: "fb", status: "ok", checkedAt: 99999, items: [fbItem()] });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { ok: true, added: 0, duplicates: 1, status: "ok" });
    const caps = await jget(base, "/api/captures");
    assert.strictEqual(caps.body.captures.length, 0, "nothing new reaches the mailbox for a ledger-blocked duplicate");
    const status = await jget(base, "/api/auto-import/status");
    assert.strictEqual(status.body.fb.added, 0);
    assert.strictEqual(status.body.fb.duplicates, 1);
  });

  await run("POST /api/auto-import: login-required status imports nothing and is reflected in status", async () => {
    const r = await jpost(base, "/api/auto-import", { platform: "ig", status: "login-required", checkedAt: 1, items: [] });
    assert.deepStrictEqual(r.body, { ok: true, added: 0, duplicates: 0, status: "login-required" });
    const status = await jget(base, "/api/auto-import/status");
    assert.strictEqual(status.body.ig.status, "login-required");
    assert.strictEqual(status.body.ig.found, 0);
  });

  await new Promise((res) => srv.close(res));

  // --- Auth: same pairing-token gate as everything else (config.lanEnabled) ---
  // Reuses tests/pairing-auth.test.js's exact pattern: flip lanEnabled on a
  // fresh ctx/app, restore the real config in a finally.
  const orig = config.loadConfig();
  try {
    const store2 = newStore();
    const db2 = openDb(store2);
    const ctx2 = { db: db2, storeDir: store2, getStorePath: () => store2, setStorePath: () => {}, reopen: () => openDb(ctx2.storeDir) };
    config.saveConfig(Object.assign({}, orig, { lanEnabled: true }));
    const token = config.ensurePairingToken();
    const app2 = createServer(ctx2);
    const { srv: srv2, base: base2 } = await listen(app2);
    try {
      await run("auth: POST /api/auto-import with NO token -> 401 (same gate as /api/captures)", async () => {
        const r = await fetch(base2 + "/api/auto-import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ platform: "fb", status: "ok", items: [] }) });
        assert.strictEqual(r.status, 401);
      });
      await run("auth: GET /api/auto-import/config with NO token -> 401", async () => {
        const r = await fetch(base2 + "/api/auto-import/config");
        assert.strictEqual(r.status, 401);
      });
      await run("auth: WITH the correct bearer token -> passes through to the route", async () => {
        const r = await fetch(base2 + "/api/auto-import/config", { headers: { Authorization: "Bearer " + token } });
        assert.strictEqual(r.status, 200);
      });
      await run("auth: POST /api/auto-import WITH the correct token -> 200", async () => {
        const r = await fetch(base2 + "/api/auto-import", { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer " + token }, body: JSON.stringify({ platform: "fb", status: "ok", checkedAt: 1, items: [fbItem({ platformKey: "auth_ok_1" })] }) });
        assert.strictEqual(r.status, 200);
      });
    } finally { await new Promise((res) => srv2.close(res)); }
  } finally {
    config.saveConfig(orig || {});   // restore the user's real config, exactly like pairing-auth.test.js
  }

  console.log("autoimport-endpoint: " + pass + " passed, " + fail + " failed");
  process.exitCode = fail ? 1 : 0;
  try { const { getGlobalDispatcher } = require("undici"); getGlobalDispatcher().close(); } catch (_) {}
})();
