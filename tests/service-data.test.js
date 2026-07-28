const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createServer } = require("../core/server");
const db = require("../core/db");

let pass = 0, fail = 0;
const todo = [];
function t(name, fn) { todo.push([name, fn]); }

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-svc-"));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}

const PIX_B64 = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
const PIX_DATAURL = "data:image/jpeg;base64," + PIX_B64;

function mount() {
  const storeDir = tmpStore();
  const database = db.openDb(storeDir);
  const ctx = { db: database, storeDir, getStorePath: () => storeDir, setStorePath: () => {} };
  const app = createServer(ctx);
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const base = "http://127.0.0.1:" + server.address().port;
      resolve({ base, server, database, storeDir });
    });
  });
}

setImmediate(async () => {
  for (const [name, fn] of todo) {
    const env = await mount();
    try { await fn(env); pass++; console.log("  ok  " + name); }
    catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); }
    finally { env.database.close(); env.server.close(); }
  }
  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
});

t("kv: GET missing -> {value:null}; PUT then GET round-trips", async ({ base }) => {
  let r = await fetch(base + "/api/kv/ia_settings");
  assert.deepStrictEqual(await r.json(), { value: null });
  r = await fetch(base + "/api/kv/ia_settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: '{"dark":true}' }) });
  assert.deepStrictEqual(await r.json(), { ok: true });
  r = await fetch(base + "/api/kv/ia_settings");
  assert.deepStrictEqual(await r.json(), { value: '{"dark":true}' });
});

t("cards: PUT bulk -> {ok,count}; GET returns them; PATCH and DELETE work", async ({ base }) => {
  let r = await fetch(base + "/api/cards", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ cards: [
    { id: "a", url: "ua", platform: "fb", cat: "Saved", ts: 2, img: "idb:a", title: "A" },
    { id: "b", url: "ub", platform: "pin", cat: "Feed", ts: 1, img: "", title: "B" },
  ] }) });
  assert.deepStrictEqual(await r.json(), { ok: true, count: 2, preserved: [] });
  r = await fetch(base + "/api/cards");
  const got = (await r.json()).cards.sort((x, y) => x.id.localeCompare(y.id));
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0].img, "idb:a");
  r = await fetch(base + "/api/cards/a", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ card: { id: "a", url: "ua", platform: "fb", cat: "Saved", ts: 2, img: "idb:a", title: "A2" } }) });
  assert.deepStrictEqual(await r.json(), { ok: true });
  r = await fetch(base + "/api/cards");
  assert.strictEqual((await r.json()).cards.find(c => c.id === "a").title, "A2");
  r = await fetch(base + "/api/cards/b", { method: "DELETE" });
  assert.deepStrictEqual(await r.json(), { ok: true });
  r = await fetch(base + "/api/cards");
  assert.deepStrictEqual((await r.json()).cards.map(c => c.id), ["a"]);
});

t("saved: PUT/GET/PATCH/DELETE round-trip (item.image preserved)", async ({ base }) => {
  let r = await fetch(base + "/api/saved", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ saved: [
    { id: "s", url: "u", category: "Tips", clipped: 5, image: "idb:s", title: "T" },
  ] }) });
  assert.deepStrictEqual(await r.json(), { ok: true, count: 1, preserved: [] });
  r = await fetch(base + "/api/saved");
  assert.strictEqual((await r.json()).saved[0].image, "idb:s");
  r = await fetch(base + "/api/saved/s", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ item: { id: "s", url: "u", category: "Tips", clipped: 5, image: "idb:s", title: "T2" } }) });
  assert.deepStrictEqual(await r.json(), { ok: true });
  r = await fetch(base + "/api/saved");
  assert.strictEqual((await r.json()).saved[0].title, "T2");
  r = await fetch(base + "/api/saved/s", { method: "DELETE" });
  assert.deepStrictEqual(await r.json(), { ok: true });
  r = await fetch(base + "/api/saved");
  assert.strictEqual((await r.json()).saved.length, 0);
});

t("not-duplicate decision is additive, atomic, and preserves current card fields", async ({ base }) => {
  await fetch(base + "/api/cards", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ cards: [
    { id: "a", url: "https://example.test/a", platform: "fb", cat: "Saved", ts: 2, img: "", title: "Current title", notes: "keep me" },
  ] }) });
  await fetch(base + "/api/saved", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ saved: [
    { id: "s", url: "https://example.test/a", category: "Tips", clipped: 5, image: "", title: "Saved title" },
  ] }) });
  // The decision key is a stable (scope,id) peer tag -- no url/title baked in --
  // so each member records who it was dismissed alongside, not a snapshot of
  // content that can go stale. See dupePeerTagsFor in web/pwa index.html.
  const body = { entries: [{ scope:"imported", id:"a", key:"p:saved:s" }, { scope:"saved", id:"s", key:"p:imported:a" }] };
  let r = await fetch(base + "/api/duplicates/not-duplicate", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body) });
  assert.deepStrictEqual(await r.json(), { ok:true, changed:2 });
  const cards = (await (await fetch(base + "/api/cards")).json()).cards;
  const saved = (await (await fetch(base + "/api/saved")).json()).saved;
  assert.strictEqual(cards[0].title, "Current title");
  assert.strictEqual(cards[0].notes, "keep me");
  assert.deepStrictEqual(cards[0].dupeNotDuplicateGroups, ["p:saved:s"]);
  assert.deepStrictEqual(saved[0].dupeNotDuplicateGroups, ["p:imported:a"]);
  r = await fetch(base + "/api/duplicates/not-duplicate", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body) });
  assert.deepStrictEqual(await r.json(), { ok:true, changed:0 }, "retries are idempotent");

  // The old CAS validation rejected a key whose embedded url/title no longer
  // matched the row (400 invalid_key / 409 row_changed) -- deliberately removed.
  // A pairwise identity tag has no content to go stale, so a title change must
  // neither block the write nor be required to match it.
  await fetch(base + "/api/cards", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ cards: [
    { id: "a", url: "https://example.test/a", platform: "fb", cat: "Saved", ts: 2, img: "", title: "A brand new title", notes: "keep me" },
  ] }) });
  r = await fetch(base + "/api/duplicates/not-duplicate", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ entries:[{scope:"imported",id:"a",key:"p:saved:zzz"},{scope:"saved",id:"s",key:"p:imported:a"}] }) });
  assert.deepStrictEqual(await r.json(), { ok:true, changed:1 }, "a title change afterward must not block, or need to match, a decision");
  const invalidScope = await fetch(base + "/api/duplicates/not-duplicate", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ entries:[{scope:"bogus",id:"a",key:"p:saved:s"},{scope:"saved",id:"s",key:"p:imported:a"}] }) });
  assert.strictEqual(invalidScope.status, 400, "scope must still be structurally validated");
});

t("not-duplicate decision degrades gracefully on a corrupt row instead of failing the whole batch", async ({ base, database }) => {
  await fetch(base + "/api/cards", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ cards: [
    { id: "a", url: "https://example.test/a", platform: "fb", cat: "Saved", ts: 2, img: "", title: "T" },
    { id: "b", url: "https://example.test/b", platform: "fb", cat: "Saved", ts: 2, img: "", title: "T2" },
  ] }) });
  database.prepare("UPDATE cards SET data=? WHERE id=?").run("{not json", "a");
  // Corrupting `data` also collapses the title (stored inside that JSON blob) to "" —
  // rowToCard already degrades gracefully, so that's what a fresh read reports.
  const key = JSON.stringify([["imported","a","https://example.test/a",""],["imported","b","https://example.test/b","t2"]]);
  const body = { entries: [{ scope:"imported", id:"a", key }, { scope:"imported", id:"b", key }] };
  const r = await fetch(base + "/api/duplicates/not-duplicate", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body) });
  assert.deepStrictEqual(await r.json(), { ok:true, changed:2 },
    "a corrupt data column on one row degrades to {} instead of failing the whole batch");
  const cards = (await (await fetch(base + "/api/cards")).json()).cards;
  const byId = Object.fromEntries(cards.map(c => [c.id, c]));
  assert.deepStrictEqual(byId.a.dupeNotDuplicateGroups, [key], "the corrupt row still gets its marker, with prior JSON extras dropped");
  assert.deepStrictEqual(byId.b.dupeNotDuplicateGroups, [key], "an unrelated row bundled in the same batch is unaffected");
});

t("img: PUT data URL writes the file; GET returns the jpeg bytes; DELETE removes; GET missing -> 404", async ({ base }) => {
  let r = await fetch(base + "/api/img/abc");
  assert.strictEqual(r.status, 404);
  r = await fetch(base + "/api/img/abc", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: PIX_DATAURL }) });
  const put = await r.json();
  assert.strictEqual(put.ok, true);
  assert.strictEqual(put.file, "abc.jpg");
  r = await fetch(base + "/api/img/abc");
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get("content-type"), "image/jpeg");
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.deepStrictEqual(bytes, Buffer.from(PIX_B64, "base64"));
  r = await fetch(base + "/api/img/keeper/copy", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({sourceId:"abc"}) });
  assert.deepStrictEqual(await r.json(), { ok:true });
  r = await fetch(base + "/api/img/keeper");
  assert.deepStrictEqual(Buffer.from(await r.arrayBuffer()), bytes, "copy endpoint preserves source bytes under the keeper id");
  r = await fetch(base + "/api/img/abc", { method: "DELETE" });
  assert.deepStrictEqual(await r.json(), { ok: true });
  r = await fetch(base + "/api/img/abc");
  assert.strictEqual(r.status, 404);
});

t("fp: PUT then GET all; DELETE removes", async ({ base }) => {
  let r = await fetch(base + "/api/fp/x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "fpx" }) });
  assert.deepStrictEqual(await r.json(), { ok: true });
  await fetch(base + "/api/fp/y", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "fpy" }) });
  r = await fetch(base + "/api/fp");
  assert.deepStrictEqual((await r.json()).fp, { x: "fpx", y: "fpy" });
  r = await fetch(base + "/api/fp/x", { method: "DELETE" });
  assert.deepStrictEqual(await r.json(), { ok: true });
  r = await fetch(base + "/api/fp");
  assert.deepStrictEqual((await r.json()).fp, { y: "fpy" });
});
