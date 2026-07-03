// tests/pairing-auth.test.js — dormant pairing-token auth scaffolding + the
// bind-stays-loopback contract for the future LAN mode (review G/Phase 4).
//
// Covers: ensurePairingToken generates a 32-byte (64-hex) token once and is
// stable across reads; getPairingToken is a pure null-until-generated read; the
// Bearer middleware is a pass-through while lanEnabled is off; it enforces
// 401/200 when lanEnabled is on; GET /api/pair-status reports the flag and is
// exempt from the token; and startServer binds 127.0.0.1 even with lanEnabled
// true in config (nothing reads lanEnabled for the bind).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createServer, startServer } = require("../core/server");
const db = require("../core/db");
const config = require("../core/config");

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-pair-"));
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
  const orig = config.loadConfig();
  const bdir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-pair-bk-"));

  try {
    // --- Token lifecycle (config-level) ---
    // Start from a clean slate: no pairingToken persisted.
    config.saveConfig(Object.assign({}, orig, { backupDir: bdir, pairingToken: undefined, lanEnabled: undefined }));

    await t("getPairingToken() is null before generation (pure read, no write)", () => {
      assert.strictEqual(config.getPairingToken(), null);
      assert.strictEqual(config.getPairingToken(), null);   // still null — never wrote
    });
    await t("ensurePairingToken() generates a 64-hex (32-byte) token", () => {
      const tok = config.ensurePairingToken();
      assert.ok(/^[0-9a-f]{64}$/.test(tok), "token is 64 lowercase hex chars");
    });
    await t("token is stable across reads / repeated ensure calls", () => {
      const a = config.getPairingToken();
      const b = config.ensurePairingToken();
      const c = config.getPairingToken();
      assert.strictEqual(a, b);
      assert.strictEqual(b, c);
    });

    const token = config.getPairingToken();
    const storeDir = tmpStore();
    const database = db.openDb(storeDir);
    const ctx = { db: database, storeDir, getStorePath: () => storeDir, setStorePath: () => {}, reopen: () => db.openDb(storeDir) };

    // --- Dormant passthrough (lanEnabled off) ---
    config.saveConfig(Object.assign({}, config.loadConfig(), { lanEnabled: false }));
    {
      const app = createServer(ctx);
      const { srv, base } = await listen(app);
      try {
        await t("lan OFF: GET /api/ping passes through with NO Authorization -> 200", async () => {
          const r = await fetch(base + "/api/ping");
          assert.strictEqual(r.status, 200);
        });
        await t("lan OFF: GET /api/pair-status -> {ok:true, lan:false}", async () => {
          const r = await fetch(base + "/api/pair-status");
          assert.strictEqual(r.status, 200);
          const j = await r.json();
          assert.deepStrictEqual(j, { ok: true, lan: false });
        });
      } finally { await new Promise((res) => srv.close(res)); }
    }

    // --- Enforced (lanEnabled on) ---
    config.saveConfig(Object.assign({}, config.loadConfig(), { lanEnabled: true }));
    {
      const app = createServer(ctx);
      const { srv, base } = await listen(app);
      try {
        await t("lan ON: GET /api/ping with NO token -> 401 unauthorized", async () => {
          const r = await fetch(base + "/api/ping");
          assert.strictEqual(r.status, 401);
          const j = await r.json();
          assert.strictEqual(j.error, "unauthorized");
        });
        await t("lan ON: GET /api/ping with a WRONG token -> 401", async () => {
          const r = await fetch(base + "/api/ping", { headers: { Authorization: "Bearer deadbeef" } });
          assert.strictEqual(r.status, 401);
        });
        await t("lan ON: GET /api/ping with the CORRECT bearer token -> 200", async () => {
          const r = await fetch(base + "/api/ping", { headers: { Authorization: "Bearer " + token } });
          assert.strictEqual(r.status, 200);
        });
        await t("lan ON: GET /api/pair-status is EXEMPT (no token) -> {ok:true, lan:true}", async () => {
          const r = await fetch(base + "/api/pair-status");
          assert.strictEqual(r.status, 200);
          const j = await r.json();
          assert.deepStrictEqual(j, { ok: true, lan: true });
        });
      } finally { await new Promise((res) => srv.close(res)); }
    }

    // --- Bind-stays-loopback contract (even with lanEnabled true) ---
    await t("startServer binds 127.0.0.1 even with lanEnabled=true in config", async () => {
      assert.strictEqual(!!config.loadConfig().lanEnabled, true, "precondition: lanEnabled true");
      const { server, port } = await startServer(ctx, 3456);
      try {
        const addr = server.address();
        assert.strictEqual(addr.address, "127.0.0.1", "bind address is loopback");
        assert.ok(port >= 3456 && port <= 3465, "port in [3456..3465]");
      } finally { await new Promise((res) => server.close(res)); }
    });

    try { ctx.db.close(); } catch (e) {}
  } finally {
    config.saveConfig(orig || {});   // restore the user's real config
  }

  console.log(pass + " passed, " + fail + " failed");
  process.exitCode = fail ? 1 : 0;
  try { const { getGlobalDispatcher } = require("undici"); getGlobalDispatcher().close(); } catch (_) {}
})();
