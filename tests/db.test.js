const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const db = require("../core/db");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-db-"));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}

t("openDb creates interests.db in WAL mode and passes integrity_check", () => {
  const dir = tmpStore();
  const d = db.openDb(dir);
  assert.ok(fs.existsSync(path.join(dir, "interests.db")), "db file created");
  assert.strictEqual(d.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.strictEqual(d.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  d.close();
});

t("getKV returns null for a missing key", () => {
  const d = db.openDb(tmpStore());
  assert.strictEqual(db.getKV(d, "ia_settings"), null);
  d.close();
});

t("setKV then getKV round-trips a value", () => {
  const d = db.openDb(tmpStore());
  db.setKV(d, "ia_settings", JSON.stringify({ dark: true }));
  assert.strictEqual(db.getKV(d, "ia_settings"), JSON.stringify({ dark: true }));
  d.close();
});

t("setKV upserts (replaces) on an existing key", () => {
  const d = db.openDb(tmpStore());
  db.setKV(d, "ia_feed", "[1]");
  db.setKV(d, "ia_feed", "[1,2]");
  assert.strictEqual(db.getKV(d, "ia_feed"), "[1,2]");
  d.close();
});

t("delKV removes a key", () => {
  const d = db.openDb(tmpStore());
  db.setKV(d, "ia_hidden", "[]");
  db.delKV(d, "ia_hidden");
  assert.strictEqual(db.getKV(d, "ia_hidden"), null);
  d.close();
});

t("counts is {cards:0,saved:0} on a fresh db", () => {
  const d = db.openDb(tmpStore());
  assert.deepStrictEqual(db.counts(d), { cards: 0, saved: 0 });
  d.close();
});

t("cardToRow: idb img -> img_file, no img_url, data excludes column fields", () => {
  const card = { id: "c1", url: "https://x.com/p", platform: "facebook", cat: "Saved", ts: 1700000000000, img: "idb:c1", title: "Hi", tags: ["a"], blocked: false };
  const row = db.cardToRow(card);
  assert.strictEqual(row.id, "c1");
  assert.strictEqual(row.url, "https://x.com/p");
  assert.strictEqual(row.platform, "facebook");
  assert.strictEqual(row.cat, "Saved");
  assert.strictEqual(row.ts, 1700000000000);
  assert.strictEqual(row.img_file, "c1.jpg");
  assert.strictEqual(row.img_url, null);
  const data = JSON.parse(row.data);
  assert.deepStrictEqual(data, { title: "Hi", tags: ["a"], blocked: false });
  assert.ok(!("id" in data) && !("img" in data) && !("ts" in data), "column fields not duplicated in data");
});

t("cardToRow: http img -> img_url, no img_file", () => {
  const row = db.cardToRow({ id: "c2", url: "u", platform: "pinterest", cat: "Feed", ts: 1, img: "https://i.pinimg.com/x.jpg", title: "P" });
  assert.strictEqual(row.img_file, null);
  assert.strictEqual(row.img_url, "https://i.pinimg.com/x.jpg");
});

t("cardToRow: empty img -> both null", () => {
  const row = db.cardToRow({ id: "c3", url: "u", platform: "x", cat: "c", ts: 0, img: "" });
  assert.strictEqual(row.img_file, null);
  assert.strictEqual(row.img_url, null);
});

t("rowToCard: img_file -> idb:<id> ref, data merged", () => {
  const row = { id: "c1", url: "u", platform: "facebook", cat: "Saved", ts: 5, img_file: "c1.jpg", img_url: null, data: JSON.stringify({ title: "Hi", tags: ["a"] }) };
  const card = db.rowToCard(row);
  assert.strictEqual(card.img, "idb:c1");
  assert.strictEqual(card.title, "Hi");
  assert.deepStrictEqual(card.tags, ["a"]);
  assert.strictEqual(card.cat, "Saved");
});

t("rowToCard: img_url passes through; missing -> empty string", () => {
  assert.strictEqual(db.rowToCard({ id: "c2", url: "u", platform: "p", cat: "c", ts: 1, img_file: null, img_url: "https://h/x.jpg", data: "{}" }).img, "https://h/x.jpg");
  assert.strictEqual(db.rowToCard({ id: "c3", url: "u", platform: "p", cat: "c", ts: 1, img_file: null, img_url: null, data: "{}" }).img, "");
});

t("card round-trip through cardToRow -> rowToCard is lossless (idb/http/empty)", () => {
  const cards = [
    { id: "a", url: "ua", platform: "facebook", cat: "Saved", ts: 10, img: "idb:a", title: "A", desc: "d", liked: true },
    { id: "b", url: "ub", platform: "pinterest", cat: "Feed", ts: 20, img: "https://h/b.jpg", title: "B", tags: [] },
    { id: "c", url: "uc", platform: "youtube", cat: "Feed", ts: 30, img: "", title: "C" },
  ];
  for (const c of cards) {
    const back = db.rowToCard(db.cardToRow(c));
    assert.deepStrictEqual(back, c);
  }
});

t("replaceCards inserts in a transaction; allCards reads them back", () => {
  const d = db.openDb(tmpStore());
  db.replaceCards(d, [
    { id: "a", url: "ua", platform: "fb", cat: "Saved", ts: 2, img: "idb:a", title: "A" },
    { id: "b", url: "ub", platform: "pin", cat: "Feed", ts: 1, img: "", title: "B" },
  ]);
  const all = db.allCards(d).sort((x, y) => x.id.localeCompare(y.id));
  assert.strictEqual(all.length, 2);
  assert.strictEqual(all[0].id, "a");
  assert.strictEqual(all[0].img, "idb:a");
  assert.strictEqual(db.counts(d).cards, 2);
  d.close();
});

t("replaceCards is atomic replace (old rows gone)", () => {
  const d = db.openDb(tmpStore());
  db.replaceCards(d, [{ id: "old", url: "u", platform: "p", cat: "c", ts: 1, img: "" }]);
  db.replaceCards(d, [{ id: "new", url: "u", platform: "p", cat: "c", ts: 1, img: "" }]);
  const ids = db.allCards(d).map(c => c.id);
  assert.deepStrictEqual(ids, ["new"]);
  d.close();
});

t("upsertCard inserts then updates; deleteCard removes", () => {
  const d = db.openDb(tmpStore());
  db.upsertCard(d, { id: "a", url: "u1", platform: "p", cat: "c", ts: 1, img: "", title: "v1" });
  db.upsertCard(d, { id: "a", url: "u2", platform: "p", cat: "c", ts: 1, img: "", title: "v2" });
  assert.strictEqual(db.counts(d).cards, 1);
  assert.strictEqual(db.allCards(d)[0].title, "v2");
  assert.strictEqual(db.allCards(d)[0].url, "u2");
  db.deleteCard(d, "a");
  assert.strictEqual(db.counts(d).cards, 0);
  d.close();
});

t("savedToRow: image idb -> img_file; data excludes column fields", () => {
  const item = { id: "s1", url: "u", category: "Tips", clipped: 1700000000000, image: "idb:s1", title: "T", benefit: "B", source: "src", tags: ["x"], sdate: "2026-06-01" };
  const row = db.savedToRow(item);
  assert.strictEqual(row.id, "s1");
  assert.strictEqual(row.category, "Tips");
  assert.strictEqual(row.clipped, 1700000000000);
  assert.strictEqual(row.img_file, "s1.jpg");
  assert.strictEqual(row.img_url, null);
  const data = JSON.parse(row.data);
  assert.deepStrictEqual(data, { title: "T", benefit: "B", source: "src", tags: ["x"], sdate: "2026-06-01" });
  assert.ok(!("image" in data) && !("category" in data) && !("clipped" in data));
});

t("savedToRow: http image -> img_url; empty -> both null", () => {
  assert.strictEqual(db.savedToRow({ id: "s2", url: "u", category: "c", clipped: 0, image: "https://h/s.jpg" }).img_url, "https://h/s.jpg");
  const empty = db.savedToRow({ id: "s3", url: "u", category: "c", clipped: 0, image: "" });
  assert.strictEqual(empty.img_file, null);
  assert.strictEqual(empty.img_url, null);
});

t("saved round-trip through savedToRow -> rowToSaved is lossless (idb/http/empty)", () => {
  const items = [
    { id: "a", url: "ua", category: "Tips", clipped: 10, image: "idb:a", title: "A", benefit: "b" },
    { id: "b", url: "ub", category: "News", clipped: 20, image: "https://h/b.jpg", title: "B" },
    { id: "c", url: "uc", category: "Misc", clipped: 30, image: "", title: "C", tags: [] },
  ];
  for (const it of items) {
    const back = db.rowToSaved(db.savedToRow(it));
    assert.deepStrictEqual(back, it);
  }
});

t("replaceSaved + allSaved + counts.saved", () => {
  const d = db.openDb(tmpStore());
  db.replaceSaved(d, [
    { id: "a", url: "ua", category: "Tips", clipped: 2, image: "idb:a", title: "A" },
    { id: "b", url: "ub", category: "News", clipped: 1, image: "", title: "B" },
  ]);
  const all = db.allSaved(d).sort((x, y) => x.id.localeCompare(y.id));
  assert.strictEqual(all.length, 2);
  assert.strictEqual(all[0].image, "idb:a");
  assert.strictEqual(db.counts(d).saved, 2);
  d.close();
});

t("upsertSaved updates in place; deleteSaved removes", () => {
  const d = db.openDb(tmpStore());
  db.upsertSaved(d, { id: "a", url: "u", category: "c", clipped: 1, image: "", title: "v1" });
  db.upsertSaved(d, { id: "a", url: "u", category: "c", clipped: 1, image: "", title: "v2" });
  assert.strictEqual(db.counts(d).saved, 1);
  assert.strictEqual(db.allSaved(d)[0].title, "v2");
  db.deleteSaved(d, "a");
  assert.strictEqual(db.counts(d).saved, 0);
  d.close();
});

t("fp: set/get/all/del", () => {
  const d = db.openDb(tmpStore());
  assert.strictEqual(db.getFp(d, "x"), null);
  db.setFp(d, "x", "fpx");
  db.setFp(d, "y", "fpy");
  assert.strictEqual(db.getFp(d, "x"), "fpx");
  assert.deepStrictEqual(db.allFp(d), { x: "fpx", y: "fpy" });
  db.setFp(d, "x", "fpx2");
  assert.strictEqual(db.getFp(d, "x"), "fpx2");
  db.delFp(d, "x");
  assert.strictEqual(db.getFp(d, "x"), null);
  assert.deepStrictEqual(db.allFp(d), { y: "fpy" });
  d.close();
});

t("replaceCards persists an id-less card instead of throwing/rolling back the whole import", () => {
  const d = db.openDb(tmpStore());
  // A real import sends a mix: existing id-bearing cards + new id-less ones (clean() has no id).
  // Before the fix this threw on the id-less card and rolled back ALL of replaceCards.
  db.replaceCards(d, [
    { id: "card_keep", title: "has id", url: "https://a.example.com" },
    { title: "no id bookmark", url: "https://b.example.com" },
    { title: "no id instagram", url: "https://www.instagram.com/p/Z/" },
  ]);
  const cards = db.allCards(d);
  assert.strictEqual(cards.length, 3, "all three cards persisted");
  assert.ok(cards.every(c => c.id && c.id.length > 0), "every persisted card has a non-empty id");
  assert.ok(cards.some(c => c.id === "card_keep"), "an explicit id is preserved");
  d.close();
});

t("an id-less card gets a STABLE id (re-import is idempotent, not duplicated)", () => {
  const d = db.openDb(tmpStore());
  db.replaceCards(d, [{ title: "no id", url: "https://stable.example.com/p/1" }]);
  const id1 = db.allCards(d)[0].id;
  db.replaceCards(d, [{ title: "no id", url: "https://stable.example.com/p/1" }]);
  const after = db.allCards(d);
  assert.strictEqual(after.length, 1, "no duplicate on re-import");
  assert.strictEqual(after[0].id, id1, "same id-less card maps to the same stable id");
  d.close();
});

t("replaceSaved also tolerates an id-less saved item", () => {
  const d = db.openDb(tmpStore());
  db.replaceSaved(d, [{ url: "https://s.example.com", title: "no id saved" }]);
  const saved = db.allSaved(d);
  assert.strictEqual(saved.length, 1);
  assert.ok(saved[0].id && saved[0].id.length > 0, "saved item got a non-empty id");
  d.close();
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
