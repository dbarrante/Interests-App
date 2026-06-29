const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path"), http = require("http");
const { buildContext } = require("../core/appctx");
const { createServer } = require("../core/server");
const images = require("../core/images");
let passed = 0, failed = 0;
function t(n, fn){ return fn().then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }
function tmpStore(){ const d = fs.mkdtempSync(path.join(os.tmpdir(),"ia-cap-")); fs.mkdirSync(path.join(d,"images"),{recursive:true}); return d; }
function listen(app){ return new Promise(r=>{ const s=http.createServer(app); s.listen(0,"127.0.0.1",()=>r({s,port:s.address().port})); }); }
function req(port, method, p, body){ return new Promise((resolve,reject)=>{ const data=body?JSON.stringify(body):null; const r=http.request({host:"127.0.0.1",port,method,path:p,headers:{"Content-Type":"application/json"}},res=>{let b="";res.on("data",c=>b+=c);res.on("end",()=>resolve({status:res.statusCode,json:(()=>{try{return JSON.parse(b)}catch(e){return null}})()}));}); r.on("error",reject); if(data)r.write(data); r.end(); }); }

(async () => {
  require("../core/linkcheck")._setLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (/\.png/.test(u)) return { ok:true, status:200, url:u, headers:{ get:(k)=> /content-type/i.test(k) ? "image/png" : null }, arrayBuffer: async () => new Uint8Array([137,80,78,71]).buffer };
    return { ok:true, status:200, url:u, headers:{ get:()=>null }, text: async () => '<meta property="og:image" content="https://img.test/p.png"><title>Hi</title>' };
  };
  const store = tmpStore();
  const ctx = buildContext(store);
  const { s: core, port } = await listen(createServer(ctx));

  await t("POST /api/capture-meta writes the image file + returns hasImage/title", async () => {
    const r = await req(port, "POST", "/api/capture-meta", { items:[{ id:"c1", url:"https://example.test/page" }] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.results[0].hasImage, true);
    assert.strictEqual(r.json.results[0].title, "Hi");
    assert.ok(images.getImg(store, "c1"), "image file should have been written for c1");
    assert.ok(!("imageDataUrl" in r.json.results[0]), "must not return the data url");
  });
  await t("items capped at 100", async () => {
    const big = []; for(let i=0;i<150;i++) big.push({ id:"x"+i, url:"https://www.instagram.com/p/"+i+"/" });
    const r = await req(port, "POST", "/api/capture-meta", { items: big });
    assert.ok(r.json.results.length <= 100, "got "+r.json.results.length);
  });

  await new Promise(r => core.close(r));
  ctx.db.close();
  global.fetch = realFetch;
  require("../core/linkcheck")._setLookup(null);
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
