const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path"), http = require("http");
// Isolate %APPDATA% BEFORE requiring config/server (key writes must not touch real config).
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-sbend-"));
const { buildContext } = require("../core/appctx");
const { createServer } = require("../core/server");
const config = require("../core/config");
let passed = 0, failed = 0;
function t(n, fn){ return fn().then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }
function tmpStore(){ const d = fs.mkdtempSync(path.join(os.tmpdir(),"ia-sb-")); fs.mkdirSync(path.join(d,"images"),{recursive:true}); return d; }
function listen(app){ return new Promise(r=>{ const s=http.createServer(app); s.listen(0,"127.0.0.1",()=>r({s,port:s.address().port})); }); }
function req(port, method, p, body){ return new Promise((resolve,reject)=>{ const data=body?JSON.stringify(body):null; const r=http.request({host:"127.0.0.1",port,method,path:p,headers:{"Content-Type":"application/json"}},res=>{let b="";res.on("data",c=>b+=c);res.on("end",()=>resolve({status:res.statusCode,json:(()=>{try{return JSON.parse(b)}catch(e){return null}})()}));}); r.on("error",reject); if(data)r.write(data); r.end(); }); }

(async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok:true, json: async () => ({ matches:[{ threatType:"MALWARE", threat:{url:"https://bad.test/"} }] }) });

  const ctx = buildContext(tmpStore());
  const { s: core, port } = await listen(createServer(ctx));

  await t("no key set -> {error:'no_key'}", async () => {
    config.setSafeBrowsingKey("");
    const r = await req(port, "POST", "/api/check-safety", { items:[{id:"a",url:"https://bad.test/"}] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.error, "no_key");
  });
  await t("POST key -> hasKey true; GET reflects; key never echoed", async () => {
    const set = await req(port, "POST", "/api/safebrowsing-key", { key:"SECRET" });
    assert.strictEqual(set.json.hasKey, true);
    assert.ok(!("key" in set.json), "must not echo the key");
    const get = await req(port, "GET", "/api/safebrowsing-key");
    assert.strictEqual(get.json.hasKey, true);
    assert.ok(!("key" in get.json), "GET must not return the key");
  });
  await t("with key set, flags bad url, leaves clean url null", async () => {
    const r = await req(port, "POST", "/api/check-safety", { items:[
      {id:"bad", url:"https://bad.test/"},
      {id:"ok",  url:"https://ok.test/"}
    ]});
    const by = {}; r.json.results.forEach(x => by[x.id]=x.threat);
    assert.strictEqual(by.bad, "MALWARE");
    assert.strictEqual(by.ok, null);
  });
  await t("items capped at 500", async () => {
    const big = []; for (let i=0;i<600;i++) big.push({ id:"x"+i, url:"https://x"+i+".test/" });
    const r = await req(port, "POST", "/api/check-safety", { items: big });
    assert.ok(r.json.results.length <= 500, "got "+r.json.results.length);
  });

  await t("GET /api/safebrowsing-verify: none when no key, active when key + 200", async () => {
    config.setSafeBrowsingKey("");
    let r = await req(port, "GET", "/api/safebrowsing-verify");
    assert.strictEqual(r.json.state, "none");
    config.setSafeBrowsingKey("KEY");
    r = await req(port, "GET", "/api/safebrowsing-verify");
    assert.strictEqual(r.json.state, "active");   // stubbed fetch returns ok:true
  });

  await new Promise(r => core.close(r));
  ctx.db.close();
  global.fetch = realFetch;
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
