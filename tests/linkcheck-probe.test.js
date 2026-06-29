const assert = require("assert");
const http = require("http");
const lc = require("../core/linkcheck");
let passed = 0, failed = 0;
function t(n, fn){ return fn().then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }
function listen(handler){ return new Promise(r=>{ const s=http.createServer(handler); s.listen(0,"127.0.0.1",()=>r({s,port:s.address().port})); }); }

(async () => {
  const { s, port } = await listen((req, res) => {
    if (req.url === "/gone") { res.statusCode = 404; res.end("nope"); return; }
    if (req.url === "/ok")   { res.statusCode = 200; res.end("yep"); return; }
    if (req.url === "/nohead") { if (req.method === "HEAD") { res.statusCode = 405; res.end(); } else { res.statusCode = 200; res.end("ok-via-get"); } return; }
    res.statusCode = 200; res.end("x");
  });
  const base = "http://127.0.0.1:" + port;
  // probeUrl does NOT block private IPs (the SSRF guard lives in checkChunk), so it is
  // exercised directly against the live local server here. Real fetch, live server.
  await t("probeUrl: 404 -> status 404", async () => {
    const r = await lc.probeUrl(base + "/gone"); assert.strictEqual(r.status, 404);
  });
  await t("probeUrl: 200 -> 2xx", async () => {
    const r = await lc.probeUrl(base + "/ok"); assert.ok(r.status >= 200 && r.status < 300);
  });
  await t("probeUrl: HEAD-405 falls back to GET -> 200", async () => {
    const r = await lc.probeUrl(base + "/nohead"); assert.strictEqual(r.status, 200);
  });
  // Error-path extraction is tested with a fetch stub (deterministic; fetching a real
  // just-closed local port crashes undici on Windows process exit, and real DNS is forbidden).
  await t("probeUrl: a refused connection surfaces ECONNREFUSED (classifies dead)", async () => {
    const real = global.fetch;
    global.fetch = async () => { const e = new TypeError("fetch failed"); e.cause = { code: "ECONNREFUSED" }; throw e; };
    try {
      const r = await lc.probeUrl("http://example.test/", { timeoutMs: 1000 });
      assert.strictEqual(r.status, 0);
      assert.strictEqual(r.code, "ECONNREFUSED");
      assert.strictEqual(lc.classify(r.status, r.code), "dead");
    } finally { global.fetch = real; }
  });
  await t("probeUrl: an aborted request maps to ETIMEDOUT (unknown, not dead)", async () => {
    const real = global.fetch;
    global.fetch = async () => { const e = new Error("aborted"); e.name = "AbortError"; e.code = 20; throw e; };
    try {
      const r = await lc.probeUrl("http://example.test/", { timeoutMs: 1000 });
      assert.strictEqual(r.code, "ETIMEDOUT");
      assert.strictEqual(lc.classify(r.status, r.code), "unknown");
    } finally { global.fetch = real; }
  });
  await t("checkChunk: SSRF (private IP), social, and bad-scheme urls are all skipped without a request", async () => {
    const r = await lc.checkChunk([
      { id: "priv", url: base + "/gone" },                 // private IP -> SSRF-skipped
      { id: "ig", url: "https://www.instagram.com/p/x/" }, // social -> skipped
      { id: "ftp", url: "ftp://example.com/x" },           // bad scheme -> skipped
    ], { concurrency: 4, timeoutMs: 3000 });
    const by = {}; r.forEach(x => by[x.id] = x.status);
    assert.strictEqual(by.priv, "skipped", "private IP is SSRF-skipped, never probed");
    assert.strictEqual(by.ig, "skipped", "instagram is social-skipped");
    assert.strictEqual(by.ftp, "skipped", "non-http(s) scheme is skipped");
  });
  await new Promise(r => s.close(r));
  console.log(passed + " passed, " + failed + " failed");
  // Let the event loop drain rather than process.exit() — forcing exit while an undici
  // socket handle is still closing trips a Windows libuv assertion. Connection:close +
  // a drained loop exits promptly and cleanly. Set the code for the gate.
  process.exitCode = failed ? 1 : 0;
})();
