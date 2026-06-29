const assert = require("assert");
const http = require("http");
const lc = require("../core/linkcheck");
let passed = 0, failed = 0;
function t(n, fn){ return fn().then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }
function listen(handler){ return new Promise(r=>{ const s=http.createServer(handler); s.listen(0,"127.0.0.1",()=>r({s,port:s.address().port})); }); }
// Bind then immediately release a port so connecting to it yields a deterministic
// ECONNREFUSED — no DNS / real-internet (which the constraints forbid and which is flaky).
function closedPort(){ return new Promise(r=>{ const s=http.createServer(); s.listen(0,"127.0.0.1",()=>{ const p=s.address().port; s.close(()=>r(p)); }); }); }

(async () => {
  const { s, port } = await listen((req, res) => {
    if (req.url === "/gone") { res.statusCode = 404; res.end("nope"); return; }
    if (req.url === "/ok")   { res.statusCode = 200; res.end("yep"); return; }
    if (req.url === "/nohead") { if (req.method === "HEAD") { res.statusCode = 405; res.end(); } else { res.statusCode = 200; res.end("ok-via-get"); } return; }
    res.statusCode = 200; res.end("x");
  });
  const base = "http://127.0.0.1:" + port;
  // probeUrl itself does NOT block private IPs (the SSRF guard lives in checkChunk),
  // so it is exercised directly against the local server here.
  await t("probeUrl: 404 -> status 404", async () => {
    const r = await lc.probeUrl(base + "/gone"); assert.strictEqual(r.status, 404);
  });
  await t("probeUrl: 200 -> 2xx", async () => {
    const r = await lc.probeUrl(base + "/ok"); assert.ok(r.status >= 200 && r.status < 300);
  });
  await t("probeUrl: HEAD-405 falls back to GET -> 200", async () => {
    const r = await lc.probeUrl(base + "/nohead"); assert.strictEqual(r.status, 200);
  });
  await t("probeUrl: a refused connection -> ECONNREFUSED, classifies dead", async () => {
    const p = await closedPort();
    const r = await lc.probeUrl("http://127.0.0.1:" + p + "/", { timeoutMs: 3000 });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.code, "ECONNREFUSED");
    assert.strictEqual(lc.classify(r.status, r.code), "dead");
  });
  await t("checkChunk: classifies a live local 404/200 + skips SSRF, social, bad-scheme", async () => {
    // checkChunk SSRF-skips 127.0.0.1, so for the dead/alive verdict we assert via the
    // 'skipped' set here and rely on probeUrl+classify (above) for the dead/alive path.
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
  s.close();
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
