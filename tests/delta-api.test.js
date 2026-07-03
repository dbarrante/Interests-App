// tests/delta-api.test.js — Task 1 (v1.10.0 iPhone-sync prep): GET /api/changes?since=
// and GET /api/tombstones?since= delta read API. Boots the real Express app on an
// ephemeral loopback port (same pattern as mass-delete-guard.test.js).
const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");

const { createServer } = require("../core/server.js");
const { openDb, upsertCard, upsertCardSynced, upsertSaved, deleteCard } = require("../core/db.js");

let pass = 0, fail = 0;
async function run(name, fn) {
  try { await fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.stack || e)); }
}

function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-delta-"));
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
function getJson(base, route) {
  return fetch(base + route).then((r) => r.json().then((j) => ({ status: r.status, json: j })));
}

(async function () {
  const store = newStore();
  const db = openDb(store);
  const ctx = { db, storeDir: store, getStorePath: function () { return store; }, setStorePath: function () {}, reopen: function () { return openDb(ctx.storeDir); } };
  const app = createServer(ctx);
  const { srv, base } = await listen(app);

  await run("since=0/absent returns everything (full-snapshot semantics)", async () => {
    upsertCard(ctx.db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "" });
    upsertSaved(ctx.db, { id: "s1", url: "https://x/s1", category: "Tips", clipped: 1, image: "" });

    let r = await getJson(base, "/api/changes");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.cards.length, 1);
    assert.strictEqual(r.json.saved.length, 1);
    assert.strictEqual(r.json.tombstones.length, 0);
    assert.ok(isFinite(r.json.now) && r.json.now > 0, "now must be a timestamp");

    r = await getJson(base, "/api/changes?since=0");
    assert.strictEqual(r.json.cards.length, 1);
    assert.strictEqual(r.json.saved.length, 1);

    r = await getJson(base, "/api/tombstones");
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.tombstones.length, 0);
    assert.ok(isFinite(r.json.now));
  });

  await run("since=<watermark> returns exactly the delta incl. tombstone; read-only (no syncDirty)", async () => {
    ctx.syncDirty = false;
    const w1 = (await getJson(base, "/api/changes")).json.now;

    // Ensure the clock advances past w1 before mutating (Date.now() resolution).
    await new Promise((r) => setTimeout(r, 5));

    upsertCard(ctx.db, { id: "c2", url: "https://x/2", platform: "fb", cat: "Saved", ts: 2, img: "" });
    upsertSaved(ctx.db, { id: "s1", url: "https://x/s1-edited", category: "Tips", clipped: 2, image: "" }); // edit
    deleteCard(ctx.db, "c1", Date.now());

    const r = await getJson(base, "/api/changes?since=" + w1);
    assert.strictEqual(r.json.cards.length, 1, "only c2 is new/changed");
    assert.strictEqual(r.json.cards[0].id, "c2");
    assert.strictEqual(r.json.saved.length, 1, "s1 was edited");
    assert.strictEqual(r.json.saved[0].id, "s1");
    assert.strictEqual(r.json.saved[0].url, "https://x/s1-edited");
    assert.strictEqual(r.json.tombstones.length, 1, "c1 delete produced a tombstone");
    assert.strictEqual(r.json.tombstones[0].id, "c1");
    assert.strictEqual(r.json.tombstones[0].kind, "card");
    assert.strictEqual(ctx.syncDirty, false, "delta reads must not set syncDirty");

    const rt = await getJson(base, "/api/tombstones?since=" + w1);
    assert.strictEqual(rt.json.tombstones.length, 1);
    assert.strictEqual(rt.json.tombstones[0].id, "c1");
  });

  await run("watermark chains correctly across two polls", async () => {
    const w2 = (await getJson(base, "/api/changes")).json.now;
    await new Promise((r) => setTimeout(r, 5));

    upsertCard(ctx.db, { id: "c3", url: "https://x/3", platform: "fb", cat: "Saved", ts: 3, img: "" });

    const r2 = await getJson(base, "/api/changes?since=" + w2);
    assert.strictEqual(r2.json.cards.length, 1);
    assert.strictEqual(r2.json.cards[0].id, "c3");
    const w3 = r2.json.now;
    assert.ok(w3 >= w2, "watermark must not go backward");

    await new Promise((r) => setTimeout(r, 5));
    upsertCard(ctx.db, { id: "c4", url: "https://x/4", platform: "fb", cat: "Saved", ts: 4, img: "" });

    const r3 = await getJson(base, "/api/changes?since=" + w3);
    assert.strictEqual(r3.json.cards.length, 1, "second poll returns only the second mutation");
    assert.strictEqual(r3.json.cards[0].id, "c4");
  });

  await run("boundary: a row stamped exactly == since is NOT returned (strict >); at-least-once still holds", async () => {
    // Directly stamp a card's updatedAt to a controlled timestamp T using the
    // merge-write path (upsertCardSynced accepts an explicit updatedAt).
    const T = Date.now() + 100000; // far enough forward to be uniquely identifiable
    upsertCardSynced(ctx.db, { id: "cB", url: "https://x/B", platform: "fb", cat: "Saved", ts: 5, img: "" }, T);

    // A poll with since=T must NOT include cB (strict > excludes the tie).
    const r = await getJson(base, "/api/changes?since=" + T);
    assert.ok(!r.json.cards.some((c) => c.id === "cB"), "row stamped == since must be excluded by strict >");

    // Simulate the caller that received `now = T` from an earlier poll (i.e. cB's
    // write raced in exactly at that poll's `now` capture). Because `now` is
    // captured BEFORE the reads in the /api/changes handler, a poll whose `now`
    // equals T could only have been produced by a query run at/after T — so cB
    // (stamped exactly T) WOULD already have been included in THAT poll's own
    // response (since T's own read used since=<previous watermark, which is < T>,
    // and strict > only excludes exact equality with the *current* poll's own
    // `since`, not with the `now` it returns). Demonstrate this directly: a poll
    // using since = (T - 1) DOES return cB.
    const rPrev = await getJson(base, "/api/changes?since=" + (T - 1));
    assert.ok(rPrev.json.cards.some((c) => c.id === "cB"), "row stamped T is delivered by a poll with since < T");
  });

  await new Promise(function (res) { srv.close(res); });
  try { ctx.db.close(); } catch (e) {}
  console.log(pass + " passed, " + fail + " failed");
  process.exitCode = fail ? 1 : 0;
})();
