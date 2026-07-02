// tests/mass-delete-guard.test.js — A5: PUT /api/cards & /api/saved mass-delete guard.
// Boots the real Express app on an ephemeral loopback port (same pattern as
// server-backup-int.test.js) and drives the endpoints over HTTP.
const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");

const { createServer } = require("../core/server.js");
const { openDb, counts } = require("../core/db.js");

let pass = 0, fail = 0;
async function run(name, fn) {
  try { await fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); }
}

function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-massdel-"));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}
function listen(app) {
  return new Promise(function (res) {
    const srv = http.createServer(app).listen(0, "127.0.0.1", function () {
      res({ srv, base: "http://127.0.0.1:" + srv.address().port });
    });
  });
}
function put(base, route, body) {
  return fetch(base + route, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}
function makeCards(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ id: "c" + i, url: "https://x/" + i, platform: "fb", cat: "Saved", ts: i, img: "" });
  return out;
}
function makeSaved(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ id: "s" + i, url: "https://x/" + i, category: "Tips", clipped: i, image: "" });
  return out;
}

(async function () {
  const store = newStore();
  const db = openDb(store);
  const ctx = { db, storeDir: store, getStorePath: function () { return store; }, setStorePath: function () {}, reopen: function () { return openDb(ctx.storeDir); } };
  const app = createServer(ctx);
  const { srv, base } = await listen(app);

  await run("cards: unconfirmed mass delete (30 -> 3) is blocked with 409 and leaves DB unchanged", async () => {
    let r = await put(base, "/api/cards", { cards: makeCards(30) });
    assert.strictEqual((await r.json()).count, 30);
    ctx.syncDirty = false;
    r = await put(base, "/api/cards", { cards: makeCards(3) });   // no confirm
    assert.strictEqual(r.status, 409, "expected 409");
    const j = await r.json();
    assert.strictEqual(j.ok, false);
    assert.strictEqual(j.error, "mass_delete_blocked");
    assert.strictEqual(j.existing, 30);
    assert.strictEqual(j.incoming, 3);
    assert.strictEqual(counts(ctx.db).cards, 30, "DB unchanged — no write on 409");
    assert.strictEqual(ctx.syncDirty, false, "syncDirty must not be set on 409");
  });

  await run("cards: confirmed mass delete (30 -> 3) succeeds with 200", async () => {
    const r = await put(base, "/api/cards", { cards: makeCards(3), confirm: true });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.strictEqual(j.ok, true);
    assert.strictEqual(j.count, 3);
    assert.strictEqual(counts(ctx.db).cards, 3, "3 cards remain");
  });

  await run("cards: shrink that is NOT a mass delete (30 -> 20) is allowed without confirm", async () => {
    await put(base, "/api/cards", { cards: makeCards(30), confirm: true });
    const r = await put(base, "/api/cards", { cards: makeCards(20) });  // 20 >= 30/2, not blocked
    assert.strictEqual(r.status, 200);
    assert.strictEqual(counts(ctx.db).cards, 20);
  });

  await run("cards: below-threshold library (10 -> 1) is never mass-delete-blocked", async () => {
    await put(base, "/api/cards", { cards: makeCards(10), confirm: true });
    const r = await put(base, "/api/cards", { cards: makeCards(1) });   // existing < 20
    assert.strictEqual(r.status, 200);
    assert.strictEqual(counts(ctx.db).cards, 1);
  });

  await run("saved: unconfirmed mass delete (30 -> 3) is blocked with 409; confirm succeeds", async () => {
    let r = await put(base, "/api/saved", { saved: makeSaved(30) });
    assert.strictEqual((await r.json()).count, 30);
    r = await put(base, "/api/saved", { saved: makeSaved(3) });
    assert.strictEqual(r.status, 409);
    const j = await r.json();
    assert.strictEqual(j.error, "mass_delete_blocked");
    assert.strictEqual(j.existing, 30);
    assert.strictEqual(j.incoming, 3);
    assert.strictEqual(counts(ctx.db).saved, 30, "saved DB unchanged on 409");
    r = await put(base, "/api/saved", { saved: makeSaved(3), confirm: true });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(counts(ctx.db).saved, 3);
  });

  await new Promise(function (res) { srv.close(res); });
  try { ctx.db.close(); } catch (e) {}
  console.log(pass + " passed, " + fail + " failed");
  process.exitCode = fail ? 1 : 0;
})();
