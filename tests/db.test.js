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

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
