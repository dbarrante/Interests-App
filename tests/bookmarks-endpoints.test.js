const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path"), http = require("http");
const { buildContext } = require("../core/appctx");
const { createServer } = require("../core/server");
let passed = 0, failed = 0;
function test(n, fn) { return fn().then(() => { passed++; }).catch(e => { failed++; console.error("FAIL: " + n + "\n  " + (e && e.message)); }); }
function tmpStore() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ia-bmep-")); fs.mkdirSync(path.join(d, "images"), { recursive: true }); return d; }
function listen(app) { return new Promise(r => { const s = http.createServer(app); s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port })); }); }
function get(port, p) { return new Promise((resolve, reject) => { const r = http.request({ host: "127.0.0.1", port, method: "GET", path: p }, res => { let b = ""; res.on("data", c => b += c); res.on("end", () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(b); } catch (e) { return null; } })() })); }); r.on("error", reject); r.end(); }); }

(async () => {
  const ctx = buildContext(tmpStore());
  const { s, port } = await listen(createServer(ctx));
  await test("GET /api/bookmark-sources returns a sources array", async () => {
    const r = await get(port, "/api/bookmark-sources");
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json.sources));
  });
  await test("GET /api/bookmarks with a bogus browser -> 400", async () => {
    const r = await get(port, "/api/bookmarks?browser=bogus&profile=Default");
    assert.strictEqual(r.status, 400);
  });
  s.close(); ctx.db.close();
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
