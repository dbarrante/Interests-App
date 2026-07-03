// tests/bstumble-mailbox.test.js — browser-stumble Core mailboxes.
// Boots the real Express app on an ephemeral loopback port (same pattern as
// tests/mass-delete-guard.test.js) and drives the endpoints over HTTP.
const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");

const { createServer } = require("../core/server.js");
const { openDb } = require("../core/db.js");

let pass = 0, fail = 0;
async function run(name, fn) {
  try { await fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); }
}
function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-bstumble-"));
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
function jget(base, route) { return fetch(base + route).then(r => r.json()); }
function jpost(base, route, body) {
  return fetch(base + route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());
}

(async function () {
  const store = newStore();
  const db = openDb(store);
  const ctx = { db, storeDir: store, getStorePath: function () { return store; }, setStorePath: function () {}, reopen: function () { return openDb(ctx.storeDir); } };
  const app = createServer(ctx);
  const { srv, base } = await listen(app);

  await run("categories: empty by default, then reflects ia_bstumble_cats KV", async () => {
    let j = await jget(base, "/api/categories");
    assert.deepStrictEqual(j.categories, []);
    // Seed the KV via PUT — /api/kv/:key supports GET/PUT only (no POST).
    await fetch(base + "/api/kv/ia_bstumble_cats", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: JSON.stringify([{ key: "work", name: "Work initiatives" }]) }) });
    j = await jget(base, "/api/categories");
    assert.strictEqual(j.categories[0].key, "work");
  });

  await run("request: set, read, clear", async () => {
    await jpost(base, "/api/bstumble/request", { request: { interests: ["work"], nonce: "n1" } });
    let j = await jget(base, "/api/bstumble/request");
    assert.strictEqual(j.request.nonce, "n1");
    await jpost(base, "/api/bstumble/request", { request: null });
    j = await jget(base, "/api/bstumble/request");
    assert.strictEqual(j.request, null);
  });

  await run("results: append then GET returns and clears", async () => {
    await jpost(base, "/api/bstumble/results", { items: [{ url: "https://a", title: "A" }] });
    await jpost(base, "/api/bstumble/results", { items: [{ url: "https://b", title: "B" }] });
    let j = await jget(base, "/api/bstumble/results");
    assert.strictEqual(j.results.length, 2);
    j = await jget(base, "/api/bstumble/results");
    assert.strictEqual(j.results.length, 0); // cleared on read
  });

  await run("results: caps at 20 newest", async () => {
    for (let i = 0; i < 25; i++) await jpost(base, "/api/bstumble/results", { items: [{ url: "https://x/" + i }] });
    const j = await jget(base, "/api/bstumble/results");
    assert.strictEqual(j.results.length, 20);
    assert.strictEqual(j.results[j.results.length - 1].url, "https://x/24");
  });

  await run("feedback: append then GET returns and clears", async () => {
    await jpost(base, "/api/bstumble/feedback", { vote: { url: "https://a", vote: 1 } });
    await jpost(base, "/api/bstumble/feedback", { vote: { url: "https://b", vote: -1 } });
    let j = await jget(base, "/api/bstumble/feedback");
    assert.strictEqual(j.feedback.length, 2);
    j = await jget(base, "/api/bstumble/feedback");
    assert.strictEqual(j.feedback.length, 0);
  });

  await run("results: bad body is rejected", async () => {
    const r = await fetch(base + "/api/bstumble/results", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items: "nope" }) });
    assert.strictEqual(r.status, 400);
  });

  srv.close();
  console.log("bstumble-mailbox: " + pass + " passed, " + fail + " failed");
  if (fail) process.exitCode = 1;
})();
