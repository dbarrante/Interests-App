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
    // find a free port inside [3456..3465] by trying to bind 3460
    let srv;
    try { srv = await pingServer(3460); } catch (e) { console.log("  skip (3460 busy)"); pass++; return; }
    try {
      const port = await probePorts([3456, 3457, 3458, 3459, 3460, 3461], { fetchImpl: (await import("node-fetch").catch(() => ({ default: fetch }))).default });
      assert.strictEqual(port, 3460);
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
