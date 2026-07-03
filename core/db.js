// core/db.js — SQLite open/migrate + CRUD. Synchronous (node:sqlite DatabaseSync).
// Uses Node's built-in node:sqlite — part of the Node/Electron runtime, so there
// is nothing to compile, install, or rebuild for the DB. Verified under Node v25
// and Electron 42 (Node 24).
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { _stable } = require("./merge.js");

// A row's id is a TEXT PRIMARY KEY and is bound positionally, so a missing id
// (undefined) makes the bind THROW and rolls back the whole replaceCards/replaceSaved
// transaction — silently losing an entire import. Derive a STABLE fallback id from
// the row's identity so one id-less item can never wipe a write. Stable so the same
// item re-sent maps to the same row (idempotent) instead of duplicating.
function stableId(prefix, parts) {
  const basis = parts.map(p => (p == null ? "" : String(p))).join("");
  return prefix + crypto.createHash("sha1").update(basis).digest("hex").slice(0, 16);
}
function ensureId(id, prefix, parts) {
  return (id != null && id !== "") ? id : stableId(prefix, parts);
}

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
// Shared with core/merge.js (content signatures drive both local diffing and
// sync merging — drift between the two copies would cause phantom conflicts).
// Content signature of a stored-or-to-be-stored row (EXCLUDES id + updatedAt).
// Guarded the same way as rowToCard/rowToSaved: a corrupt stored `data` must not
// throw here either (cardSig/savedSig run against EXISTING rows read from the DB
// inside upsertCard/upsertSaved/replaceCards/replaceSaved).
function cardSig(r) { return _stable([r.url, r.platform, r.cat, r.ts, r.img_file, r.img_url, _safeParseData(r.data)]); }
function savedSig(r) { return _stable([r.url, r.category, r.clipped, r.img_file, r.img_url, _safeParseData(r.data)]); }

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
  const id = ensureId(card.id, "c_", [card.url, card.title, card.ts]);
  const img = card.img || "";
  let img_file = null, img_url = null;
  if (img.indexOf("idb:") === 0) img_file = id + ".jpg";   // use the resolved id, not a possibly-undefined card.id
  else if (img.indexOf("http") === 0) img_url = img;
  const data = {};
  for (const k of Object.keys(card)) {
    if (CARD_COLS.indexOf(k) === -1) data[k] = card[k];
  }
  return {
    id,
    url: card.url != null ? card.url : null,
    platform: card.platform != null ? card.platform : null,
    cat: card.cat != null ? card.cat : null,
    ts: card.ts != null ? card.ts : null,
    img_file,
    img_url,
    data: JSON.stringify(data),
  };
}

// A row's `data` JSON can be corrupt (disk-level bit rot, an interrupted write
// that partially landed, etc). One bad row must degrade gracefully — return the
// column fields with the JSON extras dropped — rather than throwing and losing
// the ENTIRE library read (allCards/allSaved map every row through this).
function _safeParseData(data) {
  if (!data) return {};
  try {
    const parsed = JSON.parse(data);
    return (parsed && typeof parsed === "object") ? parsed : {};
  } catch (e) {
    return {};
  }
}

function rowToCard(row) {
  const base = _safeParseData(row.data);
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
// The renderer persists by FULL-ARRAY replace, so removed/edited rows are observable
// ONLY by diffing here: keep updatedAt for unchanged rows, bump it for changed/new rows,
// tombstone every id present-before-but-absent-now, and clear tombstones for ids present now.
function replaceCards(db, arr, opts) {
  // asOf = the ms timestamp at which the client loaded the array it's now persisting.
  // A row absent from `arr` whose stored updatedAt > asOf changed AFTER the client
  // loaded (e.g. a background sync merge) — the client never saw it, so its absence
  // is staleness, not an intentional delete: keep it, don't tombstone it. No asOf ->
  // legacy full-replace (unchanged behavior for old extension/renderer clients).
  const asOf = opts && isFinite(opts.asOf) ? Math.trunc(Number(opts.asOf)) : null;
  const existing = {};
  for (const row of db.prepare("SELECT id,url,platform,cat,ts,img_file,img_url,data,updatedAt FROM cards").all()) {
    existing[row.id] = row;
  }
  const now = Date.now();
  const incoming = new Set();
  const ins = db.prepare(_CARD_INSERT_SQL);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM cards").run();
    for (const c of (arr || [])) {
      const r = cardToRow(c);
      incoming.add(r.id);
      const ex = existing[r.id];
      const updatedAt = (ex && cardSig(ex) === cardSig(r)) ? ex.updatedAt : now;
      _insertCardRow(ins, r, updatedAt);
    }
    for (const id of Object.keys(existing)) {
      if (incoming.has(id)) continue;
      if (asOf != null && Number(existing[id].updatedAt) > asOf) {
        // Re-insert the concurrently-synced row untouched (keep its own updatedAt)
        // and clear any stale tombstone for it — a live row shadowed by a tombstone
        // would be resurrect-then-redeleted on the next merge (merge.js: newest
        // tombstone vs updatedAt), so the tombstone must go.
        _insertCardRow(ins, existing[id], existing[id].updatedAt);
        delTombstone(db, id, "card");
        continue;
      }
      addTombstone(db, id, "card", now);
    }
    for (const id of incoming) delTombstone(db, id, "card");
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
  const cutoff = Date.now() - (Number(olderThanMs) || 0);
  db.prepare("DELETE FROM tombstones WHERE deletedAt < ?").run(cutoff);
}

function deleteCard(db, id, deletedAt) {
  db.prepare("DELETE FROM cards WHERE id=?").run(id);
  addTombstone(db, id, "card", deletedAt);
}

// Saved column fields live in their own columns; everything else goes in `data` JSON.
const SAVED_COLS = ["id", "url", "category", "clipped", "image", "updatedAt"];

function savedToRow(item) {
  const id = ensureId(item.id, "s_", [item.url, item.title, item.ts]);
  const image = item.image || "";
  let img_file = null, img_url = null;
  if (image.indexOf("idb:") === 0) img_file = id + ".jpg";   // use the resolved id, not a possibly-undefined item.id
  else if (image.indexOf("http") === 0) img_url = image;
  const data = {};
  for (const k of Object.keys(item)) {
    if (SAVED_COLS.indexOf(k) === -1) data[k] = item[k];
  }
  // Defense-in-depth: a clip thumbnail can be an inline data: URL — neither an idb:
  // file ref nor an http URL — and would otherwise be SILENTLY DROPPED here (it's
  // excluded from `data` because "image" is a promoted column). Preserve it in the
  // data JSON so a saved-clip image is never lost on a DB write. (The save path now
  // persists clip images as files, so this is the last-resort net, not the norm.)
  if (!img_file && !img_url && image.indexOf("data:") === 0) data.image = image;
  return {
    id,
    url: item.url != null ? item.url : null,
    category: item.category != null ? item.category : null,
    clipped: item.clipped != null ? item.clipped : null,
    img_file,
    img_url,
    data: JSON.stringify(data),
  };
}

function rowToSaved(row) {
  const base = _safeParseData(row.data);
  base.id = row.id;
  base.url = row.url;
  base.category = row.category;
  base.clipped = row.clipped;
  // A file ref wins, then an http url, then a preserved inline data: image (base.image
  // came from the data JSON — the savedToRow net above).
  base.image = row.img_file ? ("idb:" + row.id) : (row.img_url || base.image || "");
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
// Symmetric to replaceCards: content-diff stamping + tombstone diff (kind "saved").
function replaceSaved(db, arr, opts) {
  // See replaceCards for the asOf contract — symmetric, kind "saved".
  const asOf = opts && isFinite(opts.asOf) ? Math.trunc(Number(opts.asOf)) : null;
  const existing = {};
  for (const row of db.prepare("SELECT id,url,category,clipped,img_file,img_url,data,updatedAt FROM saved").all()) {
    existing[row.id] = row;
  }
  const now = Date.now();
  const incoming = new Set();
  const ins = db.prepare(_SAVED_INSERT_SQL);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM saved").run();
    for (const it of (arr || [])) {
      const r = savedToRow(it);
      incoming.add(r.id);
      const ex = existing[r.id];
      const updatedAt = (ex && savedSig(ex) === savedSig(r)) ? ex.updatedAt : now;
      _insertSavedRow(ins, r, updatedAt);
    }
    for (const id of Object.keys(existing)) {
      if (incoming.has(id)) continue;
      if (asOf != null && Number(existing[id].updatedAt) > asOf) {
        _insertSavedRow(ins, existing[id], existing[id].updatedAt);
        delTombstone(db, id, "saved");
        continue;
      }
      addTombstone(db, id, "saved", now);
    }
    for (const id of incoming) delTombstone(db, id, "saved");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

function deleteSaved(db, id, deletedAt) {
  db.prepare("DELETE FROM saved WHERE id=?").run(id);
  addTombstone(db, id, "saved", deletedAt);
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

// Coerce a `since` watermark the same way asOf is coerced elsewhere: absent/0/
// non-finite -> null (meaning "everything" — full-snapshot semantics for a
// first-ever poll or a caller that doesn't track a watermark yet).
function _sinceOrNull(since) {
  return (since != null && isFinite(since) && Number(since) > 0) ? Math.trunc(Number(since)) : null;
}

// Delta reads for /api/changes and /api/tombstones. Boundary is STRICT `>`,
// not `>=`. Reasoning: the caller (server.js) captures `now = Date.now()`
// BEFORE running these queries, and every local write stamps updatedAt via
// Date.now() at write time (upsertCard/upsertSaved/replaceCards/replaceSaved).
// Because `now` is captured first, any write that lands during the request
// window is stamped >= now+epsilon (wall clock only moves forward), so it can
// never be stamped exactly `now` as observed by the read that follows it —
// and if it raced in just before `now` was captured, strict `>` on the NEXT
// poll (since = that `now`) still delivers it, because its updatedAt is <=
// this `now`, making it visible in THIS response already. The only row that
// could tie exactly `since` is one whose updatedAt was itself returned as a
// previous poll's `now` and handed back as this poll's `since` — that row was
// already delivered in the poll that produced that `now`, so excluding it
// here (strict >) is correct and does not create a gap: at-least-once
// delivery holds because `now` is always captured strictly before the reads
// that observe writes up to and including that instant.
function cardsSince(db, since) {
  const s = _sinceOrNull(since);
  if (s == null) return allCards(db);
  return db.prepare("SELECT * FROM cards WHERE updatedAt > ?").all(s).map(rowToCard);
}
function savedSince(db, since) {
  const s = _sinceOrNull(since);
  if (s == null) return allSaved(db);
  return db.prepare("SELECT * FROM saved WHERE updatedAt > ?").all(s).map(rowToSaved);
}
function tombstonesSince(db, since) {
  const s = _sinceOrNull(since);
  if (s == null) return allTombstones(db);
  return db.prepare("SELECT id,kind,deletedAt FROM tombstones WHERE deletedAt > ?").all(s)
    .map(r => ({ id: r.id, kind: r.kind, deletedAt: Number(r.deletedAt) }));
}

function serializeLibrary(db) {
  return { cards: allCards(db), saved: allSaved(db), fp: allFp(db), tombstones: allTombstones(db) };
}

module.exports = {
  openDb, SCHEMA_VERSION, getKV, setKV, delKV, counts,
  rowToCard, cardToRow, cardSig, allCards, replaceCards, upsertCard, upsertCardSynced, deleteCard,
  rowToSaved, savedToRow, savedSig, allSaved, replaceSaved, upsertSaved, upsertSavedSynced, deleteSaved,
  getFp, setFp, delFp, allFp,
  addTombstone, allTombstones, delTombstone, pruneTombstones,
  cardsSince, savedSince, tombstonesSince,
  serializeLibrary,
};
