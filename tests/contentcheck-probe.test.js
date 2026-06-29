const assert = require("assert");
const cc = require("../core/contentcheck");
let passed = 0, failed = 0;
function t(n, fn){ return Promise.resolve().then(fn).then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }

(async () => {
  // Stub DNS so example.test "resolves" to a public IP — the rebinding guard must not touch
  // the real resolver (no network in tests).
  require("../core/linkcheck")._setLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
  const realFetch = global.fetch;
  // Synthetic responses: /dead -> a "page not found" body; /ok -> a real article; no redirects.
  global.fetch = async (url) => {
    const u = String(url);
    const body = /\/dead/.test(u)
      ? "<html><head><title>Page Not Found</title></head><body>404</body></html>"
      : "<html><head><title>Good Article</title></head><body><p>"+"lots of real content ".repeat(10)+"</p></body></html>";
    return {
      status: 200,
      url: u,
      headers: { get: () => null },
      text: async () => body
    };
  };

  await t("fetchContent returns title+snippet for a 200 page", async () => {
    const r = await cc.fetchContent("https://example.test/ok");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.title, "Good Article");
    assert.ok(r.snippet.indexOf("real content") >= 0);
  });

  await t("checkContentChunk classifies dead vs alive and skips social/SSRF", async () => {
    const out = await cc.checkContentChunk([
      { id: "dead",  url: "https://example.test/dead" },
      { id: "ok",    url: "https://example.test/ok" },
      { id: "ig",    url: "https://www.instagram.com/p/x/" },  // social -> skipped, no fetch
      { id: "priv",  url: "http://127.0.0.1:9/" }              // SSRF -> skipped, no fetch
    ]);
    const by = {}; out.forEach(x => by[x.id] = x);
    assert.strictEqual(by.dead.verdict, "suspect");
    assert.strictEqual(by.ok.verdict, "likely-alive");
    assert.strictEqual(by.ig.verdict, "skipped");
    assert.strictEqual(by.priv.verdict, "skipped");
  });

  await t("fetchContent guards the initial url (SSRF) without fetching", async () => {
    let called = false;
    const prev = global.fetch;
    global.fetch = async () => { called = true; return { status: 200, url: "x", headers: { get: () => null }, text: async () => "x" }; };
    const r = await cc.fetchContent("http://127.0.0.1:9/");
    global.fetch = prev;
    assert.strictEqual(called, false, "must not fetch a private host");
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.title, "");
    assert.strictEqual(r.snippet, "");
  });

  await t("fetchContent caps a huge streamed body at maxBytes", async () => {
    const prev = global.fetch;
    const data = new TextEncoder().encode("Z".repeat(5000));
    global.fetch = async (url) => ({
      status: 200, url: String(url), headers: { get: () => null },
      body: new ReadableStream({ start(c){ c.enqueue(data); c.close(); } })
    });
    const r = await cc.fetchContent("https://example.test/big", { maxBytes: 100 });
    global.fetch = prev;
    assert.ok(r.snippet.length <= 100, "snippet should be capped at 100, got " + r.snippet.length);
  });

  global.fetch = realFetch;
  require("../core/linkcheck")._setLookup(null);
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
