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
  `CREATE TABLE IF NOT EXISTS tombstones (
     id TEXT, kind TEXT, deletedAt INTEGER, PRIMARY KEY(id, kind)
   );
   CREATE INDEX IF NOT EXISTS ix_tomb_deletedAt ON tombstones(deletedAt);`,
];

const SCHEMA_VERSION = 2;   // bump whenever the schema below changes

// Stable, key-order-independent stringify so content comparison doesn't churn
// updatedAt when the renderer round-trips a card and re-serializes `data`.
function _stable(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(_stable).join(",") + "]";
  return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + _stable(v[k])).join(",") + "}";
}
// Content signature of a stored-or-to-be-stored row (EXCLUDES id + updatedAt).
function cardSig(r) { return _stable([r.url, r.platform, r.cat, r.ts, r.img_file, r.img_url, JSON.parse(r.data || "{}")]); }
function savedSig(r) { return _stable([r.url, r.category, r.clipped, r.img_file, r.img_url, JSON.parse(r.data || "{}")]); }

// Add columns that ALTER can't add idempotently (ADD COLUMN throws if it exists).
function ensureColumns(db) {
  const hasCol = (table, col) =>
    db.prepare("PRAGMA table_info(" + table + ")").all().some(c => c.name === col);
  const now = Date.now();
  if (!hasCol("cards", "updatedAt")) {
    db.exec("ALTER TABLE cards ADD COLUMN updatedAt INTEGER");
    db.exec("UPDATE cards SET updatedAt = COALESCE(ts, " + now + ") WHERE updatedAt IS NULL");
  }
  if (!hasCol("saved", "updatedAt")) {
    db.exec("ALTER TABLE saved ADD COLUMN updatedAt INTEGER");
    db.exec("UPDATE saved SET updatedAt = " + now + " WHERE updatedAt IS NULL");
  }
}

function openDb(storeDir) {
  const db = new DatabaseSync(path.join(storeDir, "interests.db"));
  db.exec("PRAGMA journal_mode=WAL");
  for (const sql of MIGRATIONS) db.exec(sql);
  ensureColumns(db);                       // add updatedAt columns to existing DBs
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
const CARD_COLS = ["id", "url", "platform", "cat", "ts", "img", "updatedAt"];

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
  if ("updatedAt" in row) base.updatedAt = row.updatedAt != null ? row.updatedAt : (row.ts || 0);
  return base;
}

function allCards(db) {
  return db.prepare("SELECT * FROM cards").all().map(rowToCard);
}

// node:sqlite has no named-param helper here; bind positional `?` params in column order.
const _CARD_INSERT_SQL =
  "INSERT INTO cards(id,url,platform,cat,ts,img_file,img_url,data,updatedAt) VALUES(?,?,?,?,?,?,?,?,?) " +
  "ON CONFLICT(id) DO UPDATE SET url=excluded.url,platform=excluded.platform,cat=excluded.cat,ts=excluded.ts," +
  "img_file=excluded.img_file,img_url=excluded.img_url,data=excluded.data,updatedAt=excluded.updatedAt";

function _insertCardRow(stmt, r, updatedAt) {
  stmt.run(r.id, r.url, r.platform, r.cat, r.ts, r.img_file, r.img_url, r.data, updatedAt);
}

// Local write: auto-stamp updatedAt — bump only when stored content actually changed.
function upsertCard(db, card) {
  const r = cardToRow(card);
  const ex = db.prepare("SELECT url,platform,cat,ts,img_file,img_url,data,updatedAt FROM cards WHERE id=?").get(r.id);
  const updatedAt = (ex && cardSig(ex) === cardSig(r)) ? ex.updatedAt : Date.now();
  _insertCardRow(db.prepare(_CARD_INSERT_SQL), r, updatedAt);
}
// Merge write: set updatedAt explicitly to the winning peer's value.
function upsertCardSynced(db, card, updatedAt) {
  const ua = isFinite(updatedAt) ? Math.trunc(Number(updatedAt)) : Date.now();
  _insertCardRow(db.prepare(_CARD_INSERT_SQL), cardToRow(card), ua);
}

// node:sqlite has no db.transaction() helper; wrap the bulk write in BEGIN/COMMIT/ROLLBACK.
function replaceCards(db, arr) {
  const ins = db.prepare(_CARD_INSERT_SQL);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM cards").run();
    for (const c of (arr || [])) {
      const r = cardToRow(c);
      _insertCardRow(ins, r, Date.now());   // interim: Task A3 replaces with diff logic
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function addTombstone(db, id, kind, deletedAt) {
  const ts = (deletedAt != null && isFinite(deletedAt)) ? Math.trunc(Number(deletedAt)) : Date.now();
  // Keep the NEWEST deletedAt for an (id,kind).
  db.prepare(
    "INSERT INTO tombstones(id,kind,deletedAt) VALUES(?,?,?) " +
    "ON CONFLICT(id,kind) DO UPDATE SET deletedAt=MAX(tombstones.deletedAt, excluded.deletedAt)"
  ).run(id, kind, ts);
}
function allTombstones(db) {
  return db.prepare("SELECT id,kind,deletedAt FROM tombstones").all()
    .map(r => ({ id: r.id, kind: r.kind, deletedAt: Number(r.deletedAt) }));
}
function delTombstone(db, id, kind) {
  db.prepare("DELETE FROM tombstones WHERE id=? AND kind=?").run(id, kind);
}
// Delete tombstones older than (now - olderThanMs). Retention pruning.
function pruneTombstones(db, olderThanMs) {
  const cutoff = Date.now() - (olderThanMs | 0);
  db.prepare("DELETE FROM tombstones WHERE deletedAt < ?").run(cutoff);
}

function deleteCard(db, id) {
  db.prepare("DELETE FROM cards WHERE id=?").run(id);
  addTombstone(db, id, "card");
}

// Saved column fields live in their own columns; everything else goes in `data` JSON.
const SAVED_COLS = ["id", "url", "category", "clipped", "image", "updatedAt"];

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
  if ("updatedAt" in row) base.updatedAt = row.updatedAt != null ? row.updatedAt : 0;
  return base;
}

function allSaved(db) {
  return db.prepare("SELECT * FROM saved").all().map(rowToSaved);
}

// node:sqlite has no named-param helper here; bind positional `?` params in column order.
const _SAVED_INSERT_SQL =
  "INSERT INTO saved(id,url,category,clipped,img_file,img_url,data,updatedAt) VALUES(?,?,?,?,?,?,?,?) " +
  "ON CONFLICT(id) DO UPDATE SET url=excluded.url,category=excluded.category,clipped=excluded.clipped," +
  "img_file=excluded.img_file,img_url=excluded.img_url,data=excluded.data,updatedAt=excluded.updatedAt";

function _insertSavedRow(stmt, r, updatedAt) {
  stmt.run(r.id, r.url, r.category, r.clipped, r.img_file, r.img_url, r.data, updatedAt);
}

// Local write: auto-stamp updatedAt — bump only when stored content actually changed.
function upsertSaved(db, item) {
  const r = savedToRow(item);
  const ex = db.prepare("SELECT url,category,clipped,img_file,img_url,data,updatedAt FROM saved WHERE id=?").get(r.id);
  const updatedAt = (ex && savedSig(ex) === savedSig(r)) ? ex.updatedAt : Date.now();
  _insertSavedRow(db.prepare(_SAVED_INSERT_SQL), r, updatedAt);
}
// Merge write: set updatedAt explicitly to the winning peer's value.
function upsertSavedSynced(db, item, updatedAt) {
  const ua = isFinite(updatedAt) ? Math.trunc(Number(updatedAt)) : Date.now();
  _insertSavedRow(db.prepare(_SAVED_INSERT_SQL), savedToRow(item), ua);
}

// node:sqlite has no db.transaction() helper; wrap the bulk write in BEGIN/COMMIT/ROLLBACK.
function replaceSaved(db, arr) {
  const ins = db.prepare(_SAVED_INSERT_SQL);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM saved").run();
    for (const it of (arr || [])) {
      const r = savedToRow(it);
      _insertSavedRow(ins, r, Date.now());   // interim: Task A3 replaces with diff logic
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function deleteSaved(db, id) {
  db.prepare("DELETE FROM saved WHERE id=?").run(id);
  addTombstone(db, id, "saved");
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
  openDb, SCHEMA_VERSION, getKV, setKV, delKV, counts,
  rowToCard, cardToRow, cardSig, allCards, replaceCards, upsertCard, upsertCardSynced, deleteCard,
  rowToSaved, savedToRow, savedSig, allSaved, replaceSaved, upsertSaved, upsertSavedSynced, deleteSaved,
  getFp, setFp, delFp, allFp,
  addTombstone, allTombstones, delTombstone, pruneTombstones,
};
