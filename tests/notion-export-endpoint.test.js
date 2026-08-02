const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path"), http = require("http");
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-notionexp-"));
const { buildContext } = require("../core/appctx");
const { createServer } = require("../core/server");
const config = require("../core/config");
const notion = require("../core/notion");
let passed = 0, failed = 0;
function t(n, fn){ return fn().then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }
function tmpStore(){ const d = fs.mkdtempSync(path.join(os.tmpdir(),"ia-notionexpstore-")); fs.mkdirSync(path.join(d,"images"),{recursive:true}); return d; }
function listen(app){ return new Promise(r=>{ const s=http.createServer(app); s.listen(0,"127.0.0.1",()=>r({s,port:s.address().port})); }); }
// `extraHeaders` lets a test send a cross-site Origin or a rebound Host. Node's
// http.request honors an explicit Host header (unlike fetch/undici, which pins
// it to the connection authority), so no raw-socket helper is needed here.
function req(port, method, p, body, extraHeaders){ return new Promise((resolve,reject)=>{ const data=body?JSON.stringify(body):null; const headers=Object.assign({"Content-Type":"application/json"}, extraHeaders||{}); const r=http.request({host:"127.0.0.1",port,method,path:p,headers},res=>{let b="";res.on("data",c=>b+=c);res.on("end",()=>resolve({status:res.statusCode,json:(()=>{try{return JSON.parse(b)}catch(e){return null}})()}));}); r.on("error",reject); if(data)r.write(data); r.end(); }); }

(async () => {
  const realFetch = global.fetch;
  const ctx = buildContext(tmpStore());
  const { s: core, port } = await listen(createServer(ctx));

  await t("no token configured -> {ok:false, error:'no_token'}, no fetch attempted", async () => {
    config.setNotionConfig({ token: "", parentPageId: "page-1" });
    let fetchCalled = false;
    global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };
    const r = await req(port, "POST", "/api/notion/export", { title: "T", url: "", article: null, qa: [] });
    assert.strictEqual(r.json.ok, false);
    assert.strictEqual(r.json.error, "no_token");
    assert.strictEqual(fetchCalled, false);
  });

  await t("no parent page configured -> {ok:false, error:'no_parent'}, no fetch attempted", async () => {
    config.setNotionConfig({ token: "secret_x", parentPageId: "" });
    let fetchCalled = false;
    global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };
    const r = await req(port, "POST", "/api/notion/export", { title: "T", url: "", article: null, qa: [] });
    assert.strictEqual(r.json.ok, false);
    assert.strictEqual(r.json.error, "no_parent");
    assert.strictEqual(fetchCalled, false);
  });

  await t("configured + successful Notion call -> {ok:true, pageUrl}", async () => {
    config.setNotionConfig({ token: "secret_x", parentPageId: "page-1" });
    global.fetch = async () => ({ ok: true, json: async () => ({ url: "https://notion.so/xyz" }) });
    const r = await req(port, "POST", "/api/notion/export", { title: "Card Title", url: "https://source.test", article: { text: "Body.", sources: [] }, qa: [] });
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.pageUrl, "https://notion.so/xyz");
  });

  await t("configured + Notion call fails -> {ok:false, error} relayed, HTTP 200 (not a 500 — this is a normal, expected outcome)", async () => {
    config.setNotionConfig({ token: "secret_x", parentPageId: "page-1" });
    global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ message: "bad request" }) });
    const r = await req(port, "POST", "/api/notion/export", { title: "T", url: "", article: null, qa: [] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, false);
    assert.match(r.json.error, /bad request/);
  });

  // --- final-review fix wave, Fix 2: the route's OWN try/catch ---
  // This route used to be the only async route in core/server.js with no
  // try/catch, relying entirely on notion.createPage never rejecting. That
  // guarantee holds today, but it is a convention deviation from all 13 other
  // async routes (including /api/check-safety and /api/safebrowsing-verify,
  // which this feature explicitly mirrors) and one refactor away from turning
  // an unhandled rejection into a hung request / crashed process.

  await t("malformed qa entry ([null]) -> HTTP 200 {ok:false}, no crash", async () => {
    config.setNotionConfig({ token: "secret_x", parentPageId: "page-1" });
    global.fetch = async () => ({ ok: true, json: async () => ({ url: "https://notion.so/should-not-be-reached" }) });
    const r = await req(port, "POST", "/api/notion/export", { title: "T", url: "", article: null, qa: [null] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, false);
    assert.ok(r.json.error, "must carry an error string");
  });

  await t("server is still alive and answering after the malformed-qa request", async () => {
    config.setNotionConfig({ token: "secret_x", parentPageId: "page-1" });
    global.fetch = async () => ({ ok: true, json: async () => ({ url: "https://notion.so/still-alive" }) });
    const r = await req(port, "POST", "/api/notion/export", { title: "T", url: "", article: null, qa: [] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.pageUrl, "https://notion.so/still-alive");
  });

  // The falsifying test for the route-level defense specifically: force
  // createPage itself to REJECT (which its own contract says it never does),
  // proving the route survives it rather than relying on that contract. Without
  // the route's try/catch this request never gets a response at all.
  await t("createPage rejecting -> route still answers HTTP 200 {ok:false} (route-level defense, not createPage's guarantee)", async () => {
    config.setNotionConfig({ token: "secret_x", parentPageId: "page-1" });
    const realCreatePage = notion.createPage;
    try {
      notion.createPage = async () => { throw new Error("simulated createPage contract break"); };
      const r = await req(port, "POST", "/api/notion/export", { title: "T", url: "", article: null, qa: [] });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.ok, false);
      assert.ok(r.json.error, "must carry an error string");
      assert.ok(!/simulated createPage contract break/.test(JSON.stringify(r.json)), "must not leak the raw exception text to the client");
    } finally {
      notion.createPage = realCreatePage;
    }
  });

  await t("server is still alive and answering after a rejecting createPage", async () => {
    config.setNotionConfig({ token: "secret_x", parentPageId: "page-1" });
    global.fetch = async () => ({ ok: true, json: async () => ({ url: "https://notion.so/alive-again" }) });
    const r = await req(port, "POST", "/api/notion/export", { title: "T", url: "", article: null, qa: [] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.pageUrl, "https://notion.so/alive-again");
  });

  // --- Fix 7: the origin/host guards must actually cover this route ---
  // Every test above sends no Origin and a loopback Host, so all of them pass
  // whether or not the guard middleware covers /api/notion/export. These two
  // make that falsifiable: a refactor that mounts this route above the guard
  // chain now turns them red. Note the guard ORDER in core/server.js — the host
  // allowlist runs first, so a bad Host wins over a bad Origin.
  await t("POST with a cross-site Origin -> 403 forbidden origin (guard covers this route)", async () => {
    const r = await req(port, "POST", "/api/notion/export", { title: "T" }, { Origin: "https://evil.example" });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.ok, false);
    assert.strictEqual(r.json.error, "forbidden origin");
  });
  await t("POST with a rebound Host -> 403 forbidden host (guard covers this route)", async () => {
    const r = await req(port, "POST", "/api/notion/export", { title: "T" }, { Host: "evil.example" });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.ok, false);
    assert.strictEqual(r.json.error, "forbidden host");
  });

  await new Promise(r => core.close(r));
  ctx.db.close();
  global.fetch = realFetch;
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
