// tests/cardimage-endpoint.test.js — the HTTP surface of the card-image fetch.
const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-cie-"));

const { createServer } = require("../core/server.js");
const { openDb, upsertCard } = require("../core/db.js");
const linkcheck = require("../core/linkcheck.js");

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }
function listen(app) {
  return new Promise((res) => { const s = http.createServer(app).listen(0, "127.0.0.1", () => res({ s, base: "http://127.0.0.1:" + s.address().port })); });
}
function newStore() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ia-cie-store-")); fs.mkdirSync(path.join(d, "images"), { recursive: true }); return d; }

(async function () {
  const store = newStore();
  const db = openDb(store);
  upsertCard(db, { id: "local", url: "https://x/1", img: "idb:local" });
  upsertCard(db, { id: "blocked", url: "https://x/2", img: "https://127.0.0.1/a.png" });
  // A card whose remote image WOULD succeed — this is the case none of the
  // brief's given tests exercise. Without it, a route that just always
  // returns the generic 404 (never actually calling cardimage.fetchCardImage)
  // would pass every other test in this file.
  upsertCard(db, { id: "remote", url: "https://x/3", img: "https://img.test/pic.png" });
  const ctx = { db, storeDir: store, reopen: () => openDb(store) };
  const { s, base } = await listen(createServer(ctx));

  async function post(body) {
    const r = await fetch(base + "/api/fetch-card-image", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, ct, text: /json/.test(ct) ? JSON.stringify(await r.json()) : "", raw: r };
  }

  await t("an unknown id returns the generic 404", async () => {
    const r = await post({ id: "nope" });
    assert.strictEqual(r.status, 404);
    assert.match(r.text, /image unavailable/);
  });

  await t("a card with no remote image returns the SAME generic 404", async () => {
    const r = await post({ id: "local" });
    assert.strictEqual(r.status, 404);
    assert.match(r.text, /image unavailable/);
  });

  await t("a blocked destination returns the SAME generic 404 — no probing signal", async () => {
    const r = await post({ id: "blocked" });
    assert.strictEqual(r.status, 404);
    assert.match(r.text, /image unavailable/,
      "every failure reason must look identical, or the endpoint maps the user's network");
  });

  await t("a missing id is rejected", async () => {
    const r = await post({});
    assert.ok(r.status === 400 || r.status === 404, "got " + r.status);
  });

  await t("the route accepts no URL field at all", async () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "core", "server.js"), "utf8");
    const m = /app\.post\("\/api\/fetch-card-image"[\s\S]*?\n  \}\);/.exec(src);
    assert.ok(m, "route not found");
    assert.doesNotMatch(m[0], /req\.body\s*&&\s*req\.body\.url|req\.body\.url/,
      "taking a URL from the caller would reintroduce the SSRF surface the card-id design removes");
  });

  await t("a card with a fetchable remote image returns 200 with the image bytes", async () => {
    const realFetch = global.fetch;
    linkcheck._setLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
    global.fetch = async (url, opts) => {
      const u = String(url);
      // Node's fetch is ONE global — this same override would otherwise also
      // intercept post()'s own outgoing call to our local test server. Pass
      // that one through to the real implementation; only the simulated
      // remote-image host below is faked.
      if (u.indexOf(base) === 0) return realFetch(url, opts);
      if (/\.png/.test(u)) {
        return {
          ok: true, status: 200, url: u,
          headers: { get: (k) => (/content-type/i.test(k) ? "image/png" : null) },
          arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer,
        };
      }
      return { ok: false, status: 404, url: u, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
    };
    try {
      const r = await post({ id: "remote" });
      assert.strictEqual(r.status, 200, "expected a successful fetch to return 200, got " + r.status + " " + r.text);
      assert.match(r.ct, /^image\/png/, "expected Content-Type image/png, got " + r.ct);
      const buf = Buffer.from(await r.raw.arrayBuffer());
      assert.deepStrictEqual(buf, Buffer.from([137, 80, 78, 71]), "response body should be the fetched image bytes");
    } finally {
      global.fetch = realFetch;
      linkcheck._setLookup(null);
    }
  });

  await new Promise((r) => s.close(r));
  try { db.close(); } catch (e) {}
  console.log(pass + " passed, " + fail + " failed");
  await new Promise((r) => setTimeout(r, 50));
  process.exit(fail ? 1 : 0);
})();
