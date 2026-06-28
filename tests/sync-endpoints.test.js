const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path"), http = require("http");
const { buildContext } = require("../core/appctx");
const { createServer } = require("../core/server");
let passed = 0, failed = 0;
function test(n, fn){ return fn().then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }
function tmpStore(){ const d = fs.mkdtempSync(path.join(os.tmpdir(),"ia-ep-")); fs.mkdirSync(path.join(d,"images"),{recursive:true}); return d; }
function listen(app){ return new Promise(r=>{ const s=http.createServer(app); s.listen(0,"127.0.0.1",()=>r({s,port:s.address().port})); }); }
function req(port, method, p, body){ return new Promise((resolve,reject)=>{ const data=body?JSON.stringify(body):null; const r=http.request({host:"127.0.0.1",port,method,path:p,headers:{"Content-Type":"application/json"}},res=>{let b="";res.on("data",c=>b+=c);res.on("end",()=>resolve({status:res.statusCode,json:(()=>{try{return JSON.parse(b)}catch(e){return null}})()}));}); r.on("error",reject); if(data)r.write(data); r.end(); }); }

(async () => {
  const ctx = buildContext(tmpStore());
  const { s, port } = await listen(createServer(ctx));

  await test("GET /api/sync-status returns a shape", async () => {
    const r = await req(port, "GET", "/api/sync-status");
    assert.strictEqual(r.status, 200);
    assert.ok("enabled" in r.json && "deviceId" in r.json);
  });
  await test("POST /api/sync/folder rejects a relative path", async () => {
    const r = await req(port, "POST", "/api/sync/folder", { folder: "relative/dir" });
    assert.strictEqual(r.status, 400);
  });
  await test("PUT /api/cards marks ctx dirty", async () => {
    ctx.syncDirty = false;
    await req(port, "PUT", "/api/cards", { cards: [{ id: "c_1", url: "https://a.com" }] });
    assert.strictEqual(ctx.syncDirty, true);
  });

  s.close(); ctx.db.close();
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
