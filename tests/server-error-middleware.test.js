// tests/server-error-middleware.test.js — Task 2 item 3: the JSON error middleware
// registered LAST in createServer must catch anything that falls through to
// Express's default handler and respond 500 {ok:false, error:"internal"} WITHOUT
// leaking a stack trace. Existing try/catch'd routes are unaffected (they already
// return their own error shapes before ever reaching this middleware).
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-errmw-"));
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
  const app = createServer(ctx);

  // Inject test-only throwing routes. Express matches routes in the order their
  // handlers were pushed onto app._router.stack; createServer() already registered
  // its own routes, the static handler, the /api 404 catch-all, and the error
  // middleware (last), in that order. A route added via app.get() now would be
  // pushed to the END of the stack — AFTER the /api 404 catch-all, which would
  // intercept the request first. So add the routes, then splice their layers to
  // just before the "serveStatic" layer (the first layer after all of
  // createServer's own API routes) — this still exercises the real, unmodified
  // error middleware registered by createServer; only the probe routes' position
  // in the stack is adjusted, not the middleware itself.
  app.get("/api/__test-throw-sync", (req, res) => {
    throw new Error("boom: sensitive stack detail sync");
  });
  // Express 4 does NOT auto-catch a rejected async handler — the app's own async
  // routes (check-links, check-content, etc.) already wrap their bodies in
  // try/catch and respond directly, never relying on this middleware for async
  // errors. This route exercises the explicit next(err) path, which IS how an
  // async error would reach the middleware if a future route forgot try/catch.
  app.get("/api/__test-throw-async", async (req, res, next) => {
    try {
      throw new Error("boom: sensitive stack detail async");
    } catch (e) {
      next(e);
    }
  });
  {
    const stack = app._router.stack;
    const newLayers = stack.splice(stack.length - 2, 2);
    const staticIdx = stack.findIndex((layer) => layer.name === "serveStatic");
    const insertAt = staticIdx === -1 ? stack.length : staticIdx;
    stack.splice(insertAt, 0, ...newLayers);
  }

  const { srv, base } = await listen(app);

  // Silence the expected console.error noise from the middleware during this test.
  const origError = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args); };

  try {
    await t("a route that throws synchronously -> 500 {ok:false, error:'internal'}", async () => {
      const r = await fetch(base + "/api/__test-throw-sync");
      assert.strictEqual(r.status, 500);
      const j = await r.json();
      assert.deepStrictEqual(j, { ok: false, error: "internal" });
    });

    await t("error response body contains no stack frames", async () => {
      const r = await fetch(base + "/api/__test-throw-sync");
      const text = await r.text();
      assert.ok(text.indexOf("boom:") === -1, "message text must not leak");
      assert.ok(text.indexOf(".js:") === -1, "no file:line stack frame markers");
      assert.ok(text.indexOf("at ") === -1, "no 'at ...' stack frame lines");
    });

    await t("the real error is still logged server-side via console.error", async () => {
      logged.length = 0;
      await fetch(base + "/api/__test-throw-sync");
      const sawIt = logged.some((args) => args.some((a) => a instanceof Error && /boom: sensitive stack detail sync/.test(a.message)));
      assert.ok(sawIt, "console.error should have been called with the real Error");
    });

    await t("an async route forwarding an error via next(err) also -> 500 {ok:false, error:'internal'}", async () => {
      const r = await fetch(base + "/api/__test-throw-async");
      assert.strictEqual(r.status, 500);
      const j = await r.json();
      assert.deepStrictEqual(j, { ok: false, error: "internal" });
    });

    // Existing try/catch'd routes are unaffected: their own error shape wins.
    await t("existing try/catch'd route (bad restore name) still returns its own 400 shape, unaffected by the new middleware", async () => {
      const r = await fetch(base + "/api/restore", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "../../evil" }),
      });
      assert.strictEqual(r.status, 400);
      const j = await r.json();
      assert.strictEqual(j.ok, false);
      assert.strictEqual(j.error, "invalid backup name");
    });

    // kv-endpoint helper sanity: capture-request/batch-state/batch-progress still
    // round-trip with their original field names after the jsonKvEndpoints refactor.
    await t("kv endpoints (capture-request/batch-state/batch-progress) round-trip unchanged", async () => {
      const pairs = [
        ["/api/capture-request", "request"],
        ["/api/batch-state", "state"],
        ["/api/batch-progress", "progress"],
      ];
      for (const [route, field] of pairs) {
        const body = {}; body[field] = { hello: route };
        const postRes = await fetch(base + route, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        assert.strictEqual(postRes.status, 200);
        const postJson = await postRes.json();
        assert.deepStrictEqual(postJson, { ok: true });

        const getRes = await fetch(base + route);
        const getJson = await getRes.json();
        assert.deepStrictEqual(getJson[field], { hello: route }, route + " GET returns the field '" + field + "' as posted");
      }
    });
  } finally {
    console.error = origError;
    await new Promise((res) => srv.close(res));
    try { ctx.db.close(); } catch (e) {}
  }

  console.log(pass + " passed, " + fail + " failed");
  process.exitCode = fail ? 1 : 0;
  try { const { getGlobalDispatcher } = require("undici"); getGlobalDispatcher().close(); } catch (_) {}
})();
