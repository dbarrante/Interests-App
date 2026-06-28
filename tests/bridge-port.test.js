const assert = require("assert");
const http = require("http");
const { probePorts } = require("../extension/bridge-probe");

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.stack || e)); } }

// stand up a fake /api/ping on a chosen port within the probe range
function pingServer(port) {
  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      if (req.url === "/api/ping") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ app: "interests", version: "test" })); }
      else { res.statusCode = 404; res.end(); }
    });
    s.on("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}

(async () => {
  await t("probePorts finds the first responding interests port", async () => {
    // Bind on an OS-assigned free port so this test never collides with a real
    // app already running on 3456 (which would make probePorts return 3456 and
    // fail the assertion). We probe the exact port we bound.
    const srv = await pingServer(0);
    const realPort = srv.address().port;
    try {
      const port = await probePorts([realPort], { fetchImpl: fetch });
      assert.strictEqual(port, realPort);
    } finally { srv.close(); }
  });

  await t("probePorts returns null when nothing responds", async () => {
    const port = await probePorts([3466, 3467], { fetchImpl: fetch });
    assert.strictEqual(port, null);
  });

  console.log(pass + " passed, " + fail + " failed");
  // Set exitCode and let the event loop drain naturally instead of calling
  // process.exit(): on Node v25/Windows a forced exit while undici's keep-alive
  // sockets / failed-connection cleanup are mid-close aborts with
  // UV_HANDLE_CLOSING. Closing the global dispatcher releases those handles so
  // the process exits promptly and cleanly (same idiom as server-ping.test.js).
  process.exitCode = fail ? 1 : 0;
  try { const { getGlobalDispatcher } = require("undici"); getGlobalDispatcher().close(); } catch (_) {}
})();
