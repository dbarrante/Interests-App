const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path"), http = require("http");
const { buildContext } = require("../core/appctx");
const { createServer } = require("../core/server");
let passed = 0, failed = 0;
function t(n, fn){ return fn().then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }
function tmpStore(){ const d = fs.mkdtempSync(path.join(os.tmpdir(),"ia-lc-")); fs.mkdirSync(path.join(d,"images"),{recursive:true}); return d; }
function listen(app){ return new Promise(r=>{ const s=http.createServer(app); s.listen(0,"127.0.0.1",()=>r({s,port:s.address().port})); }); }
function req(port, method, p, body){ return new Promise((resolve,reject)=>{ const data=body?JSON.stringify(body):null; const r=http.request({host:"127.0.0.1",port,method,path:p,headers:{"Content-Type":"application/json"}},res=>{let b="";res.on("data",c=>b+=c);res.on("end",()=>resolve({status:res.statusCode,json:(()=>{try{return JSON.parse(b)}catch(e){return null}})()}));}); r.on("error",reject); if(data)r.write(data); r.end(); }); }

(async () => {
  // Stub global.fetch so the in-process endpoint -> checkChunk -> probeUrl probes a
  // SYNTHETIC target deterministically. No real network (constraint), and no undici
  // sockets (so no Windows teardown crash). "/gone" -> 404, otherwise 200.
  const realFetch = global.fetch;
  global.fetch = async (url) => ({ status: /\/gone/.test(String(url)) ? 404 : 200 });

  const ctx = buildContext(tmpStore());
  const { s: core, port } = await listen(createServer(ctx));

  await t("POST /api/check-links returns a results array", async () => {
    const r = await req(port, "POST", "/api/check-links", { items: [], timeoutMs: 2000 });
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json.results));
  });
  await t("endpoint probes + classifies a public target, and skips SSRF/social", async () => {
    const r = await req(port, "POST", "/api/check-links", { items: [
      { id: "dead",  url: "http://example.test/gone" },     // probed (public) -> stub 404 -> dead
      { id: "alive", url: "http://example.test/ok" },        // probed (public) -> stub 200 -> alive
      { id: "priv",  url: "http://127.0.0.1:9/" },           // private IP -> SSRF-skipped
      { id: "ig",    url: "https://www.instagram.com/p/x/" },// social -> skipped
    ], timeoutMs: 2000 });
    assert.strictEqual(r.status, 200);
    const by = {}; r.json.results.forEach(x => by[x.id] = x.status);
    assert.strictEqual(by.dead, "dead");
    assert.strictEqual(by.alive, "alive");
    assert.strictEqual(by.priv, "skipped");
    assert.strictEqual(by.ig, "skipped");
  });
  await t("items list is capped at 200 (no crash on oversize)", async () => {
    const big = []; for (let i=0;i<250;i++) big.push({ id: "x"+i, url: "https://www.instagram.com/p/"+i+"/" });
    const r = await req(port, "POST", "/api/check-links", { items: big, timeoutMs: 2000 });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.results.length <= 200, "got " + r.json.results.length);
  });

  await new Promise(r => core.close(r));
  ctx.db.close();
  global.fetch = realFetch;
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
