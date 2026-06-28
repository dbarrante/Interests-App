# Interests App — Dropbox Multi-Device Sync (v2 sub-project #2) Design

**Date:** 2026-06-28
**Status:** Approved (design); ready for implementation planning
**Topic:** Let the Interests App share one library across multiple installs (e.g. desktop + laptop) through the user's Dropbox folder, with the live database staying local on each machine and devices merging each other's changes — no server, no data loss, multi-device-friendly.

---

## Goal

Install the app on more than one Windows machine and have them all work against the same library. Each machine keeps its own **local** SQLite database and image files (Dropbox never touches the live store). Each machine **publishes** a snapshot of its library into its **own** Dropbox folder and **merges** the other machines' snapshots into its local store on launch and periodically. Conflicting edits resolve by **newest-wins per item**; deletions are remembered so they don't come back; a safety backup precedes every merge. The snapshot format is plain JSON + image files so a **future iPhone client** can read it.

This is v2 sub-project #2, following the shipped v1 desktop app and v2 #1 (capture & routing). It builds directly on v1's deliberately sync-ready design: file-based images + a small SQLite DB.

## Decisions locked with the user (2026-06-28)

1. **Multi-device, concurrent.** The user wants several devices usable at the same time (and eventually an iPhone version). This **rules out** the originally-sketched single-shared-snapshot + one-machine-at-a-time lock; that would forbid concurrent use. → **per-device snapshots + merge, no lock.**
2. **Catch up on open + background refresh.** Merge in on launch; re-check the other folders every few minutes while open. Near-instant cross-device live sync is explicitly out of scope (not achievable over Dropbox folder sync; would need an always-on server).
3. **Merge, not replace.** Because devices change data independently, sync unions both libraries (newest edit wins per item) rather than letting one machine overwrite the other.
4. **iPhone is a separate future project.** iOS can't share a Dropbox *folder* like desktop; it needs a different transport (Dropbox API or a small cloud service). Out of scope here — but the snapshot **format** is kept portable so a future client can adopt it.
5. **Library-only in v1.** Sync covers cards, saved items, and their images. **Settings stay per-machine** for now (low churn, avoids a fiddly kv-merge edge case). Settings-sync is a later add.

## Non-goals (this sub-project)

- Live, near-real-time cross-device updates (seconds). Out — Dropbox latency + no server.
- A one-machine-at-a-time lock. Dropped in favor of merge.
- Putting the live SQLite DB inside Dropbox. **Forbidden** — an open WAL DB in a synced folder corrupts / spawns `.conflicted` copies.
- Syncing settings / runtime state (capture queue, batch progress, health, device id, port, store path).
- iPhone / iOS transport.
- Content-addressed image storage (a possible future hardening — see Open Questions).

---

## Architecture

Per-device snapshots merged by every device. No central writer, no lock.

```
   Desktop (install A)                Dropbox/Interests App/sync/            Laptop (install B)
   ┌─────────────────────┐           ┌──────────────────────────┐          ┌─────────────────────┐
   │ LOCAL live store     │ publish  │  sync/<A-deviceId>/        │  merge   │ LOCAL live store     │
   │  interests.db (WAL)  │ ───────► │   snapshot.json            │ ───────► │  interests.db (WAL)  │
   │  images/<id>.jpg     │          │   images/<id>.jpg          │          │  images/<id>.jpg     │
   │                      │  merge   │   meta.json (marker)       │ publish  │                      │
   │                      │ ◄─────── │  sync/<B-deviceId>/  ...    │ ◄─────── │                      │
   └─────────────────────┘           └──────────────────────────┘          └─────────────────────┘
        (Dropbox never opens the live store; each device writes ONLY its own sync/<id>/ folder)
                                              │  (same format)
                                              ▼
                                   iPhone client (future, different transport)
```

**Key invariants that make this safe:**

- **Live store is local, always.** `config.getStorePath()` keeps returning a local writable dir; we never point it into Dropbox. (config.js:59-73.)
- **A device writes only its own `sync/<deviceId>/` folder.** Two machines can never write the same file → Dropbox never makes conflicted copies of our data.
- **Peer folders are read-only to us.** We never write, rename, or delete another device's folder (mirrors the importer's read-only-on-source invariant).
- **Publishing is atomic with a completion marker.** A peer mid-Dropbox-sync is never merged until its snapshot is verifiably complete.
- **Merge is upsert-only + explicit tombstone deletes.** The live store is never bulk-overwritten; a safety backup precedes every merge.

---

## Snapshot format (`<syncDir>/<deviceId>/`)

One folder per device. Files written in this order — **images, then `snapshot.json`, then `meta.json` LAST**:

- **`snapshot.json`** — the library data (small; images are NOT inlined):
  ```json
  {
    "schemaVersion": 2,
    "deviceId": "dev_9f3a…",
    "deviceLabel": "Desktop",
    "publishedAt": 1782653743712,
    "cards":  [ { "id": "c_…", "...": "...", "updatedAt": 178… }, … ],
    "saved":  [ { "id": "s_…", "...": "...", "updatedAt": 178… }, … ],
    "fp":     { "c_…": "<fingerprint>", … },
    "tombstones": [ { "id": "c_…", "kind": "card", "deletedAt": 178… }, … ]
  }
  ```
- **`images/<id>.jpg`** — only images new or changed vs. what's already in *this device's* folder (incremental, reusing the size-diff approach of `changedImageIds`).
- **`meta.json`** — written LAST, the completion sentinel:
  ```json
  { "schemaVersion": 2, "deviceId": "dev_9f3a…", "deviceLabel": "Desktop",
    "publishedAt": 1782653743712, "counts": { "cards": 5445, "saved": 18, "images": 4303 } }
  ```
  A reader trusts a peer snapshot only when `meta.json` exists **and** its `counts` match `snapshot.json` (cards/saved) and the image files present. A marker-less or count-mismatched snapshot is treated as still-being-written and skipped this round. `schemaVersion` is the app's current DB-migration version (a defined constant bumped with the MIGRATIONS array — not a hardcoded literal); the `2` shown here is illustrative.

**Atomic write:** each of `snapshot.json` and `meta.json` is written to a `*.tmp` then `fs.renameSync`d into place (atomic on the same volume), so Dropbox never uploads a torn file. `meta.json` rename is the last step.

---

## Schema changes (core/db.js — append to the in-code MIGRATIONS array)

1. **`updatedAt INTEGER` on `cards` and `saved`.** Stamped to `Date.now()` on every `upsertCard`/`upsertSaved`. Backfilled for existing rows: **cards → their existing `ts`**; **saved → migration time** (saved rows have no promoted `ts` column). This is the per-item "last edited" clock that drives newest-wins. (Capture `ts` alone is insufficient — it doesn't move on edit.)
2. **`tombstones` table:** `tombstones(id TEXT, kind TEXT, deletedAt INTEGER, PRIMARY KEY(id, kind))`. On any card/saved deletion, insert/replace a tombstone. Helpers: `addTombstone(db,id,kind)`, `allTombstones(db)->[{id,kind,deletedAt}]`, `pruneTombstones(db, olderThanMs)`.
3. **`serializeLibrary(db) -> {cards, saved, fp, tombstones}`** helper composing `allCards`/`allSaved`/`allFp`/`allTombstones` for the snapshot writer.

Tombstone retention: prune entries older than **90 days** (long enough that all devices have synced). Documented risk: a device offline longer than retention could resurrect a deleted item — acceptable for this single-user, few-device case.

---

## Merge algorithm (pure function — the testable heart)

`core/merge.js` exports a pure function, no DB/fs:

```
mergeSnapshots(local, peers) -> { upserts, deletes, tombstones, imageCopies }

  local = { cards:{id->item}, saved:{id->item}, tombstones:{ "card:id"->deletedAt, … } }
  peers = [ { deviceId, dir, cards:[…], saved:[…], tombstones:[…] }, … ]
```

For each item id (across local + all peers), per kind (card | saved):
1. **Winner = the version with the greatest `updatedAt`.**
2. **Tombstone = the greatest `deletedAt` for that id/kind** (across local + peers).
3. If `tombstone.deletedAt > winner.updatedAt` → the item is **deleted**: emit a delete op + carry the tombstone forward. Else → the item is the **winner**: emit an upsert **only if it differs from the local copy** (avoid no-op writes).
4. **Image op:** if the winner came from a peer and that peer's folder has `images/<id>.jpg`, emit `imageCopies += {id, fromDir}` (copy peer image over local). If the item is deleted, the executor also `delImg`s it.

Output is plain data. The executor (`core/sync.js`) applies it: `upsertCard`/`upsertSaved` for upserts, delete-row + `delImg` for deletes, `addTombstone` for tombstones, `copyFileSync` for image copies. Deterministic, commutative across peers, idempotent (re-running merges nothing new).

**Conflict count:** when a peer's winner overwrites a *locally-edited* item (both changed since they last agreed), increment a "conflicts resolved (newest kept)" counter surfaced in sync status.

---

## Sync timing & triggers (core/sync.js + main.js)

- **On launch** — in `main.js` `app.whenReady()`, **after** `ctx = buildContext(storeDir)` and **before** `startServer(ctx)`:
  1. ensure a same-day local backup exists (`runBackup`) — the safety net;
  2. read all complete peer snapshots, `mergeSnapshots`, apply (upserts/deletes/images upsert into the already-open DB — **no file swap, no reopen** needed, unlike restore);
  3. publish our own snapshot.
  Errors here are caught by the existing try/catch → `dialog.showErrorBox`; sync failures must be **non-fatal** (log + open local-only), NOT hard-quit. (Distinct from a corrupt-store failure, which still hard-fails.)
- **Publish on change (debounced ~10s):** server write routes mark `ctx.syncDirty = true`; a debounce timer in `core/sync.js` publishes when dirty + quiet. Coalesces bursts of captures.
- **Background merge (every ~3 min):** timer re-reads peer folders; if any peer's `meta.publishedAt` advanced, merge + (if it changed local data) signal the renderer.
- **On quit:** `app.on('will-quit')` does a final **synchronous** publish if dirty. **Wiring note:** `ctx` must be hoisted to module scope (next to `mainWindow`/`httpServer`) so `will-quit` can reach it; keep the publish synchronous (all backup/db helpers are sync) since Electron doesn't await `will-quit`.

`ctx` gains: `syncDirty` flag, `syncDir`, `deviceId`, `deviceLabel`, and sync timers — set up once at launch.

---

## UI

### Settings → new "Dropbox sync" section (web/index.html, after "Backup & restore", before the Save button)

Built from the existing `<div class="sec">` shell + `.hint`/`.btn` classes (no new CSS), wired in `renderSettings()`, self-persisting on change (the `autoBackup` convention):

- **Enable Dropbox sync** — checkbox (`#syncToggle`).
- **Sync folder** — auto-detected default `<detectDropboxRoot()>/Interests App/sync/`, shown in a `.hint`; **"Change…"** button using the native picker idiom `(window.ia&&window.ia.pickFolder)||(window.app&&window.app.pickFolder)` (copied from `moveDataLocation`).
- **This device's name** — text input, defaults to `os.hostname()`, editable; labels the folder in status.
- **Status block** (`#syncStatus`, multi-line, built like `renderDurabilityStatus`): *Last synced · This device · Other devices seen (+ their last publish) · Conflicts resolved.*
- **Sync now** — manual trigger button.

### Incoming-change toast (background merge while in use)

A background merge **never reloads the view from under the user**. If it changed local data, show a clickable toast — *"✨ N updates synced from your other devices — click to refresh"* — using the existing `toast(msg, ms, onclick)` with the refresh handler `restore`/import already use. The launch merge needs no toast (it precedes the window).

### Renderer ↔ Core endpoints (core/server.js, in the data-location block; web/storage.js SE + Store)

All auto-protected by the existing origin middleware; folder paths validated with the same `path.isAbsolute` + `path.resolve` guard as `/api/store-location/move`:

- `GET  /api/sync-status` → `{ enabled, folder, deviceLabel, lastSync, peers:[{label,publishedAt}], conflicts, error? }`
- `POST /api/sync/enable` `{ enabled }`
- `POST /api/sync/folder` `{ folder }` (absolute, resolved)
- `POST /api/sync/device-label` `{ label }`
- `POST /api/sync/now` → triggers merge + publish, returns status

`web/storage.js` gains `Store.syncStatus()/setSyncEnabled()/setSyncFolder()/setDeviceLabel()/syncNow()` mirroring `storeLocation`/`moveStore`.

---

## Data-safety invariants & failure modes

- **Live store never bulk-overwritten.** Merge only upserts + deletes-via-newer-tombstone; no `rm -rf images/`, no DB file swap on merge.
- **Safety backup before every merge.** The launch merge ensures a same-day `runBackup` first; the dated-backup rotation already keeps ≥3 and never deletes a good backup for a bad one.
- **Read-only on peer folders.** We never write/rename/delete another device's `sync/<id>/`.
- **Torn / partial peer snapshot** → skipped until `meta.json` present and counts match. Dropbox `(conflicted copy)` files are ignored (we only read canonical names).
- **Dropbox not installed / folder missing** → `detectDropboxRoot()` returns null → sync stays off, app runs local-only, a quiet "Dropbox not found" hint shows. Never an error.
- **Same item edited on two machines** → newest `updatedAt` wins; the losing version persists in that machine's own snapshot + the pre-merge safety backup.
- **Delete vs. edit race** → greatest timestamp wins (later edit un-deletes; later delete beats older edit).
- **Crash mid-publish** → atomic temp+rename leaves the prior snapshot intact; the change publishes next launch.
- **Schema-version mismatch** → a snapshot whose `schemaVersion` is newer than this binary understands is **skipped** with an "update this device" hint, never merged unsafely. Older snapshots merge fine (missing `updatedAt` backfilled to `ts`).
- **WAL correctness** → any time we copy the live `interests.db` (publish path, if file-copy is used for the safety backup) we `PRAGMA wal_checkpoint(TRUNCATE)` first; the JSON snapshot path reads via the open DB and is unaffected.

---

## Reuse map (don't reinvent — from the subsystem exploration)

- `detectDropboxRoot()` / `dropboxBackupDir()` (backup.js:15-40) — locate the real Dropbox root (reads Dropbox `info.json`; handles non-C: installs). Default `syncDir` = `<root>/Interests App/sync`.
- `runBackup` / `changedImageIds` / `verifyBackup` / `backupCountsMatch` (backup.js) — pre-merge safety backup + incremental image diff + completion verification.
- `loadConfig`/`saveConfig` (config.js) read-modify-write for new keys (`syncEnabled`, `syncDir`, `deviceId`, `deviceLabel`) — **always `Object.assign` over `loadConfig()`** (saveConfig writes the whole object).
- `isWritableDir` (config.js) — validate a user-chosen sync folder.
- `getKV/setKV` + `upsertCard/upsertSaved/allCards/allSaved/allFp` (db.js) — sync metadata + serialize/apply primitives.
- `buildContext`/`ctx.reopen` (appctx.js) — the single DB handle; merge upserts go through `ctx.db`.
- `toast` / `renderDurabilityStatus` / `moveDataLocation` picker idiom / origin middleware / `path.isAbsolute`+`resolve` guard — UI + endpoint patterns.

## Files

- **Create** `core/merge.js` — pure `mergeSnapshots` (browser/node neutral, `module.exports` + global, require()-able).
- **Create** `core/sync.js` — orchestrator: device identity, resolve sync dir, `publishSnapshot`, `readPeerSnapshots`, `runMerge` (compose merge + apply), debounce/periodic scheduling, status.
- **Modify** `core/db.js` — `updatedAt` columns + migration + stamping; `tombstones` table + helpers; `serializeLibrary`.
- **Modify** `core/config.js` — sync config key helpers.
- **Modify** `main.js` — hoist `ctx`; launch merge+publish; periodic timer; will-quit publish.
- **Modify** `core/server.js` — sync endpoints + mark-dirty on writes.
- **Modify** `web/storage.js` — SE + Store sync methods.
- **Modify** `web/index.html` — Settings "Dropbox sync" section, `renderSyncStatus`, handlers, incoming-change toast.
- **Tests** `tests/merge.test.js`, `tests/sync-snapshot.test.js`, `tests/sync-readonly.test.js` (+ register in `tests/run.js`).

## Testing strategy

- **`merge.test.js` (pure, no I/O):** newest-wins; tombstone suppresses resurrect; delete-vs-edit by timestamp; identical-item no-op (no upsert emitted); image-follows-winner; empty peer; multi-peer convergence; idempotent re-merge.
- **`sync-snapshot.test.js`:** atomic write (temp+rename); `meta.json`-last completion gating (marker-less / count-mismatched snapshot rejected); round-trip serialize→write→read→apply; incremental image diff.
- **`sync-readonly.test.js`:** a merge run never writes/renames/deletes inside a peer folder (mirrors importer read-only-on-source).
- **Manual smoke:** two local store dirs + a shared temp "Dropbox" folder simulating two devices — a card created on A appears on B after merge; a delete on A removes it from B (no resurrect); an edit conflict resolves newest-wins; images travel; Dropbox-absent path degrades to local-only.
- All via the existing plain-Node `tests/run.js` harness; the inline-`<script>` syntax gate must stay green on `web/index.html`.

## Global constraints (carry verbatim into the plan)

- Repo stays **private**; **never create/edit/`git add` personal-data files** (`saves.json`, `*-import.json`, `interests-backup-*`, `interests-snapshot-*`, `data/`, etc. — gitignored + PreToolUse-guarded).
- **Live SQLite DB stays local** — never placed in Dropbox.
- **Read-only on peer folders**; **safety backup before every merge**; **atomic publish with a completion marker**; **never bulk-overwrite the live store**.
- Engine = Node built-in **`node:sqlite`** (no native deps). Tests = plain-Node `assert` via `tests/run.js`. `core/merge.js` is require()-able like `web/route-capture.js`.

## Open questions / future hardening

- **Settings sync** (whole-blob newest-wins for `ia_settings`/interest profile) — deferred; easy follow-on.
- **Content-addressed image pool** (`<sha256>.jpg`, write-once, shared across devices) — would dedupe images across per-device folders and remove the last theoretical same-id image conflict; larger refactor (touches `putImg` + 3 mint sites + ref format + orphan sweep). Deferred; per-device folders are safe meanwhile.
- **iPhone transport** (Dropbox API or small cloud service) — separate project; this snapshot format is the contract.
