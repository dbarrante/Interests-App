const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createServer } = require("../core/server");
const db = require("../core/db");

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-focus-"));
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
  const storeDir = tmpStore();
  const database = db.openDb(storeDir);
  const ctx = { db: database, storeDir, getStorePath: () => storeDir, setStorePath: () => {}, reopen: () => db.openDb(storeDir) };

  {
    let calls = 0;
    ctx.focusApp = () => { calls++; };
    const app = createServer(ctx);
    const { srv, base } = await listen(app);
    try {
      await t("POST /api/focus-app calls ctx.focusApp() and responds ok:true", async () => {
        const r = await fetch(base + "/api/focus-app", { method: "POST" });
        assert.strictEqual(r.status, 200);
        const j = await r.json();
        assert.deepStrictEqual(j, { ok: true });
        assert.strictEqual(calls, 1);
      });
    } finally { await new Promise((res) => srv.close(res)); }
  }

  {
    delete ctx.focusApp;
    const app = createServer(ctx);
    const { srv, base } = await listen(app);
    try {
      await t("POST /api/focus-app is a safe no-op (still ok:true, never throws) when ctx.focusApp is absent", async () => {
        const r = await fetch(base + "/api/focus-app", { method: "POST" });
        assert.strictEqual(r.status, 200);
        const j = await r.json();
        assert.deepStrictEqual(j, { ok: true });
      });
    } finally { await new Promise((res) => srv.close(res)); }
  }

  try { ctx.db.close(); } catch (e) {}
  console.log(pass + " passed, " + fail + " failed");
  process.exitCode = fail ? 1 : 0;
  try { const { getGlobalDispatcher } = require("undici"); getGlobalDispatcher().close(); } catch (_) {}
})();
