const assert = require("assert");
const cm = require("../core/capturemeta");
let passed = 0, failed = 0;
function t(n, fn){ return Promise.resolve().then(fn).then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }

(async () => {
  require("../core/linkcheck")._setLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
  const realFetch = global.fetch;

  await t("captureMetaChunk: page with og:image -> data URL + title; clean image content-type", async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (/\.png/.test(u)) return { ok:true, status:200, url:u, headers:{ get:(k)=> /content-type/i.test(k) ? "image/png" : null }, arrayBuffer: async () => new Uint8Array([1,2,3]).buffer };
      return { ok:true, status:200, url:u, headers:{ get:()=>null }, text: async () => '<meta property="og:image" content="https://img.test/p.png"><title>Hi</title>' };
    };
    const out = await cm.captureMetaChunk([{ id:"c1", url:"https://example.test/page" }]);
    assert.strictEqual(out.length, 1);
    assert.ok(out[0].imageDataUrl.indexOf("data:image/png;base64,") === 0, "expected png data url, got "+out[0].imageDataUrl.slice(0,30));
    assert.strictEqual(out[0].title, "Hi");
    assert.strictEqual(out[0].imageUrl, "");   // download succeeded -> no fallback url needed
  });

  await t("captureMetaChunk: no og:image -> empty imageDataUrl", async () => {
    global.fetch = async (url) => ({ ok:true, status:200, url:String(url), headers:{ get:()=>null }, text: async () => "<title>No image</title>" });
    const out = await cm.captureMetaChunk([{ id:"c2", url:"https://example.test/none" }]);
    assert.strictEqual(out[0].imageDataUrl, "");
    assert.strictEqual(out[0].title, "No image");
  });

  await t("captureMetaChunk: image url with non-image content-type -> empty", async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (/\.bad/.test(u)) return { ok:true, status:200, url:u, headers:{ get:(k)=> /content-type/i.test(k) ? "text/html" : null }, arrayBuffer: async () => new Uint8Array([9]).buffer };
      return { ok:true, status:200, url:u, headers:{ get:()=>null }, text: async () => '<meta property="og:image" content="https://img.test/x.bad">' };
    };
    const out = await cm.captureMetaChunk([{ id:"c3", url:"https://example.test/p" }]);
    assert.strictEqual(out[0].imageDataUrl, "");
  });

  await t("captureMetaChunk: social + private hosts skipped without fetching", async () => {
    let called = false;
    global.fetch = async () => { called = true; return { ok:true, status:200, headers:{get:()=>null}, text: async()=>"" }; };
    const out = await cm.captureMetaChunk([
      { id:"ig", url:"https://www.instagram.com/p/x/" },
      { id:"priv", url:"http://127.0.0.1:9/" }
    ]);
    const by = {}; out.forEach(x=>by[x.id]=x);
    assert.strictEqual(by.ig.skipped, true);
    assert.strictEqual(by.priv.skipped, true);
    assert.strictEqual(called, false, "must not fetch social/SSRF hosts");
  });

  await t("captureMetaChunk: reason = social / unreachable / no-image / image-failed", async () => {
    global.fetch = async (url) => {
      const u = String(url);
      if (/\.png/.test(u)) return { ok:true, status:200, url:u, headers:{ get:(k)=> /content-type/i.test(k) ? "text/html" : null }, arrayBuffer: async () => new Uint8Array([9]).buffer }; // image fetch returns non-image -> image-failed
      if (/\/noimg/.test(u)) return { ok:true, status:200, url:u, headers:{ get:()=>null }, text: async () => "<title>No image here</title>" };
      if (/\/withimg/.test(u)) return { ok:true, status:200, url:u, headers:{ get:()=>null }, text: async () => '<meta property="og:image" content="https://img.test/x.png">' };
      return { ok:false, status:0, url:u, headers:{ get:()=>null }, text: async () => "" }; // unreachable
    };
    const out = await cm.captureMetaChunk([
      { id:"soc", url:"https://www.instagram.com/p/x/" },
      { id:"dead", url:"https://example.test/dead" },
      { id:"noimg", url:"https://example.test/noimg" },
      { id:"imgfail", url:"https://example.test/withimg" }
    ]);
    const by = {}; out.forEach(x=>by[x.id]=x);
    assert.strictEqual(by.soc.reason, "social");
    assert.strictEqual(by.dead.reason, "unreachable");
    assert.strictEqual(by.noimg.reason, "no-image");
    assert.strictEqual(by.imgfail.reason, "image-failed");
    assert.strictEqual(by.imgfail.imageUrl, "https://img.test/x.png");   // download failed -> return the og URL
    assert.strictEqual(by.noimg.imageUrl, "");                            // no og -> no fallback url
  });

  await t("captureMetaChunk: a 200 not-found page never yields an image (no misleading og harvest)", async () => {
    // Real case (2026-07-03): makezine's HTTP-200 custom 404 carries a real og:image of an
    // UNRELATED article — capturing it stamped wrong images onto dead cards. The chunk must
    // detect the 404-shaped page (strong contentcheck signals) and return reason "notfound".
    global.fetch = async (url) => {
      const u = String(url);
      if (/\.jpg/.test(u)) return { ok:true, status:200, url:u, headers:{ get:(k)=> /content-type/i.test(k) ? "image/jpeg" : null }, arrayBuffer: async () => new Uint8Array([1]).buffer };
      return { ok:true, status:200, url:u, headers:{ get:()=>null }, text: async () =>
        '<title>This is not the page you’re looking for... | Make:</title><meta property="og:image" content="https://img.test/unrelated.jpg"><body>'+ "nav shop promo text ".repeat(10) +'</body>' };
    };
    const out = await cm.captureMetaChunk([{ id:"nf", url:"https://example.test/gone-article" }]);
    assert.strictEqual(out[0].imageDataUrl, "", "must not harvest the 404 page's og image");
    assert.strictEqual(out[0].imageUrl, "", "must not return the og url fallback either");
    assert.strictEqual(out[0].reason, "notfound");
  });

  global.fetch = realFetch;
  require("../core/linkcheck")._setLookup(null);
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
