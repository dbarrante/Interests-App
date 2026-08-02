const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path"), http = require("http");
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-notionend-"));
const { buildContext } = require("../core/appctx");
const { createServer } = require("../core/server");
const config = require("../core/config");
let passed = 0, failed = 0;
function t(n, fn){ return fn().then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }
function tmpStore(){ const d = fs.mkdtempSync(path.join(os.tmpdir(),"ia-notionstore-")); fs.mkdirSync(path.join(d,"images"),{recursive:true}); return d; }
function listen(app){ return new Promise(r=>{ const s=http.createServer(app); s.listen(0,"127.0.0.1",()=>r({s,port:s.address().port})); }); }
// `extraHeaders` lets a test send a cross-site Origin or a rebound Host. Node's
// http.request honors an explicit Host header (unlike fetch/undici, which pins
// it to the connection authority), so no raw-socket helper is needed here.
function req(port, method, p, body, extraHeaders){ return new Promise((resolve,reject)=>{ const data=body?JSON.stringify(body):null; const headers=Object.assign({"Content-Type":"application/json"}, extraHeaders||{}); const r=http.request({host:"127.0.0.1",port,method,path:p,headers},res=>{let b="";res.on("data",c=>b+=c);res.on("end",()=>resolve({status:res.statusCode,json:(()=>{try{return JSON.parse(b)}catch(e){return null}})()}));}); r.on("error",reject); if(data)r.write(data); r.end(); }); }

(async () => {
  const ctx = buildContext(tmpStore());
  const { s: core, port } = await listen(createServer(ctx));

  await t("GET with nothing set -> hasToken:false, hasParent:false, parentPageId:''", async () => {
    config.setNotionConfig({ token: "", parentPageId: "" });
    const r = await req(port, "GET", "/api/notion-config");
    assert.deepStrictEqual(r.json, { hasToken: false, hasParent: false, parentPageId: "" });
  });
  await t("POST sets both, response never echoes the raw values", async () => {
    const r = await req(port, "POST", "/api/notion-config", { token: "secret_x", parentPageId: "page1" });
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.hasToken, true);
    assert.strictEqual(r.json.hasParent, true);
    assert.ok(!("token" in r.json), "must not echo the token");
    assert.ok(!("parentPageId" in r.json), "must not echo the parent page id");
  });
  await t("GET after POST reflects hasToken/hasParent and echoes parentPageId (not a secret) but never the token", async () => {
    const r = await req(port, "GET", "/api/notion-config");
    assert.deepStrictEqual(r.json, { hasToken: true, hasParent: true, parentPageId: "page1" });
    assert.ok(!("token" in r.json), "must never echo the token itself");
  });
  await t("POST with only parentPageId in the body leaves the previously-set token untouched (key omitted, not cleared)", async () => {
    config.setNotionConfig({ token: "secret_z", parentPageId: "old-page" });
    const r = await req(port, "POST", "/api/notion-config", { parentPageId: "new-page" });
    assert.strictEqual(r.json.hasToken, true, "token key was never in the request body — must survive");
    assert.strictEqual(r.json.hasParent, true);
    assert.strictEqual(config.getNotionConfig().token, "secret_z", "the actual stored token must be unchanged");
    assert.strictEqual(config.getNotionConfig().parentPageId, "new-page");
  });
  await t("POST with token explicitly set to empty string clears it, even though the key is present", async () => {
    config.setNotionConfig({ token: "secret_zz", parentPageId: "p" });
    const r = await req(port, "POST", "/api/notion-config", { token: "" });
    assert.strictEqual(r.json.hasToken, false);
    assert.strictEqual(config.getNotionConfig().parentPageId, "p", "parentPageId key was omitted — must be untouched");
  });

  // --- final-review fix wave, Fix 7: the origin/host guards must actually
  // cover this route. Every test above sends no Origin and a loopback Host, so
  // all of them pass whether or not the guard middleware covers
  // /api/notion-config — a refactor that mounted it above the guard chain would
  // keep them green while exposing a token-writing endpoint to any web page.
  // These two make that falsifiable. Guard ORDER in core/server.js matters: the
  // host allowlist runs first, so a bad Host wins over a bad Origin.
  await t("POST with a cross-site Origin -> 403 forbidden origin (guard covers this token-writing route)", async () => {
    const before = config.getNotionConfig();
    const r = await req(port, "POST", "/api/notion-config", { token: "attacker_token", parentPageId: "attacker-page" }, { Origin: "https://evil.example" });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.ok, false);
    assert.strictEqual(r.json.error, "forbidden origin");
    assert.deepStrictEqual(config.getNotionConfig(), before, "a rejected request must not have written anything");
  });
  await t("POST with a rebound Host -> 403 forbidden host (guard covers this token-writing route)", async () => {
    const before = config.getNotionConfig();
    const r = await req(port, "POST", "/api/notion-config", { token: "attacker_token", parentPageId: "attacker-page" }, { Host: "evil.example" });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.ok, false);
    assert.strictEqual(r.json.error, "forbidden host");
    assert.deepStrictEqual(config.getNotionConfig(), before, "a rejected request must not have written anything");
  });
  await t("GET with a cross-site Origin -> 403 forbidden origin (no status leak to a web page)", async () => {
    const r = await req(port, "GET", "/api/notion-config", null, { Origin: "https://evil.example" });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.error, "forbidden origin");
  });

  await new Promise(r => core.close(r));
  ctx.db.close();
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
