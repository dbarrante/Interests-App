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

// Card column fields live in their own columns; everything else goes in `data` JSON.
const CARD_COLS = ["id", "url", "platform", "cat", "ts", "img"];

function cardToRow(card) {
  const img = card.img || "";
  let img_file = null, img_url = null;
  if (img.indexOf("idb:") === 0) img_file = card.id + ".jpg";
  else if (img.indexOf("http") === 0) img_url = img;
  const data = {};
  for (const k of Object.keys(card)) {
    if (CARD_COLS.indexOf(k) === -1) data[k] = card[k];
  }
  return {
    id: card.id,
    url: card.url != null ? card.url : null,
    platform: card.platform != null ? card.platform : null,
    cat: card.cat != null ? card.cat : null,
    ts: card.ts != null ? card.ts : null,
    img_file,
    img_url,
    data: JSON.stringify(data),
  };
}

function rowToCard(row) {
  const base = row.data ? JSON.parse(row.data) : {};
  base.id = row.id;
  base.url = row.url;
  base.platform = row.platform;
  base.cat = row.cat;
  base.ts = row.ts;
  base.img = row.img_file ? ("idb:" + row.id) : (row.img_url || "");
  return base;
}

function allCards(db) {
  return db.prepare("SELECT * FROM cards").all().map(rowToCard);
}

// node:sqlite has no named-param helper here; bind positional `?` params in column order.
const _CARD_INSERT_SQL =
  "INSERT INTO cards(id,url,platform,cat,ts,img_file,img_url,data) VALUES(?,?,?,?,?,?,?,?) " +
  "ON CONFLICT(id) DO UPDATE SET url=excluded.url,platform=excluded.platform,cat=excluded.cat,ts=excluded.ts,img_file=excluded.img_file,img_url=excluded.img_url,data=excluded.data";

function _runCardInsert(stmt, card) {
  const r = cardToRow(card);
  stmt.run(r.id, r.url, r.platform, r.cat, r.ts, r.img_file, r.img_url, r.data);
}

function upsertCard(db, card) {
  _runCardInsert(db.prepare(_CARD_INSERT_SQL), card);
}

// node:sqlite has no db.transaction() helper; wrap the bulk write in BEGIN/COMMIT/ROLLBACK.
function replaceCards(db, arr) {
  const ins = db.prepare(_CARD_INSERT_SQL);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM cards").run();
    for (const c of (arr || [])) _runCardInsert(ins, c);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function deleteCard(db, id) {
  db.prepare("DELETE FROM cards WHERE id=?").run(id);
}

// Saved column fields live in their own columns; everything else goes in `data` JSON.
const SAVED_COLS = ["id", "url", "category", "clipped", "image"];

function savedToRow(item) {
  const image = item.image || "";
  let img_file = null, img_url = null;
  if (image.indexOf("idb:") === 0) img_file = item.id + ".jpg";
  else if (image.indexOf("http") === 0) img_url = image;
  const data = {};
  for (const k of Object.keys(item)) {
    if (SAVED_COLS.indexOf(k) === -1) data[k] = item[k];
  }
  return {
    id: item.id,
    url: item.url != null ? item.url : null,
    category: item.category != null ? item.category : null,
    clipped: item.clipped != null ? item.clipped : null,
    img_file,
    img_url,
    data: JSON.stringify(data),
  };
}

function rowToSaved(row) {
  const base = row.data ? JSON.parse(row.data) : {};
  base.id = row.id;
  base.url = row.url;
  base.category = row.category;
  base.clipped = row.clipped;
  base.image = row.img_file ? ("idb:" + row.id) : (row.img_url || "");
  return base;
}

function allSaved(db) {
  return db.prepare("SELECT * FROM saved").all().map(rowToSaved);
}

// node:sqlite has no named-param helper here; bind positional `?` params in column order.
const _SAVED_INSERT_SQL =
  "INSERT INTO saved(id,url,category,clipped,img_file,img_url,data) VALUES(?,?,?,?,?,?,?) " +
  "ON CONFLICT(id) DO UPDATE SET url=excluded.url,category=excluded.category,clipped=excluded.clipped,img_file=excluded.img_file,img_url=excluded.img_url,data=excluded.data";

function _runSavedInsert(stmt, item) {
  const r = savedToRow(item);
  stmt.run(r.id, r.url, r.category, r.clipped, r.img_file, r.img_url, r.data);
}

function upsertSaved(db, item) {
  _runSavedInsert(db.prepare(_SAVED_INSERT_SQL), item);
}

// node:sqlite has no db.transaction() helper; wrap the bulk write in BEGIN/COMMIT/ROLLBACK.
function replaceSaved(db, arr) {
  const ins = db.prepare(_SAVED_INSERT_SQL);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM saved").run();
    for (const it of (arr || [])) _runSavedInsert(ins, it);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function deleteSaved(db, id) {
  db.prepare("DELETE FROM saved WHERE id=?").run(id);
}

function getFp(db, id) {
  const row = db.prepare("SELECT fp FROM fp WHERE id=?").get(id);
  return row ? row.fp : null;
}
function setFp(db, id, fp) {
  db.prepare("INSERT INTO fp(id,fp) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET fp=excluded.fp").run(id, fp);
}
function delFp(db, id) {
  db.prepare("DELETE FROM fp WHERE id=?").run(id);
}
function allFp(db) {
  const out = {};
  for (const row of db.prepare("SELECT id,fp FROM fp").all()) out[row.id] = row.fp;
  return out;
}

module.exports = {
  openDb, getKV, setKV, delKV, counts,
  rowToCard, cardToRow, allCards, replaceCards, upsertCard, deleteCard,
  rowToSaved, savedToRow, allSaved, replaceSaved, upsertSaved, deleteSaved,
  getFp, setFp, delFp, allFp,
};
