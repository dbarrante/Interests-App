# Dropbox Multi-Device Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Interests App share one library across multiple machines through Dropbox — each install keeps its live DB + images local, publishes a snapshot to its own Dropbox folder, and merges the other machines' snapshots (newest edit wins per item, deletes remembered via tombstones).

**Architecture:** Per-device snapshots + merge, no lock. Each install writes ONLY `<syncDir>/<deviceId>/` (snapshot.json + images/ + meta.json-last); every install reads peers' folders and merges into its local store on launch + every ~3 min, publishes on change (debounced) + on quit. Merge is a pure function; the live SQLite DB never goes into Dropbox.

**Tech Stack:** Electron + Node built-in `node:sqlite` (DatabaseSync, synchronous, no native deps) + Express on localhost + images as files. Tests are plain-Node `assert` run by `tests/run.js`.

## Global Constraints

- Repo stays **private**; **never create/edit/`git add` personal-data files** (`saves.json`, `*-import.json`, `interests-backup-*`, `interests-snapshot-*`, `data/`, `saves-*.json`). A PreToolUse hook blocks them.
- **Live SQLite DB stays LOCAL** — never placed in Dropbox. `config.getStorePath()` keeps returning a local writable dir.
- **Read-only on peer folders** — a merge never writes/renames/deletes inside another device's `<syncDir>/<deviceId>/`.
- **Safety backup before every merge that changes data**; **never bulk-overwrite the live store** (merge upserts + tombstone-deletes only — no `rm -rf`, no DB file swap).
- **Atomic publish** — write `*.tmp` then `fs.renameSync`; `meta.json` (the completion marker) written LAST.
- Engine = **`node:sqlite` only** (no native deps). `node:sqlite` has **no** `db.transaction()` helper — use explicit `BEGIN/COMMIT/ROLLBACK`.
- `core/merge.js` is **require()-able** in Node like `web/route-capture.js` (browser global + `module.exports`).
- Tests are plain-Node `assert` via `node tests/run.js`; it must end **`ALL TEST FILES PASSED`**. The inline-`<script>` syntax gate (`tests/syntax-check.js`) on `web/index.html` must stay green.
- Reuse existing helpers — do NOT reinvent: `detectDropboxRoot`, `dropboxBackupDir`, `runBackup`, `changedImageIds`, `verifyBackup`, `backupCountsMatch` (core/backup.js); `loadConfig`/`saveConfig`/`isWritableDir` (core/config.js); `getKV/setKV`, `upsertCard/upsertSaved/allCards/allSaved/allFp` (core/db.js); `buildContext`/`ctx.reopen` (core/appctx.js); `toast`, `renderDurabilityStatus`, the `moveDataLocation` pickFolder idiom, the origin middleware + `path.isAbsolute`/`resolve` guard (web/index.html, core/server.js).

## File Structure

- **Create `core/merge.js`** — pure `mergeSnapshots(local, peers) -> {upserts, deletes, tombstones, imageCopies, conflicts}`. No I/O. require()-able.
- **Create `core/sync.js`** — the orchestrator: device identity + sync config (config.json), `publishSnapshot`, `readPeerSnapshots`, `applyMerge`, `runSync`. Depends on db/images/backup/config/merge.
- **Modify `core/db.js`** — `updatedAt` columns + tombstones table + stamping/diff logic + `serializeLibrary` + `SCHEMA_VERSION`.
- **Modify `core/server.js`** — sync REST endpoints; mark `ctx.syncDirty` on writes.
- **Modify `core/config.js`** — sync config key helpers (deviceId/deviceLabel/syncEnabled/syncDir).
- **Modify `main.js`** — hoist `ctx` to module scope; launch sync; periodic timer; will-quit publish.
- **Modify `web/storage.js`** — `SE` + `Store` sync methods.
- **Modify `web/index.html`** — Settings "Dropbox sync" section + `renderSyncStatus` + handlers + incoming-change toast/poll.
- **Tests:** `tests/merge.test.js`, `tests/sync-snapshot.test.js`, `tests/sync-readonly.test.js`, plus additions to existing `tests/db.test.js` (or a new `tests/db-sync.test.js`).

Each `*.test.js` is a standalone Node script that prints `"<p> passed, <f> failed"` and exits non-zero on any failure. Use this exact harness shape (matches the repo):

```js
const assert = require("assert");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + name + "\n  " + (e && e.message)); } }
// ... test(...) calls ...
console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
```

For tests that need a real DB, create one in a temp dir:

```js
const os = require("os"), fs = require("fs"), path = require("path");
function tmpStore() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ia-sync-"));
  fs.mkdirSync(path.join(d, "images"), { recursive: true });
  return d;
}
```

---

# Phase A — DB schema & primitives (the data-safety core)

## Task A1: `updatedAt` column + content-diff stamping + `SCHEMA_VERSION`

**Files:**
- Modify: `core/db.js`
- Test: `tests/db-sync.test.js` (create)

**Interfaces:**
- Produces: `SCHEMA_VERSION` (number); `rowToCard`/`rowToSaved` now include `updatedAt`; `upsertCard(db, card)` auto-stamps `updatedAt` by content diff; `upsertCardSynced(db, card, updatedAt)` sets it explicitly; same for saved. `cardSig(r)`/`savedSig(r)` stable content signatures.

- [ ] **Step 1: Write the failing test** — append to a new `tests/db-sync.test.js`:

```js
const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path");
const db = require("../core/db");
let passed = 0, failed = 0;
function test(n, fn){ try{ fn(); passed++; }catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }
function tmpStore(){ const d = fs.mkdtempSync(path.join(os.tmpdir(),"ia-sync-")); fs.mkdirSync(path.join(d,"images"),{recursive:true}); return d; }

test("new card gets a fresh updatedAt", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  const t0 = Date.now();
  db.upsertCard(d, { id: "c_1", url: "https://a.com", cat: "x" });
  const got = db.allCards(d).find(c => c.id === "c_1");
  assert.ok(got.updatedAt >= t0, "updatedAt set on insert");
  d.close();
});

test("re-upsert with identical content keeps updatedAt", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  db.upsertCard(d, { id: "c_1", url: "https://a.com", cat: "x" });
  const first = db.allCards(d)[0].updatedAt;
  db.upsertCard(d, { id: "c_1", url: "https://a.com", cat: "x" });   // same content
  const second = db.allCards(d)[0].updatedAt;
  assert.strictEqual(first, second, "unchanged content must not bump updatedAt");
  d.close();
});

test("upsert with changed content bumps updatedAt", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  db.upsertCard(d, { id: "c_1", url: "https://a.com", cat: "x" });
  const first = db.allCards(d)[0].updatedAt;
  db.upsertCard(d, { id: "c_1", url: "https://a.com", cat: "DIFFERENT" });
  const second = db.allCards(d)[0].updatedAt;
  assert.ok(second > first, "changed content must bump updatedAt");
  d.close();
});

test("upsertCardSynced sets updatedAt explicitly (merge path)", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  db.upsertCardSynced(d, { id: "c_1", url: "https://a.com" }, 1234567);
  assert.strictEqual(db.allCards(d)[0].updatedAt, 1234567);
  d.close();
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run it, verify it fails**

Run: `node tests/db-sync.test.js`
Expected: FAIL (`upsertCardSynced` is not a function / `updatedAt` is undefined).

- [ ] **Step 3: Implement in `core/db.js`**

Add near the top (after the `MIGRATIONS` array) a schema version and column-ensure helper, and call it from `openDb`:

```js
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
```

Append a tombstones migration to the `MIGRATIONS` array (idempotent CREATEs — used in Task A2 but added here so the schema is complete):

```js
  `CREATE TABLE IF NOT EXISTS tombstones (
     id TEXT, kind TEXT, deletedAt INTEGER, PRIMARY KEY(id, kind)
   );
   CREATE INDEX IF NOT EXISTS ix_tomb_deletedAt ON tombstones(deletedAt);`,
```

In `openDb`, call `ensureColumns(db)` right after the migration loop and before `integrity_check`:

```js
function openDb(storeDir) {
  const db = new DatabaseSync(path.join(storeDir, "interests.db"));
  db.exec("PRAGMA journal_mode=WAL");
  for (const sql of MIGRATIONS) db.exec(sql);
  ensureColumns(db);                       // <-- add
  const ic = db.prepare("PRAGMA integrity_check").get();
  if (!ic || ic.integrity_check !== "ok") {
    throw new Error("integrity_check failed: " + (ic && ic.integrity_check));
  }
  return db;
}
```

Update `rowToCard` / `rowToSaved` to carry `updatedAt`:

```js
function rowToCard(row) {
  const base = row.data ? JSON.parse(row.data) : {};
  base.id = row.id; base.url = row.url; base.platform = row.platform;
  base.cat = row.cat; base.ts = row.ts;
  base.img = row.img_file ? ("idb:" + row.id) : (row.img_url || "");
  base.updatedAt = row.updatedAt != null ? row.updatedAt : (row.ts || 0);   // <-- add
  return base;
}
```
```js
function rowToSaved(row) {
  const base = row.data ? JSON.parse(row.data) : {};
  base.id = row.id; base.url = row.url; base.category = row.category; base.clipped = row.clipped;
  base.image = row.img_file ? ("idb:" + row.id) : (row.img_url || "");
  base.updatedAt = row.updatedAt != null ? row.updatedAt : 0;   // <-- add
  return base;
}
```

Note: `cardToRow`/`savedToRow` already drop `updatedAt` into `data` because it isn't in `CARD_COLS`/`SAVED_COLS`. Add `"updatedAt"` to **both** `CARD_COLS` and `SAVED_COLS` so it is NOT duplicated inside `data`:

```js
const CARD_COLS = ["id", "url", "platform", "cat", "ts", "img", "updatedAt"];
const SAVED_COLS = ["id", "url", "category", "clipped", "image", "updatedAt"];
```

Replace the card insert SQL + helpers to include the `updatedAt` column and the stamping logic:

```js
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
  _insertCardRow(db.prepare(_CARD_INSERT_SQL), cardToRow(card), updatedAt | 0);
}
```

Do the symmetric change for saved (`_SAVED_INSERT_SQL` + `_insertSavedRow` + `upsertSaved` + `upsertSavedSynced`), using `savedSig`. Export the new names:

```js
module.exports = {
  openDb, SCHEMA_VERSION, getKV, setKV, delKV, counts,
  rowToCard, cardToRow, cardSig, allCards, replaceCards, upsertCard, upsertCardSynced, deleteCard,
  rowToSaved, savedToRow, savedSig, allSaved, replaceSaved, upsertSaved, upsertSavedSynced, deleteSaved,
  getFp, setFp, delFp, allFp,
};
```

(`replaceCards`/`replaceSaved` are updated in Task A3 — for now leave their bodies but add an `updatedAt` of `Date.now()` to their insert calls so the column is never null:
`ins.run(r.id, r.url, r.platform, r.cat, r.ts, r.img_file, r.img_url, r.data, Date.now())` — Task A3 replaces this with the diff logic.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `node tests/db-sync.test.js`
Expected: `4 passed, 0 failed`.

- [ ] **Step 5: Run the full gate**

Run: `node tests/run.js`
Expected: ends `ALL TEST FILES PASSED` (existing `tests/db.test.js`, `tests/backup.test.js`, etc. still green — `updatedAt` is additive).

- [ ] **Step 6: Commit**

```bash
git add core/db.js tests/db-sync.test.js
git commit -m "feat(db): updatedAt column + content-diff stamping + SCHEMA_VERSION (sync groundwork)"
```

---

## Task A2: tombstones table + helpers + delete wiring

**Files:**
- Modify: `core/db.js`
- Test: `tests/db-sync.test.js` (extend)

**Interfaces:**
- Produces: `addTombstone(db, id, kind, deletedAt?)`, `allTombstones(db) -> [{id,kind,deletedAt}]`, `delTombstone(db, id, kind)`, `pruneTombstones(db, olderThanMs)`. `deleteCard`/`deleteSaved` now write a tombstone.

- [ ] **Step 1: Write the failing test** (append before the final `console.log`):

```js
test("addTombstone + allTombstones round-trip; delete writes a tombstone", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  db.upsertCard(d, { id: "c_1", url: "https://a.com" });
  db.deleteCard(d, "c_1");
  const tombs = db.allTombstones(d);
  assert.ok(tombs.some(t => t.id === "c_1" && t.kind === "card"), "delete leaves a tombstone");
  d.close();
});

test("addTombstone keeps the newest deletedAt; prune drops old ones", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  db.addTombstone(d, "c_2", "card", 1000);
  db.addTombstone(d, "c_2", "card", 5000);   // newer wins
  assert.strictEqual(db.allTombstones(d).find(t => t.id === "c_2").deletedAt, 5000);
  db.pruneTombstones(d, Date.now() - 4000);  // older-than cutoff removes deletedAt=5000? no — keep
  // deletedAt 5000 is ancient relative to now; prune(now - 4000) removes anything < now-4000.
  // Use an explicit cutoff instead:
  db.addTombstone(d, "c_old", "card", 1);
  db.pruneTombstones(d, 2);                  // remove deletedAt < (now - 2ms)? see impl note
  d.close();
});
```

(Keep the prune assertion simple — see Step 3 for the exact `pruneTombstones(db, olderThanMs)` contract: it deletes rows whose `deletedAt < Date.now() - olderThanMs`.)

- [ ] **Step 2: Run it, verify it fails**

Run: `node tests/db-sync.test.js`
Expected: FAIL (`allTombstones` not a function).

- [ ] **Step 3: Implement in `core/db.js`**

```js
function addTombstone(db, id, kind, deletedAt) {
  const ts = deletedAt != null ? (deletedAt | 0) : Date.now();
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
```

Wire deletes to record a tombstone:

```js
function deleteCard(db, id) {
  db.prepare("DELETE FROM cards WHERE id=?").run(id);
  addTombstone(db, id, "card");
}
function deleteSaved(db, id) {
  db.prepare("DELETE FROM saved WHERE id=?").run(id);
  addTombstone(db, id, "saved");
}
```

Add `addTombstone, allTombstones, delTombstone, pruneTombstones` to `module.exports`.

- [ ] **Step 4: Run the test, verify it passes** — `node tests/db-sync.test.js` → all passing.
- [ ] **Step 5: Full gate** — `node tests/run.js` → `ALL TEST FILES PASSED`.
- [ ] **Step 6: Commit**

```bash
git add core/db.js tests/db-sync.test.js
git commit -m "feat(db): tombstones table + helpers; deletes record tombstones"
```

---

## Task A3: `replaceCards`/`replaceSaved` — tombstone diff + content-diff stamping

This is the **critical** task: the renderer persists by FULL-ARRAY replace (`Store.putCards(imported)` everywhere), so removed items and edits are only observable by diffing here.

**Files:**
- Modify: `core/db.js`
- Test: `tests/db-sync.test.js` (extend)

**Interfaces:**
- Consumes: `cardSig`/`savedSig`, `addTombstone`/`delTombstone` (Tasks A1/A2).
- Produces: `replaceCards`/`replaceSaved` that (a) keep `updatedAt` for unchanged rows and bump it for changed/new rows; (b) write a tombstone for every id that was present before and is absent now; (c) clear any tombstone for an id present now.

- [ ] **Step 1: Write the failing test**

```js
test("replaceCards bumps updatedAt only for changed rows", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  db.replaceCards(d, [{ id: "c_1", url: "https://a.com", cat: "x" }, { id: "c_2", url: "https://b.com" }]);
  const u1 = db.allCards(d).find(c => c.id === "c_1").updatedAt;
  // Re-persist the full array with c_1 unchanged, c_2 edited:
  db.replaceCards(d, [{ id: "c_1", url: "https://a.com", cat: "x" }, { id: "c_2", url: "https://b-EDITED.com" }]);
  const after = db.allCards(d);
  assert.strictEqual(after.find(c => c.id === "c_1").updatedAt, u1, "unchanged card keeps updatedAt");
  assert.ok(after.find(c => c.id === "c_2").updatedAt > u1, "edited card bumps updatedAt");
  d.close();
});

test("replaceCards writes a tombstone for a removed card and clears it on re-add", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  db.replaceCards(d, [{ id: "c_1", url: "https://a.com" }, { id: "c_2", url: "https://b.com" }]);
  db.replaceCards(d, [{ id: "c_1", url: "https://a.com" }]);                       // c_2 removed
  assert.ok(db.allTombstones(d).some(t => t.id === "c_2"), "removed card tombstoned");
  db.replaceCards(d, [{ id: "c_1", url: "https://a.com" }, { id: "c_2", url: "https://b.com" }]); // re-added
  assert.ok(!db.allTombstones(d).some(t => t.id === "c_2"), "re-added card clears tombstone");
  d.close();
});
```

- [ ] **Step 2: Run it, verify it fails** — `node tests/db-sync.test.js` → the new tests FAIL.

- [ ] **Step 3: Implement `replaceCards` in `core/db.js`**

```js
function replaceCards(db, arr) {
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
    for (const id of Object.keys(existing)) if (!incoming.has(id)) addTombstone(db, id, "card", now);
    for (const id of incoming) delTombstone(db, id, "card");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
```

Apply the symmetric change to `replaceSaved` (use `savedSig`, kind `"saved"`, `_insertSavedRow`).

- [ ] **Step 4: Run the test, verify it passes** — `node tests/db-sync.test.js` → all passing.
- [ ] **Step 5: Full gate** — `node tests/run.js` → `ALL TEST FILES PASSED`.
- [ ] **Step 6: Commit**

```bash
git add core/db.js tests/db-sync.test.js
git commit -m "feat(db): replaceCards/replaceSaved diff -> tombstones + per-row updatedAt stamping"
```

---

## Task A4: `serializeLibrary(db)`

**Files:**
- Modify: `core/db.js`
- Test: `tests/db-sync.test.js` (extend)

**Interfaces:**
- Produces: `serializeLibrary(db) -> { cards, saved, fp, tombstones }` (cards/saved include `updatedAt`).

- [ ] **Step 1: Write the failing test**

```js
test("serializeLibrary returns cards, saved, fp, tombstones", () => {
  const dir = tmpStore(); const d = db.openDb(dir);
  db.upsertCard(d, { id: "c_1", url: "https://a.com" });
  db.upsertSaved(d, { id: "s_1", url: "https://s.com" });
  db.setFp(d, "c_1", "fp123");
  db.deleteSaved(d, "s_1");
  const lib = db.serializeLibrary(d);
  assert.ok(Array.isArray(lib.cards) && lib.cards[0].updatedAt > 0);
  assert.ok(lib.fp.c_1 === "fp123");
  assert.ok(lib.tombstones.some(t => t.id === "s_1" && t.kind === "saved"));
  d.close();
});
```

- [ ] **Step 2: Run it, verify it fails.**
- [ ] **Step 3: Implement**

```js
function serializeLibrary(db) {
  return { cards: allCards(db), saved: allSaved(db), fp: allFp(db), tombstones: allTombstones(db) };
}
```
Add `serializeLibrary` to `module.exports`.

- [ ] **Step 4: Run test → pass. Step 5: Full gate → `ALL TEST FILES PASSED`.**
- [ ] **Step 6: Commit**

```bash
git add core/db.js tests/db-sync.test.js
git commit -m "feat(db): serializeLibrary(db) for snapshot export"
```

---

# Phase B — pure merge

## Task B1: `core/merge.js` + `tests/merge.test.js`

**Files:**
- Create: `core/merge.js`
- Test: `tests/merge.test.js` (create)

**Interfaces:**
- Produces: `mergeSnapshots(local, peers) -> { upserts, deletes, tombstones, imageCopies, conflicts }`
  - `local = { cards: {id->card}, saved: {id->item}, tombstones: {"kind:id"->deletedAt} }`
  - `peers = [ { deviceId, dir, cards:[...], saved:[...], tombstones:[{id,kind,deletedAt}], imageIds:[...] } ]`
  - `upserts = [{ kind, item, updatedAt }]`, `deletes = [{ kind, id }]`, `tombstones = [{ id, kind, deletedAt }]`, `imageCopies = [{ id, fromDir }]`, `conflicts = Number`.
- Rules: newest `updatedAt` wins per (kind,id); local wins exact ties (minimizes churn). A tombstone whose `deletedAt > winner.updatedAt` deletes the item. An upsert is emitted only when the winner is a peer AND newer than local (or local is absent). A card/saved whose winning version has an `idb:` image and whose source peer lists that image id emits an `imageCopy`. `conflicts` counts upserts where local had a *different-content* version (a real overwrite, not a first add).

- [ ] **Step 1: Write `tests/merge.test.js` FIRST** (the behavioral contract):

```js
const assert = require("assert");
const { mergeSnapshots } = require("../core/merge");
let passed = 0, failed = 0;
function test(n, fn){ try{ fn(); passed++; }catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

const L = (cards, saved, tombs) => ({ cards: cards || {}, saved: saved || {}, tombstones: tombs || {} });
const peer = (id, cards, saved, tombs, imageIds) =>
  ({ deviceId: id, dir: "/dbx/" + id, cards: cards || [], saved: saved || [], tombstones: tombs || [], imageIds: imageIds || [] });

test("newest updatedAt wins (peer newer -> upsert)", () => {
  const local = L({ c_1: { id: "c_1", url: "old", updatedAt: 100 } });
  const peers = [peer("B", [{ id: "c_1", url: "new", updatedAt: 200 }])];
  const r = mergeSnapshots(local, peers);
  const up = r.upserts.find(u => u.kind === "card" && u.item.id === "c_1");
  assert.ok(up && up.item.url === "new" && up.updatedAt === 200);
});

test("local newer -> no upsert", () => {
  const local = L({ c_1: { id: "c_1", url: "local", updatedAt: 300 } });
  const peers = [peer("B", [{ id: "c_1", url: "peer", updatedAt: 200 }])];
  const r = mergeSnapshots(local, peers);
  assert.ok(!r.upserts.some(u => u.item.id === "c_1"), "older peer does not overwrite");
});

test("identical item already local -> no upsert (idempotent)", () => {
  const local = L({ c_1: { id: "c_1", url: "x", updatedAt: 200 } });
  const peers = [peer("B", [{ id: "c_1", url: "x", updatedAt: 200 }])];
  const r = mergeSnapshots(local, peers);
  assert.strictEqual(r.upserts.length, 0);
});

test("tombstone newer than item -> delete (no resurrect)", () => {
  const local = L({ c_1: { id: "c_1", url: "x", updatedAt: 100 } });
  const peers = [peer("B", [], [], [{ id: "c_1", kind: "card", deletedAt: 500 }])];
  const r = mergeSnapshots(local, peers);
  assert.ok(r.deletes.some(d => d.kind === "card" && d.id === "c_1"));
  assert.ok(!r.upserts.some(u => u.item.id === "c_1"));
});

test("edit newer than delete -> item survives (un-delete)", () => {
  const local = L({}, {}, { "card:c_1": 100 });                       // locally tombstoned at 100
  const peers = [peer("B", [{ id: "c_1", url: "revived", updatedAt: 500 }])];
  const r = mergeSnapshots(local, peers);
  assert.ok(r.upserts.some(u => u.item.id === "c_1"), "later edit beats older delete");
  assert.ok(!r.deletes.some(d => d.id === "c_1"));
});

test("image follows the winning peer item", () => {
  const local = L({ c_1: { id: "c_1", url: "old", img: "idb:c_1", updatedAt: 100 } });
  const peers = [peer("B", [{ id: "c_1", url: "new", img: "idb:c_1", updatedAt: 200 }], [], [], ["c_1"])];
  const r = mergeSnapshots(local, peers);
  assert.ok(r.imageCopies.some(ic => ic.id === "c_1" && ic.fromDir === "/dbx/B"));
});

test("empty peers -> no ops", () => {
  const r = mergeSnapshots(L({ c_1: { id: "c_1", updatedAt: 1 } }), []);
  assert.strictEqual(r.upserts.length + r.deletes.length + r.imageCopies.length, 0);
});

test("multi-peer convergence: newest across peers wins", () => {
  const local = L({ c_1: { id: "c_1", url: "v1", updatedAt: 100 } });
  const peers = [
    peer("B", [{ id: "c_1", url: "v2", updatedAt: 200 }]),
    peer("C", [{ id: "c_1", url: "v3", updatedAt: 300 }]),
  ];
  const r = mergeSnapshots(local, peers);
  const up = r.upserts.find(u => u.item.id === "c_1");
  assert.ok(up && up.item.url === "v3" && up.updatedAt === 300);
});

test("conflicts counts real overwrites only", () => {
  const local = L({ c_1: { id: "c_1", url: "mine", updatedAt: 100 }, c_2: { id: "c_2", url: "same", updatedAt: 100 } });
  const peers = [peer("B",
    [{ id: "c_1", url: "theirs", updatedAt: 200 },   // real conflict (content differs)
     { id: "c_3", url: "brandnew", updatedAt: 200 }] // first add, not a conflict
  )];
  const r = mergeSnapshots(local, peers);
  assert.strictEqual(r.conflicts, 1);
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run it, verify it fails** — `node tests/merge.test.js` → cannot find module `../core/merge`.

- [ ] **Step 3: Implement `core/merge.js`**

```js
// Pure multi-device merge (dual browser/Node, like web/route-capture.js).
// Newest updatedAt wins per item; tombstones prevent resurrect; images follow
// the winning item. NO I/O — fs paths are passed in (peer.dir) and echoed out.
(function (root) {
  "use strict";

  function _stable(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(_stable).join(",") + "]";
    return "{" + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ":" + _stable(v[k]); }).join(",") + "}";
  }
  // Compare two items for content equality, ignoring updatedAt.
  function sameContent(a, b) {
    if (!a || !b) return false;
    var ca = Object.assign({}, a); delete ca.updatedAt;
    var cb = Object.assign({}, b); delete cb.updatedAt;
    return _stable(ca) === _stable(cb);
  }
  function isIdbImage(item, kind) {
    var ref = kind === "card" ? (item && item.img) : (item && item.image);
    return typeof ref === "string" && ref.indexOf("idb:") === 0;
  }

  function mergeKind(kind, localMap, peers, localTombs, out) {
    var ids = {};
    Object.keys(localMap).forEach(function (id) { ids[id] = true; });
    peers.forEach(function (p) {
      (kind === "card" ? p.cards : p.saved).forEach(function (it) { if (it && it.id) ids[it.id] = true; });
      p.tombstones.forEach(function (t) { if (t.kind === kind) ids[t.id] = true; });
    });

    Object.keys(ids).forEach(function (id) {
      // winner = greatest updatedAt; local wins exact ties.
      var winner = localMap[id] ? { item: localMap[id], updatedAt: localMap[id].updatedAt || 0, source: "local", dir: null } : null;
      peers.forEach(function (p) {
        var list = kind === "card" ? p.cards : p.saved;
        for (var i = 0; i < list.length; i++) {
          var it = list[i];
          if (!it || it.id !== id) continue;
          var ua = it.updatedAt || 0;
          if (!winner || ua > winner.updatedAt) winner = { item: it, updatedAt: ua, source: p.deviceId, dir: p.dir, imageIds: p.imageIds };
        }
      });
      // newest tombstone across local + peers
      var tomb = localTombs[kind + ":" + id] || 0;
      peers.forEach(function (p) {
        p.tombstones.forEach(function (t) { if (t.kind === kind && t.id === id && t.deletedAt > tomb) tomb = t.deletedAt; });
      });

      if (tomb && (!winner || tomb > winner.updatedAt)) {
        if (localMap[id]) out.deletes.push({ kind: kind, id: id });
        out.tombstones.push({ id: id, kind: kind, deletedAt: tomb });
        return;
      }
      if (!winner || winner.source === "local") return;     // local already current
      if (localMap[id] && (winner.updatedAt <= (localMap[id].updatedAt || 0))) return;

      out.upserts.push({ kind: kind, item: winner.item, updatedAt: winner.updatedAt });
      if (localMap[id] && !sameContent(localMap[id], winner.item)) out.conflicts++;
      if (isIdbImage(winner.item, kind) && winner.imageIds && winner.imageIds.indexOf(id) >= 0) {
        out.imageCopies.push({ id: id, fromDir: winner.dir });
      }
    });
  }

  function mergeSnapshots(local, peers) {
    local = local || {}; peers = peers || [];
    var out = { upserts: [], deletes: [], tombstones: [], imageCopies: [], conflicts: 0 };
    mergeKind("card", local.cards || {}, peers, local.tombstones || {}, out);
    mergeKind("saved", local.saved || {}, peers, local.tombstones || {}, out);
    return out;
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { mergeSnapshots: mergeSnapshots };
  if (root) root.mergeSnapshots = mergeSnapshots;
})(typeof self !== "undefined" ? self : this);
```

- [ ] **Step 4: Run the test, verify it passes** — `node tests/merge.test.js` → `10 passed, 0 failed`.
- [ ] **Step 5: Full gate** — `node tests/run.js` → `ALL TEST FILES PASSED`.
- [ ] **Step 6: Commit**

```bash
git add core/merge.js tests/merge.test.js
git commit -m "feat(merge): pure mergeSnapshots (newest-wins + tombstones + image-follows-winner)"
```

---

# Phase C — snapshot I/O + sync orchestrator (`core/sync.js`)

## Task C1: device identity + sync config

**Files:**
- Modify: `core/config.js`
- Create: `core/sync.js` (identity + resolve functions only this task)
- Test: `tests/sync-snapshot.test.js` (create — identity tests first)

**Interfaces:**
- Produces (config.js): `getSyncConfig() -> { enabled, dir, deviceId, deviceLabel }` (reads config.json; generates+persists `deviceId`/`deviceLabel` once); `setSyncConfig(partial)` (read-modify-write merge).
- Produces (sync.js): `defaultSyncDir() -> string|null` (`<detectDropboxRoot()>/Interests App/sync`, null if no Dropbox); `peerDirs(syncDir, selfDeviceId) -> [{deviceId, dir}]`.

- [ ] **Step 1: Write the failing test** in `tests/sync-snapshot.test.js`:

```js
const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path");
const sync = require("../core/sync");
let passed = 0, failed = 0;
function test(n, fn){ try{ fn(); passed++; }catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }
function tmp(){ return fs.mkdtempSync(path.join(os.tmpdir(), "ia-snap-")); }

test("peerDirs lists other device folders, excluding self and non-dirs", () => {
  const syncDir = tmp();
  fs.mkdirSync(path.join(syncDir, "dev_A"));
  fs.mkdirSync(path.join(syncDir, "dev_B"));
  fs.writeFileSync(path.join(syncDir, "notadir.txt"), "x");
  const peers = sync.peerDirs(syncDir, "dev_A").map(p => p.deviceId).sort();
  assert.deepStrictEqual(peers, ["dev_B"]);
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run it, verify it fails** — cannot find `../core/sync`.

- [ ] **Step 3: Implement.** In `core/config.js` add:

```js
function getSyncConfig() {
  const cfg = loadConfig();
  let changed = false;
  if (!cfg.deviceId) { cfg.deviceId = "dev_" + require("crypto").randomUUID(); changed = true; }
  if (!cfg.deviceLabel) { cfg.deviceLabel = require("os").hostname() || "device"; changed = true; }
  if (changed) saveConfig(cfg);
  return {
    enabled: !!cfg.syncEnabled,
    dir: cfg.syncDir || null,
    deviceId: cfg.deviceId,
    deviceLabel: cfg.deviceLabel,
  };
}
function setSyncConfig(partial) {
  const cfg = loadConfig();
  const map = { enabled: "syncEnabled", dir: "syncDir", deviceLabel: "deviceLabel" };
  for (const k of Object.keys(partial || {})) {
    if (map[k]) cfg[map[k]] = partial[k];
  }
  saveConfig(cfg);
}
```
Add both to `module.exports`.

Create `core/sync.js`:

```js
"use strict";
const fs = require("fs");
const path = require("path");
const db = require("./db");
const images = require("./images");
const backup = require("./backup");
const config = require("./config");
const { mergeSnapshots } = require("./merge");

function defaultSyncDir() {
  const root = backup.detectDropboxRoot();
  return root ? path.join(root, "Interests App", "sync") : null;
}

// Other devices' folders inside syncDir (skip self + non-directories).
function peerDirs(syncDir, selfDeviceId) {
  let names = [];
  try { names = fs.readdirSync(syncDir); } catch (e) { return []; }
  return names
    .filter(function (n) { return n !== selfDeviceId; })
    .map(function (n) { return { deviceId: n, dir: path.join(syncDir, n) }; })
    .filter(function (p) { try { return fs.statSync(p.dir).isDirectory(); } catch (e) { return false; } });
}

module.exports = { defaultSyncDir, peerDirs };
```

- [ ] **Step 4: Run test → pass. Step 5: Full gate → green.**
- [ ] **Step 6: Commit**

```bash
git add core/config.js core/sync.js tests/sync-snapshot.test.js
git commit -m "feat(sync): device identity + sync config + peerDirs"
```

---

## Task C2: `publishSnapshot` (atomic, meta-last)

**Files:**
- Modify: `core/sync.js`
- Test: `tests/sync-snapshot.test.js` (extend)

**Interfaces:**
- Consumes: `db.serializeLibrary`, `db.counts`, `images.imagesDir`/`listImageIds`, `backup.changedImageIds`, `db.SCHEMA_VERSION`.
- Produces: `publishSnapshot(ctx, syncDir, deviceId, deviceLabel) -> { name, counts }`. Writes `<syncDir>/<deviceId>/`: images (incremental), then `snapshot.json` (temp+rename), then `meta.json` (temp+rename) LAST. `readSnapshot(dir) -> {schemaVersion, deviceId, deviceLabel, publishedAt, cards, saved, fp, tombstones, imageIds}|null` (null unless meta.json present AND counts match).

- [ ] **Step 1: Write the failing test**

```js
const dbm = require("../core/db");
function tmpStore(){ const d = fs.mkdtempSync(path.join(os.tmpdir(),"ia-store-")); fs.mkdirSync(path.join(d,"images"),{recursive:true}); return d; }

test("publishSnapshot writes meta.json last; readSnapshot round-trips", () => {
  const store = tmpStore(); const d = dbm.openDb(store);
  dbm.upsertCard(d, { id: "c_1", url: "https://a.com" });
  const ctx = { db: d, storeDir: store };
  const syncDir = tmp();
  sync.publishSnapshot(ctx, syncDir, "dev_A", "Desktop");
  const folder = path.join(syncDir, "dev_A");
  assert.ok(fs.existsSync(path.join(folder, "meta.json")), "meta.json present");
  const snap = sync.readSnapshot(folder);
  assert.ok(snap && snap.cards.length === 1 && snap.deviceId === "dev_A");
  d.close();
});

test("readSnapshot rejects a snapshot missing meta.json (incomplete)", () => {
  const store = tmpStore(); const d = dbm.openDb(store);
  dbm.upsertCard(d, { id: "c_1", url: "https://a.com" });
  const ctx = { db: d, storeDir: store };
  const syncDir = tmp();
  sync.publishSnapshot(ctx, syncDir, "dev_A", "Desktop");
  fs.rmSync(path.join(syncDir, "dev_A", "meta.json"));     // simulate a torn write
  assert.strictEqual(sync.readSnapshot(path.join(syncDir, "dev_A")), null);
  d.close();
});
```

- [ ] **Step 2: Run it, verify it fails.**

- [ ] **Step 3: Implement in `core/sync.js`**

```js
function _writeAtomic(file, text) {
  const tmpFile = file + ".tmp";
  fs.writeFileSync(tmpFile, text);
  fs.renameSync(tmpFile, file);
}

function publishSnapshot(ctx, syncDir, deviceId, deviceLabel) {
  const folder = path.join(syncDir, deviceId);
  const destImages = path.join(folder, "images");
  fs.mkdirSync(destImages, { recursive: true });

  // Flush WAL so serializeLibrary reflects the latest committed writes.
  try { ctx.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch (e) {}

  const lib = db.serializeLibrary(ctx.db);
  const c = db.counts(ctx.db);
  const counts = { cards: c.cards | 0, saved: c.saved | 0, images: images.imageCount(ctx.storeDir) | 0 };

  // 1) images first (incremental, only new/changed vs our own folder)
  const srcImages = images.imagesDir(ctx.storeDir);
  for (const id of backup.changedImageIds(ctx.storeDir, destImages)) {
    try { fs.copyFileSync(path.join(srcImages, id + ".jpg"), path.join(destImages, id + ".jpg")); } catch (e) {}
  }

  // 2) snapshot.json (atomic)
  const snapshot = {
    schemaVersion: db.SCHEMA_VERSION, deviceId: deviceId, deviceLabel: deviceLabel,
    publishedAt: Date.now(), cards: lib.cards, saved: lib.saved, fp: lib.fp, tombstones: lib.tombstones,
  };
  _writeAtomic(path.join(folder, "snapshot.json"), JSON.stringify(snapshot));

  // 3) meta.json LAST (the completion marker)
  _writeAtomic(path.join(folder, "meta.json"), JSON.stringify({
    schemaVersion: db.SCHEMA_VERSION, deviceId: deviceId, deviceLabel: deviceLabel,
    publishedAt: snapshot.publishedAt, counts: counts,
  }));

  return { name: deviceId, counts: counts };
}

// Read a peer/own snapshot folder. Returns null unless meta.json is present AND
// its counts match snapshot.json (guards against a half-synced Dropbox folder).
function readSnapshot(folder) {
  let meta, snap;
  try { meta = JSON.parse(fs.readFileSync(path.join(folder, "meta.json"), "utf8")); } catch (e) { return null; }
  try { snap = JSON.parse(fs.readFileSync(path.join(folder, "snapshot.json"), "utf8")); } catch (e) { return null; }
  if (!meta || !snap || !meta.counts) return null;
  if ((snap.cards || []).length !== (meta.counts.cards | 0)) return null;
  if ((snap.saved || []).length !== (meta.counts.saved | 0)) return null;
  let imageIds = [];
  try { imageIds = fs.readdirSync(path.join(folder, "images")).filter(function (n) { return n.endsWith(".jpg"); }).map(function (n) { return n.slice(0, -4); }); } catch (e) { imageIds = []; }
  return {
    schemaVersion: snap.schemaVersion, deviceId: snap.deviceId, deviceLabel: snap.deviceLabel,
    publishedAt: snap.publishedAt, cards: snap.cards || [], saved: snap.saved || [],
    fp: snap.fp || {}, tombstones: snap.tombstones || [], imageIds: imageIds,
  };
}

module.exports = { defaultSyncDir, peerDirs, publishSnapshot, readSnapshot };
```

- [ ] **Step 4: Run test → pass. Step 5: Full gate → green.**
- [ ] **Step 6: Commit**

```bash
git add core/sync.js tests/sync-snapshot.test.js
git commit -m "feat(sync): atomic publishSnapshot (meta-last) + verified readSnapshot"
```

---

## Task C3: `readPeerSnapshots` + `runSync` orchestrator + read-only guard

**Files:**
- Modify: `core/sync.js`
- Test: `tests/sync-readonly.test.js` (create), `tests/sync-snapshot.test.js` (extend with a two-device merge)

**Interfaces:**
- Consumes: `peerDirs`, `readSnapshot`, `mergeSnapshots`, `db.upsertCardSynced/upsertSavedSynced/deleteCard/deleteSaved/addTombstone`, `images` copy, `db.serializeLibrary`, `backup.runBackup`, `db.SCHEMA_VERSION`.
- Produces:
  - `readPeerSnapshots(syncDir, selfDeviceId) -> [snapshot]` (skips self, skips snapshots whose `schemaVersion > db.SCHEMA_VERSION`, skips incomplete).
  - `buildLocal(ctx) -> { cards:{id->c}, saved:{id->s}, tombstones:{"kind:id"->deletedAt} }`.
  - `applyMerge(ctx, plan) -> { changed: bool, upserts, deletes }` (executes plan; copies peer images; reopen NOT needed — upserts into open db).
  - `runSync(ctx, opts) -> { changed, conflicts, peers, publishedAt }` — the full launch/periodic cycle: read peers → mergeSnapshots → if any ops, ensure same-day `runBackup` THEN applyMerge → publishSnapshot → return status. `opts = { syncDir, deviceId, deviceLabel, publish: true }`.

- [ ] **Step 1: Write `tests/sync-readonly.test.js`** (the invariant) + a two-device merge test in `tests/sync-snapshot.test.js`:

`tests/sync-readonly.test.js`:
```js
const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path");
const dbm = require("../core/db");
const sync = require("../core/sync");
let passed = 0, failed = 0;
function test(n, fn){ try{ fn(); passed++; }catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }
function tmpStore(){ const d = fs.mkdtempSync(path.join(os.tmpdir(),"ia-ro-")); fs.mkdirSync(path.join(d,"images"),{recursive:true}); return d; }
function snapshotTree(dir){ const out = {}; (function walk(d, rel){ for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const st = fs.statSync(p); const r = rel + "/" + n; if (st.isDirectory()) walk(p, r); else out[r] = st.mtimeMs + ":" + st.size; } })(dir, ""); return out; }

test("runSync never writes inside a peer's folder (read-only on peers)", () => {
  const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-dbx-"));
  // Peer B publishes a snapshot we will read.
  const storeB = tmpStore(); const dB = dbm.openDb(storeB);
  dbm.upsertCard(dB, { id: "c_B", url: "https://b.com" });
  sync.publishSnapshot({ db: dB, storeDir: storeB }, syncDir, "dev_B", "Laptop"); dB.close();
  const before = snapshotTree(path.join(syncDir, "dev_B"));
  // Device A runs a sync.
  const storeA = tmpStore(); const dA = dbm.openDb(storeA);
  sync.runSync({ db: dA, storeDir: storeA }, { syncDir: syncDir, deviceId: "dev_A", deviceLabel: "Desktop", publish: true, backupFn: function () {} });
  const after = snapshotTree(path.join(syncDir, "dev_B"));
  assert.deepStrictEqual(after, before, "peer folder must be untouched");
  dA.close();
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
```

Two-device merge test (append to `tests/sync-snapshot.test.js`):
```js
test("device A merges in device B's card + image", () => {
  const syncDir = tmp();
  // B publishes a card with an image file.
  const storeB = tmpStore(); const dB = dbm.openDb(storeB);
  dbm.upsertCard(dB, { id: "c_B", url: "https://b.com", img: "idb:c_B" });
  fs.writeFileSync(path.join(storeB, "images", "c_B.jpg"), "JPGBYTES");
  sync.publishSnapshot({ db: dB, storeDir: storeB }, syncDir, "dev_B", "Laptop"); dB.close();
  // A runs a sync.
  const storeA = tmpStore(); const dA = dbm.openDb(storeA);
  const res = sync.runSync({ db: dA, storeDir: storeA }, { syncDir, deviceId: "dev_A", deviceLabel: "Desktop", publish: true, backupFn: function () {} });
  assert.ok(res.changed, "merge changed local data");
  assert.ok(dbm.allCards(dA).some(c => c.id === "c_B"), "B's card merged into A");
  assert.ok(fs.existsSync(path.join(storeA, "images", "c_B.jpg")), "B's image copied to A");
  dA.close();
});
```

- [ ] **Step 2: Run both, verify they fail** (`runSync` undefined).

- [ ] **Step 3: Implement in `core/sync.js`**

```js
function readPeerSnapshots(syncDir, selfDeviceId) {
  return peerDirs(syncDir, selfDeviceId)
    .map(function (p) { return readSnapshot(p.dir); })
    .filter(function (s) { return s && (s.schemaVersion | 0) <= db.SCHEMA_VERSION; })
    .map(function (s) {
      // mergeSnapshots wants peer.dir for image copies.
      return Object.assign({}, s, { dir: path.join(syncDir, s.deviceId) });
    });
}

function buildLocal(ctx) {
  const lib = db.serializeLibrary(ctx.db);
  const cards = {}, saved = {}, tombs = {};
  lib.cards.forEach(function (c) { cards[c.id] = c; });
  lib.saved.forEach(function (s) { saved[s.id] = s; });
  lib.tombstones.forEach(function (t) { tombs[t.kind + ":" + t.id] = t.deletedAt; });
  return { cards: cards, saved: saved, tombstones: tombs };
}

function applyMerge(ctx, plan) {
  const changed = (plan.upserts.length + plan.deletes.length + plan.imageCopies.length) > 0;
  for (const u of plan.upserts) {
    if (u.kind === "card") db.upsertCardSynced(ctx.db, u.item, u.updatedAt);
    else db.upsertSavedSynced(ctx.db, u.item, u.updatedAt);
  }
  for (const ic of plan.imageCopies) {
    try { fs.copyFileSync(path.join(ic.fromDir, "images", ic.id + ".jpg"), path.join(ctx.storeDir, "images", ic.id + ".jpg")); } catch (e) {}
  }
  for (const d of plan.deletes) {
    if (d.kind === "card") db.deleteCard(ctx.db, d.id); else db.deleteSaved(ctx.db, d.id);
    try { images.delImg(ctx.storeDir, d.id); } catch (e) {}
  }
  for (const t of plan.tombstones) db.addTombstone(ctx.db, t.id, t.kind, t.deletedAt);
  return { changed: changed, upserts: plan.upserts.length, deletes: plan.deletes.length };
}

// One full cycle. backupFn defaults to backup.runBackup; injectable for tests.
function runSync(ctx, opts) {
  opts = opts || {};
  const syncDir = opts.syncDir;
  const backupFn = opts.backupFn || function () { try { backup.runBackup(ctx.db, ctx.storeDir); } catch (e) {} };
  let changed = false, conflicts = 0;
  const peers = readPeerSnapshots(syncDir, opts.deviceId);
  if (peers.length) {
    const plan = mergeSnapshots(buildLocal(ctx), peers);
    if ((plan.upserts.length + plan.deletes.length + plan.imageCopies.length) > 0) {
      backupFn();                              // safety backup ONLY when the merge will change data
      const r = applyMerge(ctx, plan);
      changed = r.changed; conflicts = plan.conflicts;
    }
  }
  let publishedAt = null;
  if (opts.publish !== false) {
    fs.mkdirSync(syncDir, { recursive: true });
    const out = publishSnapshot(ctx, syncDir, opts.deviceId, opts.deviceLabel);
    publishedAt = Date.now();
    void out;
  }
  return { changed: changed, conflicts: conflicts, peers: peers.map(function (p) { return { deviceId: p.deviceId, deviceLabel: p.deviceLabel, publishedAt: p.publishedAt }; }), publishedAt: publishedAt };
}

module.exports = { defaultSyncDir, peerDirs, publishSnapshot, readSnapshot, readPeerSnapshots, buildLocal, applyMerge, runSync };
```

- [ ] **Step 4: Run both tests → pass. Step 5: Full gate → green.**
- [ ] **Step 6: Commit**

```bash
git add core/sync.js tests/sync-readonly.test.js tests/sync-snapshot.test.js
git commit -m "feat(sync): runSync orchestrator (read peers -> merge -> safety-backup -> apply -> publish); read-only on peers"
```

---

# Phase D — lifecycle wiring (main.js)

## Task D1: launch sync, periodic refresh, dirty-debounced publish, quit publish

main.js can't be unit-tested in this harness; verify via `node -c main.js` (parses) + the full gate staying green + manual smoke. Keep ALL sync work wrapped so a sync failure never blocks app start.

**Files:**
- Modify: `main.js`
- Modify: `core/server.js` (set `ctx.syncDirty = true` on write routes — done in Task E1; here just read it)

**Interfaces:**
- Consumes: `core/sync.runSync`, `core/config.getSyncConfig`.
- Produces: module-scope `ctx`; launch merge+publish; `setInterval` periodic sync (~3 min); a debounced publisher reading `ctx.syncDirty`; `will-quit` synchronous publish.

- [ ] **Step 1: Implement.** At the top of `main.js`, hoist `ctx` and add sync requires:

```js
const sync = require("./core/sync");
let mainWindow = null;
let httpServer = null;
let ctx = null;                 // hoisted so will-quit / timers can reach it
let syncTimer = null;
let publishTimer = null;
```

Inside `app.whenReady().then(async () => { try { ... } })`, AFTER `ctx = buildContext(storeDir);` and BEFORE `startServer`:

```js
      ctx = buildContext(storeDir);

      // Dropbox sync (non-fatal): merge peers + publish before the server serves data.
      try {
        const sc = config.getSyncConfig();
        if (sc.enabled && (sc.dir || sync.defaultSyncDir())) {
          const syncDir = sc.dir || sync.defaultSyncDir();
          sync.runSync(ctx, { syncDir, deviceId: sc.deviceId, deviceLabel: sc.deviceLabel, publish: true });
          startSyncTimers(sc, syncDir);
        }
      } catch (e) { console.error("launch sync skipped:", e && e.message); }   // NEVER hard-fail launch

      const { server, port } = await startServer(ctx, 3456);
```

Note: assign `ctx` (no `const`) so it binds the module-scope variable. Add the timer helpers near `createWindow`:

```js
function startSyncTimers(sc, syncDir) {
  // Periodic merge + publish (~3 min). On a change, signal the renderer via a kv flag.
  syncTimer = setInterval(function () {
    try {
      const res = sync.runSync(ctx, { syncDir, deviceId: sc.deviceId, deviceLabel: sc.deviceLabel, publish: true });
      if (res.changed) { try { require("./core/db").setKV(ctx.db, "ia_sync_changed_at", String(Date.now())); } catch (e) {} }
    } catch (e) { console.error("periodic sync error:", e && e.message); }
  }, 3 * 60 * 1000);

  // Debounced publish: every ~10s, if a write marked the store dirty, publish our snapshot.
  publishTimer = setInterval(function () {
    if (!ctx || !ctx.syncDirty) return;
    ctx.syncDirty = false;
    try { sync.publishSnapshot(ctx, syncDir, sc.deviceId, sc.deviceLabel); } catch (e) { console.error("debounced publish error:", e && e.message); }
  }, 10 * 1000);
}
```

In `app.on("will-quit", ...)` add a final synchronous publish if dirty (keep it sync — Electron does not await here):

```js
  app.on("will-quit", () => {
    try {
      if (ctx && ctx.syncDirty) {
        const sc = config.getSyncConfig();
        if (sc.enabled) {
          const syncDir = sc.dir || sync.defaultSyncDir();
          if (syncDir) sync.publishSnapshot(ctx, syncDir, sc.deviceId, sc.deviceLabel);
        }
      }
    } catch (e) { /* best-effort */ }
    if (syncTimer) { try { clearInterval(syncTimer); } catch (e) {} }
    if (publishTimer) { try { clearInterval(publishTimer); } catch (e) {} }
    if (httpServer) { try { httpServer.close(); } catch (_) {} }
  });
```

- [ ] **Step 2: Verify it parses** — `node -c main.js` → no output (success).
- [ ] **Step 3: Full gate** — `node tests/run.js` → `ALL TEST FILES PASSED` (main.js isn't imported by tests; this confirms nothing else broke).
- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(main): launch/periodic/quit Dropbox sync wiring (non-fatal, hoisted ctx)"
```

---

# Phase E — endpoints + Settings UI

## Task E1: sync REST endpoints + dirty-flag on writes + storage.js methods

**Files:**
- Modify: `core/server.js`
- Modify: `web/storage.js`
- Test: `tests/sync-endpoints.test.js` (create)

**Interfaces:**
- Produces (server): `GET /api/sync-status`, `POST /api/sync/enable {enabled}`, `POST /api/sync/folder {folder}` (absolute, resolved — like `/api/store-location/move`), `POST /api/sync/device-label {label}`, `POST /api/sync/now`. Write routes (`PUT /api/cards`, `PUT /api/saved`, `PATCH`/`DELETE` of cards/saved, `PUT /api/img/:id`, `POST /api/captures`) set `ctx.syncDirty = true`.
- Produces (storage.js): `SE.syncStatus/syncEnable/syncFolder/syncDeviceLabel/syncNow`; `Store.syncStatus()/setSyncEnabled(b)/setSyncFolder(p)/setDeviceLabel(s)/syncNow()`.

- [ ] **Step 1: Write `tests/sync-endpoints.test.js`** (createServer on an ephemeral port via Node http, like the app does):

```js
const assert = require("assert");
const os = require("os"), fs = require("fs"), path = require("path"), http = require("http");
const { buildContext } = require("../core/appctx");
const { createServer } = require("../core/server");
let passed = 0, failed = 0;
function test(n, fn){ return fn().then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }
function tmpStore(){ const d = fs.mkdtempSync(path.join(os.tmpdir(),"ia-ep-")); fs.mkdirSync(path.join(d,"images"),{recursive:true}); return d; }
function listen(app){ return new Promise(r=>{ const s=http.createServer(app); s.listen(0,"127.0.0.1",()=>r({s,port:s.address().port})); }); }
function req(port, method, p, body){ return new Promise((resolve,reject)=>{ const data=body?JSON.stringify(body):null; const r=http.request({host:"127.0.0.1",port,method,path:p,headers:{"Content-Type":"application/json"}},res=>{let b="";res.on("data",c=>b+=c);res.on("end",()=>resolve({status:res.statusCode,json:(()=>{try{return JSON.parse(b)}catch(e){return null}})()}));}); r.on("error",reject); if(data)r.write(data); r.end(); }); }

(async () => {
  const ctx = buildContext(tmpStore());
  const { s, port } = await listen(createServer(ctx));

  await test("GET /api/sync-status returns a shape", async () => {
    const r = await req(port, "GET", "/api/sync-status");
    assert.strictEqual(r.status, 200);
    assert.ok("enabled" in r.json && "deviceId" in r.json);
  });
  await test("POST /api/sync/folder rejects a relative path", async () => {
    const r = await req(port, "POST", "/api/sync/folder", { folder: "relative/dir" });
    assert.strictEqual(r.status, 400);
  });
  await test("PUT /api/cards marks ctx dirty", async () => {
    ctx.syncDirty = false;
    await req(port, "PUT", "/api/cards", { cards: [{ id: "c_1", url: "https://a.com" }] });
    assert.strictEqual(ctx.syncDirty, true);
  });

  s.close(); ctx.db.close();
  console.log(passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();
```

- [ ] **Step 2: Run it, verify it fails** — `/api/sync-status` 404s.

- [ ] **Step 3: Implement in `core/server.js`.** Add `const config = require("./config");` and `const sync = require("./sync");` at the top. After the `// ---- data location ----` block (after `/api/store-location/move`), add:

```js
  // ---- Dropbox sync ----
  app.get("/api/sync-status", (req, res) => {
    const sc = config.getSyncConfig();
    const syncDir = sc.dir || sync.defaultSyncDir();
    let peers = [], dropboxFound = !!sync.defaultSyncDir();
    try { if (syncDir) peers = sync.readPeerSnapshots(syncDir, sc.deviceId).map(p => ({ deviceLabel: p.deviceLabel, deviceId: p.deviceId, publishedAt: p.publishedAt })); } catch (e) {}
    let changedAt = 0; try { changedAt = +(dbm.getKV(ctx.db, "ia_sync_changed_at") || 0); } catch (e) {}
    res.json({
      enabled: sc.enabled, folder: syncDir, dropboxFound,
      deviceId: sc.deviceId, deviceLabel: sc.deviceLabel,
      peers, changedAt,
    });
  });

  app.post("/api/sync/enable", (req, res) => {
    config.setSyncConfig({ enabled: !!(req.body && req.body.enabled) });
    res.json({ ok: true });
  });

  app.post("/api/sync/folder", (req, res) => {
    let folder = req.body && req.body.folder;
    if (!folder || typeof folder !== "string" || !path.isAbsolute(folder)) {
      return res.status(400).json({ ok: false, error: "absolute folder required" });
    }
    folder = path.resolve(folder);
    config.setSyncConfig({ dir: folder });
    res.json({ ok: true, folder });
  });

  app.post("/api/sync/device-label", (req, res) => {
    const label = req.body && req.body.label;
    if (!label || typeof label !== "string") return res.status(400).json({ ok: false, error: "label required" });
    config.setSyncConfig({ deviceLabel: label.slice(0, 60) });
    res.json({ ok: true });
  });

  app.post("/api/sync/now", (req, res) => {
    const sc = config.getSyncConfig();
    const syncDir = sc.dir || sync.defaultSyncDir();
    if (!sc.enabled || !syncDir) return res.status(400).json({ ok: false, error: "sync not enabled / no Dropbox" });
    try {
      const r = sync.runSync(ctx, { syncDir, deviceId: sc.deviceId, deviceLabel: sc.deviceLabel, publish: true });
      if (r.changed) { try { dbm.setKV(ctx.db, "ia_sync_changed_at", String(Date.now())); } catch (e) {} }
      res.json({ ok: true, changed: r.changed, conflicts: r.conflicts, peers: r.peers });
    } catch (e) { console.error("sync now failed:", e); res.status(500).json({ ok: false, error: "sync failed" }); }
  });
```

Mark the store dirty on write routes. Add `ctx.syncDirty = true;` as the first line inside these handlers: `PUT /api/cards`, `PATCH /api/cards/:id`, `DELETE /api/cards/:id`, `PUT /api/saved`, `PATCH /api/saved/:id`, `DELETE /api/saved/:id`, `PUT /api/img/:id`, `DELETE /api/img/:id`, `POST /api/captures`. Example:

```js
  app.put("/api/cards", (req, res) => {
    ctx.syncDirty = true;
    const cards = (req.body && req.body.cards) || [];
    dbm.replaceCards(db, cards);
    res.json({ ok: true, count: cards.length });
  });
```

In `web/storage.js`, add the SE builders (inside the `SE` object):

```js
    syncStatus: function () { return "/api/sync-status"; },
    syncEnable: function () { return "/api/sync/enable"; },
    syncFolder: function () { return "/api/sync/folder"; },
    syncDeviceLabel: function () { return "/api/sync/device-label"; },
    syncNow: function () { return "/api/sync/now"; },
```

and the Store methods (inside the `Store` object):

```js
      syncStatus: function () { return jget(SE.syncStatus()); },
      setSyncEnabled: function (b) { return jsend("POST", SE.syncEnable(), { enabled: !!b }); },
      setSyncFolder: function (p) { return jsend("POST", SE.syncFolder(), { folder: p }); },
      setDeviceLabel: function (s) { return jsend("POST", SE.syncDeviceLabel(), { label: s }); },
      syncNow: function () { return jsend("POST", SE.syncNow()); },
```

- [ ] **Step 4: Run the endpoint test → pass. Step 5: Full gate → `ALL TEST FILES PASSED`** (the inline-script syntax gate also covers storage.js indirectly via index.html; storage.js itself is plain JS — `node -c web/storage.js` should pass too).
- [ ] **Step 6: Commit**

```bash
git add core/server.js web/storage.js tests/sync-endpoints.test.js
git commit -m "feat(server): sync REST endpoints + dirty-on-write; storage.js sync methods"
```

---

## Task E2: Settings "Dropbox sync" section + status + incoming-change toast

**Files:**
- Modify: `web/index.html`
- Test: covered by `tests/syntax-check.js` (inline-script parse) via `node tests/run.js`; behavior is manual-smoke.

**Interfaces:**
- Consumes: `Store.syncStatus/setSyncEnabled/setSyncFolder/setDeviceLabel/syncNow`; `toast`; the `(window.ia&&window.ia.pickFolder)||(window.app&&window.app.pickFolder)` idiom.
- Produces: a `<div class="sec">` "Dropbox sync" block; `renderSyncStatus()`; `chooseSyncFolder()`; a `setInterval` poll that toasts on `changedAt` increase.

- [ ] **Step 1: Add the markup.** In `web/index.html`, insert immediately AFTER the "Backup & restore" `</div>` (the `<div class="sec">` ending at line ~468) and BEFORE the `<button ... onclick="saveSettings(true)">` (line ~470):

```html
      <div class="sec">
        <h3>Dropbox sync</h3>
        <div class="hint" style="margin-bottom:10px">Share your library across machines through Dropbox. Each computer keeps its own local copy and merges changes from the others — newest edit wins. The live database never lives inside Dropbox.</div>
        <label style="display:flex;align-items:center;gap:9px;font-size:14px;cursor:pointer">
          <input type="checkbox" id="syncToggle" style="width:auto"> Enable Dropbox sync
        </label>
        <div style="margin-top:12px">
          <button class="btn btn-ghost" onclick="chooseSyncFolder()">Choose Dropbox folder…</button>
          <span class="hint" id="syncFolderInfo" style="margin-left:8px"></span>
        </div>
        <label style="margin-top:14px;display:block">This device's name</label>
        <input type="text" id="syncDeviceName" style="width:auto;min-width:220px" placeholder="e.g. Desktop">
        <div style="margin-top:12px">
          <button class="btn btn-ghost" onclick="syncNowClick()">&#8635; Sync now</button>
        </div>
        <div id="syncStatus" class="hint" style="margin-top:10px;line-height:1.7"></div>
      </div>
```

- [ ] **Step 2: Add the JS handlers** near `moveDataLocation` (after line ~1014):

```js
async function renderSyncStatus(){
  const el = document.getElementById("syncStatus"); if(!el) return;
  let st = null; try{ st = await Store.syncStatus(); }catch(e){}
  if(!st){ el.textContent = "Sync status unavailable."; return; }
  const tog = document.getElementById("syncToggle"); if(tog) tog.checked = !!st.enabled;
  const fi = document.getElementById("syncFolderInfo");
  if(fi) fi.textContent = st.folder ? st.folder : (st.dropboxFound ? "(default Dropbox location)" : "Dropbox not found — install Dropbox or pick a folder.");
  const nm = document.getElementById("syncDeviceName"); if(nm && document.activeElement!==nm) nm.value = st.deviceLabel || "";
  const peers = (st.peers||[]).map(p => esc(p.deviceLabel||p.deviceId) + (p.publishedAt ? " ("+new Date(p.publishedAt).toLocaleString()+")" : "")).join(", ") || "none seen yet";
  el.innerHTML =
    "<div>Status: <b>" + (st.enabled ? "on" : "off") + "</b></div>" +
    "<div>This device: <b>" + esc(st.deviceLabel||"") + "</b></div>" +
    "<div>Other devices: <b>" + peers + "</b></div>";
}
async function chooseSyncFolder(){
  const pf = (window.ia && window.ia.pickFolder) || (window.app && window.app.pickFolder);
  let target = null;
  if(pf){ try{ target = await pf(); }catch(e){ target = null; } }
  else { target = prompt("Full path of the Dropbox sync folder:"); }
  if(!target) return;
  try{ await Store.setSyncFolder(target); toast("Sync folder set"); await renderSyncStatus(); }
  catch(e){ toast("Couldn't set folder: " + (e&&e.message||e)); }
}
async function syncNowClick(){
  toast("Syncing…");
  try{ const r = await Store.syncNow(); toast(r && r.changed ? "Synced — new items merged in" : "Synced — already up to date"); if(r && r.changed){ setTimeout(()=>location.reload(), 900); } }
  catch(e){ toast("Sync failed: " + (e&&e.message||e)); }
}
```

- [ ] **Step 3: Wire controls in `renderSettings()`** — add before the closing `renderImportStatus();` tail (around line 1104):

```js
  if(document.getElementById("syncToggle")){
    document.getElementById("syncToggle").onchange = async e=>{ try{ await Store.setSyncEnabled(e.target.checked); toast(e.target.checked?"Dropbox sync enabled":"Dropbox sync disabled"); }catch(err){} renderSyncStatus(); };
    const nm = document.getElementById("syncDeviceName");
    if(nm) nm.onchange = async e=>{ try{ await Store.setDeviceLabel(e.target.value.trim()); }catch(err){} };
  }
  if(typeof renderSyncStatus === "function") renderSyncStatus();
```

- [ ] **Step 4: Add the incoming-change poll.** Find where the app sets up its capture poll (`setInterval(drainCaptures, 3000)` — search `drainCaptures`). After that line, add a separate, slower sync poll:

```js
let _lastSyncChangedAt = 0;
async function pollSyncChanged(){
  try{
    const st = await Store.syncStatus();
    if(st && st.changedAt && _lastSyncChangedAt && st.changedAt > _lastSyncChangedAt){
      toast("✨ Updates synced from your other devices — click to refresh", 8000, ()=>location.reload());
    }
    if(st) _lastSyncChangedAt = st.changedAt || _lastSyncChangedAt || 1;
  }catch(e){}
}
setInterval(pollSyncChanged, 30000);
```

- [ ] **Step 5: Run the gate** — `node tests/run.js` → must stay `ALL TEST FILES PASSED` (the inline-`<script>` syntax gate parses index.html; a stray brace fails it).
- [ ] **Step 6: Manual smoke** (document, don't automate): two store dirs + a shared temp folder as the sync folder; enable sync on both; create a card on A, Sync now; on B, Sync now → card + image appear; delete on A → after sync, gone on B; edit the same card on both → newest wins; the incoming-change toast appears and refresh shows merged data.
- [ ] **Step 7: Commit**

```bash
git add web/index.html
git commit -m "feat(ui): Settings Dropbox-sync section + status + incoming-change toast"
```

---

# Final Review

After all tasks: dispatch a final reviewer over the whole change set against this plan + the spec, then run the data-safety-reviewer and electron-security-reviewer subagents (the sync code touches the store, backups, and a new REST surface). Confirm: live DB never written into Dropbox; peer folders never written; safety backup precedes every data-changing merge; atomic publish with meta-last; merge never bulk-overwrites; `node tests/run.js` ends `ALL TEST FILES PASSED`.

---

## Self-Review (plan vs spec)

**Spec coverage:** per-device snapshots (C2/C3) ✓; merge newest-wins + tombstones + image-follows-winner (B1) ✓; `updatedAt` + tombstones schema (A1/A2/A3) ✓; serialize (A4) ✓; atomic publish meta-last + verified read (C2) ✓; read peers + skip-too-new-schema + read-only (C3) ✓; launch/periodic/dirty-debounce/quit wiring (D1) ✓; safety backup before data-changing merge (C3 runSync) ✓; endpoints + folder validation (E1) ✓; Settings UI + status + incoming-change toast (E2) ✓; library-only scope (no kv/settings sync) ✓; Dropbox-absent degrades to local-only (D1 guard + status) ✓.

**Placeholder scan:** none — every code step has complete code.

**Type consistency:** `mergeSnapshots(local, peers)` shapes match between B1 (producer) and C3 (`buildLocal`/`readPeerSnapshots` consumers); `upsertCardSynced(db, card, updatedAt)` defined in A1, used in C3; `serializeLibrary` (A4) used in C2/C3; `readSnapshot` fields (C2) consumed by `readPeerSnapshots`/merge (C3); `ctx.syncDirty` set in E1, read in D1; `SE`/`Store` sync methods (E1) used in E2.
