const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { importLegacyBackup } = require("../core/importer");
const db = require("../core/db");
const images = require("../core/images");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

// 1x1 transparent PNG data URL — valid base64 image bytes.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function mkTmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// Build a synthetic legacy backup folder: data.json + one image shard.
const src = mkTmp("ia-src-");
const cards = [
  { id: "c1", url: "https://ex.com/1", platform: "fb", cat: "Saved", ts: 1000, img: "idb:c1" },   // has image in shard
  { id: "c2", url: "https://ex.com/2", platform: "fb", cat: "Saved", ts: 2000, img: "idb:c2" },   // image MISSING from shard
  { id: "c3", url: "https://ex.com/3", platform: "yt", cat: "Saved", ts: 3000, img: "https://ex.com/p.jpg" } // http url, not missing
];
const savedArr = [
  { id: "s1", url: "https://ex.com/s1", category: "Tips", clipped: 1, image: "idb:s1" }
];
const dataJson = {
  _app: "interests-app", _version: 3, _exported: "2026-06-26T00:00:00.000Z",
  _counts: { imported: 3, saved: 1, likes: 0, images: 2 },
  shards: 1,
  keys: {
    ia_imported: JSON.stringify(cards),
    ia_saved: JSON.stringify(savedArr),
    ia_settings: JSON.stringify({ dark: true }),
    ia_feed: JSON.stringify([1, 2, 3])
  }
};
fs.writeFileSync(path.join(src, "data.json"), JSON.stringify(dataJson));
// Shard supplies bytes for c1 and s1 only — NOT c2 (so c2 should land in missing).
fs.writeFileSync(path.join(src, "img-0.json"), JSON.stringify({ c1: PNG, s1: PNG }));

// Fresh tmp store.
const storeDir = mkTmp("ia-store-");
fs.mkdirSync(path.join(storeDir, "images"), { recursive: true });
const database = db.openDb(storeDir);
const ctx = { db: database, storeDir: storeDir };

const res = importLegacyBackup(src, ctx);

t("returns card/saved counts matching rows written", () => {
  assert.strictEqual(res.cards, 3);
  assert.strictEqual(res.saved, 1);
});

t("writes card rows into the db", () => {
  const c = db.counts(database);
  assert.strictEqual(c.cards, 3);
  assert.strictEqual(c.saved, 1);
});

t("writes image files for shard entries (c1, s1)", () => {
  assert.strictEqual(images.hasImg(storeDir, "c1"), true);
  assert.strictEqual(images.hasImg(storeDir, "s1"), true);
  assert.strictEqual(fs.existsSync(path.join(storeDir, "images", "c1.jpg")), true);
});

t("image count on disk equals files actually written (2: c1, s1)", () => {
  assert.strictEqual(res.images, 2);
  assert.strictEqual(images.imageCount(storeDir), 2);
});

t("missing lists card c2 (idb ref, no shard bytes) and ONLY c2", () => {
  assert.deepStrictEqual(res.missing.slice().sort(), ["c2"]);
});

t("c3 (http url image) is NOT reported missing", () => {
  assert.strictEqual(res.missing.includes("c3"), false);
});

t("kv settings + extra ia_* keys were written", () => {
  assert.strictEqual(db.getKV(database, "ia_settings"), JSON.stringify({ dark: true }));
  assert.strictEqual(db.getKV(database, "ia_feed"), JSON.stringify([1, 2, 3]));
});

t("READ-ONLY on srcDir: data.json + shard unchanged, no new files", () => {
  const names = fs.readdirSync(src).sort();
  assert.deepStrictEqual(names, ["data.json", "img-0.json"]);
  const dj = JSON.parse(fs.readFileSync(path.join(src, "data.json"), "utf8"));
  assert.strictEqual(dj.shards, 1);
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
