// core/db.js — SQLite open/migrate + CRUD. Synchronous (node:sqlite DatabaseSync).
// Uses Node's built-in node:sqlite — part of the Node/Electron runtime, so there
// is nothing to compile, install, or rebuild for the DB. Verified under Node v25
// and Electron 42 (Node 24).
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

// Each migration is an idempotent SQL string run in order. Bump by appending.
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS cards (
     id TEXT PRIMARY KEY, url TEXT, platform TEXT, cat TEXT, ts INTEGER,
     img_file TEXT, img_url TEXT, data TEXT
   );
   CREATE INDEX IF NOT EXISTS ix_cards_platform ON cards(platform);
   CREATE INDEX IF NOT EXISTS ix_cards_cat ON cards(cat);
   CREATE INDEX IF NOT EXISTS ix_cards_ts ON cards(ts);
   CREATE INDEX IF NOT EXISTS ix_cards_url ON cards(url);
   CREATE TABLE IF NOT EXISTS saved (
     id TEXT PRIMARY KEY, url TEXT, category TEXT, clipped INTEGER,
     img_file TEXT, img_url TEXT, data TEXT
   );
   CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
   CREATE TABLE IF NOT EXISTS fp (id TEXT PRIMARY KEY, fp TEXT);`,
];

function openDb(storeDir) {
  const db = new DatabaseSync(path.join(storeDir, "interests.db"));
  db.exec("PRAGMA journal_mode=WAL");
  for (const sql of MIGRATIONS) db.exec(sql);
  const ic = db.prepare("PRAGMA integrity_check").get(); // {integrity_check:'ok'} on a healthy DB
  if (!ic || ic.integrity_check !== "ok") {
    throw new Error("integrity_check failed: " + (ic && ic.integrity_check));
  }
  return db;
}

function getKV(db, key) {
  const row = db.prepare("SELECT value FROM kv WHERE key=?").get(key);
  return row ? row.value : null;
}
function setKV(db, key, value) {
  db.prepare("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}
function delKV(db, key) {
  db.prepare("DELETE FROM kv WHERE key=?").run(key);
}
function counts(db) {
  const cards = db.prepare("SELECT COUNT(*) n FROM cards").get().n;
  const saved = db.prepare("SELECT COUNT(*) n FROM saved").get().n;
  return { cards: Number(cards), saved: Number(saved) };
}

module.exports = { openDb, getKV, setKV, delKV, counts };
