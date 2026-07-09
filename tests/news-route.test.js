// tests/news-route.test.js — GET /api/news returns {ok,now,items}; caps interest count;
// error path is safe. global.fetch is stubbed to return RSS (no real network).
const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path"), http = require("http");
const { buildContext } = require("../core/appctx");
const { createServer } = require("../core/server");

let pass = 0, fail = 0;
function t(n, fn) { return fn().then(() => { pass++; console.log("  ok  " + n); }).catch((e) => { fail++; console.log("  FAIL " + n + " — " + (e && e.message)); }); }
function tmp() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ia-news-")); fs.mkdirSync(path.join(d, "images"), { recursive: true }); return d; }
function listen(app) { return new Promise((r) => { const s = http.createServer(app); s.listen(0, "127.0.0.1", () => r({ s, port: s.address().port })); }); }
function get(port, p) { return new Promise((resolve, reject) => { const r = http.request({ host: "127.0.0.1", port, method: "GET", path: p }, (res) => { let b = ""; res.on("data", (c) => b += c); res.on("end", () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(b); } catch (e) { return null; } })() })); }); r.on("error", reject); r.end(); }); }

(async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => ({
    status: 200, url: String(url), headers: { get: () => null },
    text: async () => "<rss><channel><item><title>Hi - Src</title><link>https://n.example/1</link><pubDate>Wed, 08 Jul 2026 12:00:00 GMT</pubDate><source url='http://x'>Src</source></item></channel></rss>"
  });

  const ctx = buildContext(tmp());
  const { s: core, port } = await listen(createServer(ctx));

  await t("returns {ok,now,items}", async () => {
    const r = await get(port, "/api/news?interests=woodworking");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.ok(typeof r.json.now === "number");
    assert.ok(Array.isArray(r.json.items) && r.json.items.length >= 1);
    assert.strictEqual(r.json.items[0].title, "Hi");
  });
  await t("no interests → ok with empty items", async () => {
    const r = await get(port, "/api/news?interests=");
    assert.strictEqual(r.json.ok, true);
    assert.deepStrictEqual(r.json.items, []);
  });
  await t("caps interests at 8", async () => {
    const many = Array.from({ length: 20 }, (_, i) => "t" + i).join(",");
    const r = await get(port, "/api/news?interests=" + many);
    assert.strictEqual(r.json.ok, true);   // must not error on a long list
  });

  await new Promise((r) => core.close(r));
  ctx.db.close();
  global.fetch = realFetch;
  console.log("news-route: " + pass + " passed, " + fail + " failed");
  process.exitCode = fail ? 1 : 0;
})();
