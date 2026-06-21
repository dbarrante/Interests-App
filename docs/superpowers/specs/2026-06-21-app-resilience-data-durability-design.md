# Design: App resilience — Data durability (Pillar 1)

Date: 2026-06-21
App: Interests App (`index.html`, single-file vanilla web app; no backend; state in `localStorage` under `ia_*`; card images in IndexedDB `ia_img`/`imgs` via `idb:<id>` refs; a connected folder handle in IndexedDB `ia_fs`/`kv` key `"dir"`).

This is **Pillar 1 of a 4-pillar resilience effort** (durability → scale/render → tests → diagnostics). Only Pillar 1 is specified here; the others are a sequenced roadmap at the end and get their own spec/plan later.

---

## Goal

Make the user's ~5,500-card archive (incl. ~4,300 image blobs) effectively un-loseable, without adding a backend or leaving the single-file/local model. Two recent "data gone" scares were actually a render crash (data was intact), but they exposed the real exposure: **the data lives only in one browser**, IndexedDB is **evictable**, and the existing backup is weak (download-only, every-N-days, on load, no rotation, no verification, manual restore).

Success criteria:
- A full, image-bearing backup is written **automatically, daily, to the connected (Dropbox-synced) folder**, keeping the **last 3**, and **verified** after each write.
- The user is **warned loudly** when durability is at risk (folder disconnected, persistence not granted, storage near full).
- Recovery is **one click** ("Restore latest backup") plus a pick-list, in addition to the existing file-picker.
- No regressions to the existing `saves.json` sync or manual backup/restore.

---

## Current state (what already exists — reuse, don't rebuild)

- `collectBackup()` (index.html ~823) → `{_app,_version:2,_exported,_counts:{imported,saved,likes,images},keys,images}` where `keys` = all non-skipped `ia_*` localStorage strings and `images` = `await idbAllImgs()`. **This is the full restore format.**
- `exportData()` (~840) → `collectBackup()` → `downloadJSON()` to the browser **Downloads** folder; sets `ia_lastbackup`. Bound to **Ctrl+Shift+B**.
- `maybeAutoBackup()` (~853) → if `S.autoBackup` (days) elapsed since `ia_lastbackup`, calls `exportData()` (download). Runs once, from `initImageStore().then(...)` on load (~3619).
- `restoreData(ev)` (~861) → file-picker restore: validates JSON+`keys`, confirms, **downloads a safety copy** (`collectBackup()`), wipes `ia_*`, writes keys back verbatim, **restores images into IndexedDB** (`idbPutImg` per id), reloads. **Restore is already complete and correct** — it just lacks a folder entry point.
- File System Access bridge: `dirHandle` (~3113), `connectFolder()` (~3120, `showDirectoryPicker` → persist handle in `ia_fs`/`kv` `"dir"`), `restoreFolder()` (~3130, re-acquires the handle on load or shows a "Reconnect" banner if permission lapsed), `writeSavesFile()` (~3153, debounced 400 ms, writes **refs-only** `saves.json` — `saved/hidden/clicks/likes/imported` + settings, **no images** — to `dirHandle`).
- `navigator.storage.persist()` is requested once on load (~593) but its result is ignored.
- Settings → "Backup & restore": auto-backup interval dropdown (`S.autoBackup`, default `0`/off), backup/restore buttons, `#backupInfo`, `#fsStatus`.

**Gaps:** (1) the auto-synced file has **no images** → not a restore point; (2) full backups only go to Downloads, never rotated/verified; (3) a lapsed folder permission silently stops syncing; (4) `persist()`/quota results are ignored; (5) no folder-based or one-click restore; (6) bulk-destructive ops have no pre-op snapshot (except restore, which downloads one).

---

## Scope (this spec)

Three components, all in `index.html` (no extension changes, no backend):

### Component 1 — Backup engine (automatic, rotated, verified, to the connected folder)

New constant: `const BACKUP_KEEP = 3;`

New helpers:
- `async folderReady()` → `!!dirHandle && (await dirHandle.queryPermission({mode:"readwrite"})) === "granted"`. **Single gate** for every folder read/write below (avoids ad-hoc permission checks).
- `async writeFileToFolder(name, text)` → guarded by `folderReady()`; `dirHandle.getFileHandle(name,{create:true})` → `createWritable()` → `write(text)` → `close()`. Returns `true`/`false` (false on no handle/permission or error). Reuses the `writeSavesFile` pattern.
- `pickBackupsToDelete(names, keep)` → **pure function**: given filenames matching the daily pattern, return the names to delete (all but the newest `keep`, sorted by the embedded date desc). Pure → unit-testable in Node.
- `async rotateBackups(keep = BACKUP_KEEP)` → enumerate `dirHandle.values()`, collect names matching **exactly** `/^interests-backup-\d{4}-\d{2}-\d{2}\.json$/` (so it never touches `saves.json`, `interests-snapshot-*.json`, `*-before-restore-*`, or unrelated files), compute `pickBackupsToDelete`, `dirHandle.removeEntry(name)` each.
- `async verifyBackup(name, expectedCounts)` → re-open the just-written file (`getFileHandle` → `getFile` → `text` → `JSON.parse`), confirm `_counts.imported/saved/images` equal `expectedCounts`. Returns `true`/`false`. (Guards against a truncated/partial write before we rotate away older good backups.)

Rework `maybeAutoBackup()`:
1. `days = +S.autoBackup`. If `!days`, return (auto-backup explicitly off stays a real choice). Else if `Date.now() - ia_lastbackup < days*86400000`, return. (The **daily default** is applied when a folder is connected — step 5 — not by coercing `0`.)
2. `const data = await collectBackup(); const name = "interests-backup-"+new Date().toISOString().slice(0,10)+".json";` (one file per calendar day; same-day re-run overwrites that day's file).
3. **If a folder is connected** (`dirHandle` + permission granted): `writeFileToFolder(name, JSON.stringify(data))` → if ok and `verifyBackup(name, data._counts)` → `rotateBackups()`, set `ia_lastbackup`, record `ia_backup_last` (below), toast "Auto-backup saved + verified". If write/verify fails → **do not** set `ia_lastbackup` (retry next cycle), **do not** rotate, warn.
4. **If not connected**: fall back to the current `downloadJSON` behavior, set `ia_lastbackup`, and nudge: "Auto-backup downloaded — connect a folder (Settings) for automatic, rotated, offsite backups."
5. On `connectFolder()` success, if `S.autoBackup === 0`, set it to `1` (daily) and persist — so connecting a folder turns durability on by default.

Scheduling: keep the on-load call, **and** add `setInterval(maybeAutoBackup, 6*3600*1000)` so a long-open session still backs up across a day boundary.

### Component 2 — Storage health + safety net

New `async storageHealthCheck()` (called on load, after `initImageStore`):
- `const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null;` if `false`, `await navigator.storage.persist()`; record the final state.
- `const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;` compute usage ratio.
- Folder state: connected? permission granted? (from `dirHandle` + `queryPermission`).
- Write a `ia_health` summary `{persisted, usage, quota, folder:"connected"|"lapsed"|"none", lastBackup, ts}` and render it in Settings → Backup & restore (a "Durability" status block: persistence on/off, storage used/quota, folder status, last verified backup date + counts).
- **Critical banner** (top of app, reuse the `.banner` style) ONLY when durability is genuinely at risk: folder disconnected/lapsed **or** (persistence not granted **and** last full backup older than the interval). The existing "Reconnect saves.json" banner stays; this adds an explicit "⚠ Automatic backups are paused — reconnect your folder" when applicable.

Pre-destructive snapshot: before the **bulk-destructive** paths — `applyDupeRemoval`, `groomNoLink`/`groomDupes`, and the manual `clearFbPlaceholders` — if a folder is connected, write a single rolling `interests-snapshot-latest.json` (refs-only, same shape as `saves.json`) via `writeFileToFolder` first, so the immediately-pre-op card list is always recoverable. (`applyRestore` is excluded — it already takes its own full safety copy. Cheap; images are covered by the daily full backup. These ops don't delete a kept card's image — dedupe only deletes true-duplicate orphans whose image survives on the kept card.)

### Component 3 — One-click recovery

Refactor: extract the restore core from `restoreData(ev)` into `async applyRestore(data, {sourceLabel})` (validate `keys`; confirm with date+counts; safety copy via `collectBackup()` — to the folder if connected, else download; wipe `ia_*`; write keys; restore images; reload). `restoreData(ev)` (file picker) parses the file then calls `applyRestore`.

New:
- `async listFolderBackups()` → enumerate `dirHandle.values()` for `interests-backup-*.json`, return `[{name, date}]` sorted desc (parse the date from the name only — **don't** read 300 MB files just to list).
- `async restoreLatest()` (Settings button "↩ Restore latest backup") → `listFolderBackups()[0]` → read+parse that one file → `applyRestore(data, {sourceLabel:name})`. If no folder/none found, prompt to use the file picker.
- A "Restore from backup…" affordance that shows the `listFolderBackups()` list (name + date) to pick an older one, plus the existing file-picker as fallback.

---

## Data / keys / settings

- `ia_lastbackup` (existing) — ms timestamp of the last **successful** full backup (folder or download).
- `ia_backup_last` (new) — `{ts, counts, verified:boolean, where:"folder"|"download", name}` for the Settings health display.
- `ia_health` (new) — last `storageHealthCheck()` summary.
- `S.autoBackup` (existing) — interval in days; default becomes `1` (daily) once a folder is connected.
- `BACKUP_KEEP = 3` (new constant).
- Daily backup filename: `interests-backup-YYYY-MM-DD.json` (one/day, rotated to last 3). Pre-op snapshot: `interests-snapshot-latest.json` (rolling, refs-only). Safety-before-restore: existing `interests-backup-before-restore-<ts>.json`.

---

## Error handling & edge cases

- **No folder connected** → download fallback + nudge; durability banner suggests connecting.
- **Folder permission lapsed** → existing reconnect banner + health flag; skip folder writes (don't crash; don't update `ia_lastbackup` so it retries once reconnected).
- **Write or verify fails** (disk full, Dropbox lock, partial write) → keep all older backups, don't rotate, don't advance `ia_lastbackup`, surface a warning.
- **Rotation safety** → only ever `removeEntry` names matching the exact daily regex; never `saves.json`, snapshots, before-restore copies, or unrelated files.
- **Same-day re-runs** → overwrite that day's file (idempotent); multiple tabs are harmless.
- **Long-open session** → 6 h interval + on-load covers day boundaries.
- **Restore quota failure** → existing toast path retained.
- **Browsers without File System Access API** (non-Chromium) → all folder features no-op gracefully; download + file-picker remain.

---

## Testing

- **Node unit tests (new `tests/` harness)** for pure logic: `pickBackupsToDelete(names, keep)` (keeps newest N by date; handles <N, ties, malformed names), backup filename/date parsing, and `verifyBackup` count-comparison logic (extract the comparison as a pure function). This is the seed of Pillar 3.
- **Inline-script syntax check** formalized as a `tests/` script (the ad-hoc `new Function(block)` check used all session) → run before commit.
- **Manual test plan:** connect a folder → run backup → confirm `interests-backup-<today>.json` written, verified, rotation keeps 3; lapse permission (revoke) → health flag + banner; "Restore latest" → counts + images round-trip; run a dedupe removal → `interests-snapshot-latest.json` written first; non-Chromium browser → folder features hidden/no-op, download still works.

---

## Out of scope / non-goals (this spec)

- Cloud/remote backup or any backend (keeps the private, local, no-backend model).
- Incremental/de-duplicated image backup (the full JSON with keep-3 is simple and sufficient now; revisit if Dropbox space becomes an issue).
- Extension-side backup writing.
- The other three resilience pillars (below).

---

## Roadmap — later pillars (separate spec/plan each)

2. **Scale & render resilience** — apply the Imported lazy-image fix (`attachCardImages` + `<img data-imgid>`) to `cardHTML` (Saved/Feed/Stumble) to remove the latent `RangeError`; generalize the lazy-attach; audit any other large joined strings.
3. **Regression safety (tests)** — grow the `tests/` harness seeded here into coverage of the pure capture/dedup logic (`clipKey`, `normalizeUrl`, `imgFp`, `pickBackupsToDelete`, `normTitle`, `isBadImg`, dedupe grouping) + a pre-commit syntax/smoke gate; consider extracting pure logic into a separate `<script>`-included module to shrink the 3,625-line file.
4. **Runtime robustness + diagnostics** — retry the `_imgCache` load on transient empty-read; surface swallowed `try/catch` errors; a built-in diagnostics panel (the IDB-keys-vs-refs-vs-cache health snippet + capture-version + storage estimate as a button).
