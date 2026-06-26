const assert = require("assert");
const http = require("http");
const path = require("path");

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

const { createServer } = require("../core/server.js");
const pkg = require("../package.json");

function listen(appHandler) {
  return new Promise((resolve) => {
    const server = http.createServer(appHandler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

(async () => {
  // Minimal ctx — the ping route ignores it, but createServer must accept it.
  const app = createServer({ db: null, storeDir: path.resolve("data"), getStorePath: () => "", setStorePath: () => {} });
  const { server, port } = await listen(app);
  const base = "http://127.0.0.1:" + port;

  await t("GET /api/ping -> {app:'interests', version}", async () => {
    const res = await fetch(base + "/api/ping");
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.app, "interests");
    assert.strictEqual(body.version, pkg.version);
  });

  await t("GET / serves web/index.html", async () => {
    const res = await fetch(base + "/");
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.ok(text.toLowerCase().includes("<!doctype html") || text.toLowerCase().includes("<html"), "should serve HTML");
  });

  await t("unknown /api route -> 404", async () => {
    const res = await fetch(base + "/api/does-not-exist");
    assert.strictEqual(res.status, 404);
  });

  await new Promise((resolve) => server.close(resolve));
  console.log(pass + " passed, " + fail + " failed");
  // Set exitCode and let the event loop drain naturally instead of calling
  // process.exit(): on Node v25/Windows a forced exit while undici's keep-alive
  // sockets are mid-close aborts with UV_HANDLE_CLOSING. Closing the global
  // dispatcher releases those handles so the process exits promptly and cleanly.
  process.exitCode = fail ? 1 : 0;
  try { const { getGlobalDispatcher } = require("undici"); getGlobalDispatcher().close(); } catch (_) {}
})();
