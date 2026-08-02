const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path"), http = require("http");
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-notionexp-"));
const { buildContext } = require("../core/appctx");
const { createServer } = require("../core/server");
const config = require("../core/config");
let passed = 0, failed = 0;
function t(n, fn){ return fn().then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }
function tmpStore(){ const d = fs.mkdtempSync(path.join(os.tmpdir(),"ia-notionexpstore-")); fs.mkdirSync(path.join(d,"images"),{recursive:true}); return d; }
function listen(app){ return new Promise(r=>{ const s=http.createServer(app); s.listen(0,"127.0.0.1",()=>r({s,port:s.address().port})); }); }
function req(port, method, p, body){ return new Promise((resolve,reject)=>{ const data=body?JSON.stringify(body):null; const r=http.request({host:"127.0.0.1",port,method,path:p,headers:{"Content-Type":"application/json"}},res=>{let b="";res.on("data",c=>b+=c);res.on("end",()=>resolve({status:res.statusCode,json:(()=>{try{return JSON.parse(b)}catch(e){return null}})()}));}); r.on("error",reject); if(data)r.write(data); r.end(); }); }

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

  await new Promise(r => core.close(r));
  ctx.db.close();
  global.fetch = realFetch;
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
