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
function req(port, method, p, body){ return new Promise((resolve,reject)=>{ const data=body?JSON.stringify(body):null; const r=http.request({host:"127.0.0.1",port,method,path:p,headers:{"Content-Type":"application/json"}},res=>{let b="";res.on("data",c=>b+=c);res.on("end",()=>resolve({status:res.statusCode,json:(()=>{try{return JSON.parse(b)}catch(e){return null}})()}));}); r.on("error",reject); if(data)r.write(data); r.end(); }); }

(async () => {
  const ctx = buildContext(tmpStore());
  const { s: core, port } = await listen(createServer(ctx));

  await t("GET with nothing set -> hasToken:false, hasParent:false", async () => {
    config.setNotionConfig({ token: "", parentPageId: "" });
    const r = await req(port, "GET", "/api/notion-config");
    assert.deepStrictEqual(r.json, { hasToken: false, hasParent: false });
  });
  await t("POST sets both, response never echoes the raw values", async () => {
    const r = await req(port, "POST", "/api/notion-config", { token: "secret_x", parentPageId: "page1" });
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.hasToken, true);
    assert.strictEqual(r.json.hasParent, true);
    assert.ok(!("token" in r.json), "must not echo the token");
    assert.ok(!("parentPageId" in r.json), "must not echo the parent page id");
  });
  await t("GET after POST reflects hasToken/hasParent, still never echoes values", async () => {
    const r = await req(port, "GET", "/api/notion-config");
    assert.deepStrictEqual(r.json, { hasToken: true, hasParent: true });
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

  await new Promise(r => core.close(r));
  ctx.db.close();
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
