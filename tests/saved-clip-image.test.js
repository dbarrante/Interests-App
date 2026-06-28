// A saved clip's thumbnail can be an inline data: URL. The DB saved-row layer used
// to keep ONLY idb: file refs and http URLs, silently DROPPING a data: image — which
// lost Pinterest/Instagram clip thumbnails on every DB write (and during migration).
// These tests pin the fix: a data: clip image must survive a DB round-trip, and the
// importer must persist it to a file.
const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path");
const db = require("../core/db");
const importer = require("../core/importer");
const images = require("../core/images");
let passed = 0, failed = 0;
function test(n, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + n + "\n  " + (e && e.message)); } }
function tmpStore() { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ia-clipimg-")); fs.mkdirSync(path.join(d, "images"), { recursive: true }); return d; }
const DATA_IMG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBD";

test("replaceSaved preserves an inline data: clip image (round-trip, not dropped)", () => {
  const d = db.openDb(tmpStore());
  db.replaceSaved(d, [{ id: "s_1", url: "https://pin.it/x", image: DATA_IMG, source: "pinterest.com" }]);
  const got = db.allSaved(d).find(s => s.id === "s_1");
  assert.strictEqual(got.image, DATA_IMG, "data: clip image must survive a DB round-trip");
  d.close();
});

test("upsertSaved preserves an inline data: clip image", () => {
  const d = db.openDb(tmpStore());
  db.upsertSaved(d, { id: "s_2", url: "https://x", image: DATA_IMG });
  assert.strictEqual(db.allSaved(d)[0].image, DATA_IMG);
  d.close();
});

test("idb: and http saved images still round-trip unchanged (regression guard)", () => {
  const d = db.openDb(tmpStore());
  db.replaceSaved(d, [
    { id: "s_idb", url: "https://a", image: "idb:s_idb" },
    { id: "s_http", url: "https://b", image: "https://cdn/x.jpg" },
  ]);
  const all = db.allSaved(d);
  assert.strictEqual(all.find(s => s.id === "s_idb").image, "idb:s_idb");
  assert.strictEqual(all.find(s => s.id === "s_http").image, "https://cdn/x.jpg");
  d.close();
});

test("an image-less saved row still round-trips to image:'' (no spurious data.image)", () => {
  const d = db.openDb(tmpStore());
  db.replaceSaved(d, [{ id: "s_none", url: "https://c", source: "pinterest.com" }]);
  assert.strictEqual(db.allSaved(d).find(s => s.id === "s_none").image, "");
  d.close();
});

test("importLegacyBackup persists an inline-data: clip image to a FILE (idb:) so it isn't dropped", () => {
  const store = tmpStore();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "ia-legacy-"));
  const dataJson = { keys: { ia_saved: JSON.stringify([{ id: "s_clip", url: "https://pin.it/y", image: DATA_IMG, source: "pinterest.com" }]) }, shards: 0 };
  fs.writeFileSync(path.join(src, "data.json"), JSON.stringify(dataJson));
  const d = db.openDb(store);
  importer.importLegacyBackup(src, { db: d, storeDir: store });
  const got = db.allSaved(d).find(s => s.id === "s_clip");
  assert.strictEqual(got.image, "idb:s_clip", "migrated clip image should be a file ref");
  assert.ok(images.hasImg(store, "s_clip"), "the image file must exist on disk");
  d.close();
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
