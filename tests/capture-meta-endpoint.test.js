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
  await t("POST /api/capture-meta returns an article excerpt extracted from <p> tags", async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (/\.png/.test(u)) return { ok:true, status:200, url:u, headers:{ get:(k)=> /content-type/i.test(k) ? "image/png" : null }, arrayBuffer: async () => new Uint8Array([137,80,78,71]).buffer };
      return { ok:true, status:200, url:u, headers:{ get:()=>null }, text: async () => '<meta property="og:image" content="https://img.test/p.png"><title>Hi</title><p>A real paragraph of article body text, long enough to be picked up as the grounding excerpt for this test case here.</p>' };
    };
    const r = await req(port, "POST", "/api/capture-meta", { items:[{ id:"e1", url:"https://example.test/excerpt-page" }] });
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.results[0].excerpt.indexOf("real paragraph of article body text") >= 0, "got: " + r.json.results[0].excerpt);
  });
  await t("POST /api/capture-meta with excerptOnly:true does NOT write the image file, even when a real og:image is present", async () => {
    // Task 4 review fix: fetchGroundingExcerpt (the client's grounding-only call) must never
    // overwrite a card's already-captured image. Prove the full route -- not just
    // captureMetaChunk -- never calls images.putImg when the request body sets excerptOnly.
    global.fetch = async (url) => {
      const u = String(url);
      if (/\.png/.test(u)) return { ok:true, status:200, url:u, headers:{ get:(k)=> /content-type/i.test(k) ? "image/png" : null }, arrayBuffer: async () => new Uint8Array([137,80,78,71]).buffer };
      return { ok:true, status:200, url:u, headers:{ get:()=>null }, text: async () => '<meta property="og:image" content="https://img.test/p.png"><title>Hi</title><p>Some real article body content long enough to be picked up as the grounding excerpt for this excerpt-only test case.</p>' };
    };
    const r = await req(port, "POST", "/api/capture-meta", { items:[{ id:"eo1", url:"https://example.test/excerpt-only-page" }], excerptOnly: true });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.results[0].hasImage, false, "excerptOnly must not report an image as captured");
    assert.strictEqual(r.json.results[0].imageUrl, "", "excerptOnly must not return an og-image URL fallback either");
    assert.ok(r.json.results[0].excerpt.indexOf("real article body content") >= 0, "the excerpt should still be extracted: " + r.json.results[0].excerpt);
    assert.strictEqual(images.getImg(store, "eo1"), null, "no image file should have been written for eo1 under excerptOnly");
  });

  await t("items capped at 100", async () => {
    const big = []; for(let i=0;i<150;i++) big.push({ id:"x"+i, url:"https://www.instagram.com/p/"+i+"/" });
    const r = await req(port, "POST", "/api/capture-meta", { items: big });
    assert.ok(r.json.results.length <= 100, "got "+r.json.results.length);
  });

  await t("endpoint returns reason when no image", async () => {
    global.fetch = async (url) => ({ ok:true, status:200, url:String(url), headers:{ get:()=>null }, text: async () => "<title>none</title>" });
    const r = await req(port, "POST", "/api/capture-meta", { items:[{ id:"n1", url:"https://example.test/none" }] });
    assert.strictEqual(r.json.results[0].hasImage, false);
    assert.strictEqual(r.json.results[0].reason, "no-image");
  });

  await t("endpoint returns imageUrl fallback when the image download is blocked", async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (/\.png/.test(u)) return { ok:true, status:200, url:u, headers:{ get:(k)=> /content-type/i.test(k) ? "text/html" : null }, arrayBuffer: async () => new Uint8Array([9]).buffer }; // non-image -> download fails
      return { ok:true, status:200, url:u, headers:{ get:()=>null }, text: async () => '<meta property="og:image" content="https://img.test/y.png">' };
    };
    const r = await req(port, "POST", "/api/capture-meta", { items:[{ id:"u1", url:"https://example.test/withimg" }] });
    assert.strictEqual(r.json.results[0].hasImage, false);
    assert.strictEqual(r.json.results[0].imageUrl, "https://img.test/y.png");
    assert.strictEqual(r.json.results[0].reason, "");
  });

  await new Promise(r => core.close(r));
  ctx.db.close();
  global.fetch = realFetch;
  require("../core/linkcheck")._setLookup(null);
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
