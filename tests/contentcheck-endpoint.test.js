const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path"), http = require("http");
const { buildContext } = require("../core/appctx");
const { createServer } = require("../core/server");
let passed = 0, failed = 0;
function t(n, fn){ return fn().then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }
function tmpStore(){ const d = fs.mkdtempSync(path.join(os.tmpdir(),"ia-cc-")); fs.mkdirSync(path.join(d,"images"),{recursive:true}); return d; }
function listen(app){ return new Promise(r=>{ const s=http.createServer(app); s.listen(0,"127.0.0.1",()=>r({s,port:s.address().port})); }); }
function req(port, method, p, body){ return new Promise((resolve,reject)=>{ const data=body?JSON.stringify(body):null; const r=http.request({host:"127.0.0.1",port,method,path:p,headers:{"Content-Type":"application/json"}},res=>{let b="";res.on("data",c=>b+=c);res.on("end",()=>resolve({status:res.statusCode,json:(()=>{try{return JSON.parse(b)}catch(e){return null}})()}));}); r.on("error",reject); if(data)r.write(data); r.end(); }); }

(async () => {
  // Stub DNS so example.test "resolves" to a public IP — safeToFetch's rebinding guard runs
  // in-process here and must not touch the real resolver (no network in tests).
  require("../core/linkcheck")._setLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
  const realFetch = global.fetch;
  global.fetch = async (url) => ({
    status: 200, url: String(url), headers: { get: () => null },
    text: async () => /\/dead/.test(String(url))
      ? "<title>No longer available</title>"
      : "<title>Real</title><p>"+"plenty of content ".repeat(10)+"</p>"
  });

  const ctx = buildContext(tmpStore());
  const { s: core, port } = await listen(createServer(ctx));

  await t("POST /api/check-content returns a results array", async () => {
    const r = await req(port, "POST", "/api/check-content", { items: [] });
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json.results));
  });
  await t("classifies dead vs alive; skips social", async () => {
    const r = await req(port, "POST", "/api/check-content", { items: [
      { id:"dead", url:"https://example.test/dead" },
      { id:"ok",   url:"https://example.test/ok" },
      { id:"ig",   url:"https://www.instagram.com/p/x/" }
    ], timeoutMs: 2000 });
    const by = {}; r.json.results.forEach(x => by[x.id]=x);
    assert.strictEqual(by.dead.verdict, "suspect");
    assert.strictEqual(by.ok.verdict, "likely-alive");
    assert.strictEqual(by.ig.verdict, "skipped");
  });
  await t("items capped at 200", async () => {
    const big = []; for(let i=0;i<250;i++) big.push({ id:"x"+i, url:"https://www.instagram.com/p/"+i+"/" });
    const r = await req(port, "POST", "/api/check-content", { items: big });
    assert.ok(r.json.results.length <= 200, "got "+r.json.results.length);
  });

  await new Promise(r => core.close(r));
  ctx.db.close();
  global.fetch = realFetch;
  require("../core/linkcheck")._setLookup(null);
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
