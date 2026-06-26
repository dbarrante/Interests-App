# Interests App — Formal Desktop App (Data Centralization) Design

**Date:** 2026-06-26
**Status:** Approved (design); ready for implementation planning
**Topic:** Move the Interests App off browser-bound storage into a formal Electron desktop app with a durable, browser-independent local data store, while keeping the existing UI and the Chrome capture extension.

---

## Goal

Give the Interests App a real home: a standalone Windows program whose data (cards + saved clips + settings) lives in a local **SQLite** database and whose pictures live as ordinary **image files on disk** — independent of any browser, immune to storage eviction, and free of the File System Access API that Brave blocks. The app's look and features stay the same. The existing capture extension keeps working with only its delivery step changed.

This is the "formalization" phase that follows the resilience roadmap (Pillar 1 data durability, Pillar 2 scale/render). It directly resolves the failure modes those pillars patched around: per-browser data silos, File System Access dependence, browser eviction, and the ~512 MB single-string ceiling.

## Decisions (locked with the user, 2026-06-26)

| Decision | Choice | Implication |
|---|---|---|
| **Scope of v1** | Durable home, same app | Minimal change; identical UI/features; lowest risk. No redesign. |
| **Capture** | Keep the Chrome extension | App exposes a localhost endpoint; capture *engine* untouched, delivery switched to HTTP. |
| **Devices** | Single machine in v1; **Dropbox snapshot sync in v2** | v1: one local store + file backups to Dropbox. v2 adds multi-machine sync (Approach A) — see Roadmap. |
| **Audience** | Share with a few people | Need a packaged Windows installer (electron-builder). No code-signing/auto-update in v1. |
| **Framework** | Electron | All-JavaScript (matches the existing codebase), trivial localhost server, mature installer tooling. |
| **Live store location** | App install directory (`<install>\data\`), **relocatable in Settings** | Requires a **per-user** install so the directory is writable; a pointer in `%APPDATA%` records the real location and survives reinstalls. |
| **Installer** | **Formalized assisted setup wizard** (electron-builder NSIS, `oneClick:false`) | Welcome → choose install folder → shortcuts → Finish; per-user (no admin); preserves the `data\` library across updates/uninstall. |

## Roadmap split: v1 vs v2

**v1 (this spec):** the durable desktop app + migration — same app, browser-independent local store, shareable installer. Build and ship this first.

**v2 — Planned additions** (deferred; approaches chosen 2026-06-26; each gets its own follow-up spec/plan after v1 works). v1's file-based image store + small SQLite DB are deliberately **sync-ready** so these layer on cleanly:
- **Multi-machine Dropbox sync — Approach A (snapshot sync):** the live DB stays **local** per machine; the `images/` folder syncs via Dropbox (write-once, conflict-free); the small DB **auto-exports** to Dropbox on change and **re-imports** on launch, guarded by a one-machine-at-a-time lock/heartbeat. No live SQLite file in Dropbox; offline-friendly; no server.
- **Instagram import:** a new import source parallel to the existing Facebook/Pinterest/YouTube importers (source = the user's Instagram data-download export).
- **Scheduled extraction from social saved lists (manual + optional daily; bounded & stoppable):** runs inside the **extension** (the only logged-in context); an on-demand button plus an optional once-a-day run that is capped per run, rate-limited, and has a visible **Stop**. Best-effort given platform rate limits/ToS.
- **"Save to Interests" in the post ⋯ menu (FB-Purity-style):** the extension injects a menu item into the native post overflow menu on Facebook/Instagram/Pinterest, alongside the existing capture engine.

## Non-Goals (not planned)

- **In-app capture** (replacing the extension with an in-app browser view).
- **Cloud hosting** as the primary store.
- **Auto-update** and **code-signing** (paid certificate).
- Any **UI/UX redesign**.

---

## Architecture

Three parts, one source of truth.

```
   Chrome (user logged in)                Interests App (Electron)
   ┌───────────────────────┐             ┌──────────────────────────────┐
   │ Capture extension      │             │  App window                   │
   │ • FB/IG/Pinterest       │             │  (today's index.html UI)      │
   │   engine — UNCHANGED    │             │        │ localhost HTTP        │
   │ • delivers capture ─────┼──HTTP──────►│        ▼                       │
   └───────────────────────┘             │   CORE SERVICE (Node)          │
                                         │   • Express API @ :3456         │
                                         │   • SQLite (cards/saved/kv)     │
                                         │   • image files (images/<id>)   │
                                         │   • backup + restore engine     │
                                         └───────────────┬────────────────┘
                                                         ▼
                              Local canonical store:  Documents\Interests App\
                              ├─ interests.db
                              └─ images\<id>.jpg
                              Backups (copied):  Dropbox\Interests App\backups\<date>\
```

1. **Core service** — a Node program running inside the Electron main process. Owns all data, serves the web UI and a small REST API on `http://localhost:3456`. Single source of truth.
2. **App window** — the existing `index.html` app, its storage layer repointed from browser storage to the Core service. Unchanged look and feel.
3. **Capture extension** — runs in Chrome where the user is logged into the social sites. Capture engine unchanged; delivery and polling switch from a shared browser tab's `localStorage` to HTTP calls against the Core service.

### Where data lives

- **Canonical (live) store:** by default a **`data\` subfolder of the app's install directory** (`<install>\data\` → `interests.db` + `images\`). Because the install is **per-user** (`%LOCALAPPDATA%\Programs\Interests App\`), this folder is writable without admin elevation. The store is **relocatable from Settings** (see "Moving the data store"). Deliberately **not** inside Dropbox, because Dropbox syncing a database file the app holds open can corrupt it or create `.conflicted` copies.
- **Store-location pointer:** the *path* to the live store is recorded in a tiny config at `%APPDATA%\Interests App\config.json`, kept **outside** the install directory so it survives reinstalls/updates and so the app always knows where the data is — even after it has been moved.
- **Backups:** dated snapshots copied **into** `Dropbox\Interests App\backups\<date>\` (safe — written once, then closed). Dropbox version history is a free extra layer.

### Moving the data store (Settings → Data location)

Settings shows the current store path with a **"Move…"** action: pick a new folder → the app copies `interests.db` + `images\` to the target, **verifies counts**, updates the `%APPDATA%` pointer, then reopens from the new location and releases the old one. Safe-by-construction — the old copy is left intact until the move is verified, so an interrupted move never loses data.

---

## Components & responsibilities

Each unit has one clear job and a defined interface.

| File / unit | Responsibility |
|---|---|
| `main.js` | Electron main process: start Core service, open the window, system tray, lifecycle, port handling. |
| `core/config.js` | Read/write the store-location pointer (`%APPDATA%\Interests App\config.json`); resolve the live-store path on startup; default to `<install>\data\` on first run. |
| `build/installer.nsh` | Custom NSIS include: assisted-wizard tweaks, **exclude `data\` from removal on update**, and uninstaller "also delete your library?" prompt (default No). |
| `core/server.js` | Express app on `:3456`: serves the web UI + the REST API (storage, capture bridge, backup). |
| `core/db.js` | SQLite open/migrate + CRUD for `cards`, `saved`, `kv`, `fp`. Opens in WAL mode; integrity check on start. |
| `core/images.js` | Read/write/delete image files in `images/`; resolve a card id → file path; report counts. |
| `core/backup.js` | Manual + scheduled backup (copy db + changed images to Dropbox), rotate (keep 3), verify counts before rotating; restore (safety-snapshot then swap in). |
| `core/importer.js` | One-time migration: read a legacy backup folder (`data.json` + `img-*.json` shards) → write rows + image files; verify counts. |
| `preload.js` | Minimal contextBridge for app-level native needs (e.g. pick a folder via OS dialog, open external links). Data access goes over HTTP, not preload. |
| `web/` | The existing `index.html` app + a new `web/storage.js` adapter. |
| `web/storage.js` | Thin adapter that presents the app's **existing** data interface but talks to the Core REST API instead of `localStorage`/IndexedDB/File System Access. |
| `extension/bridge.js`, `extension/background.js` | Capture **delivery** switched to HTTP against `:3456`. Capture **engine** (`capture-core.js`, `capture-configs.js`) untouched. |

---

## Data model

### SQLite (`interests.db`)

- **`cards`** — one row per imported item:
  `id TEXT PRIMARY KEY`, `url TEXT`, `platform TEXT`, `cat TEXT`, `ts INTEGER`, `img_file TEXT` (filename in `images/`, or NULL), `img_url TEXT` (for http-hosted images kept as URLs), `data TEXT` (JSON of the remaining card fields — title, desc, tags, sdate, pt, captured, lastResult, blocked, edited, liked, …). Indexed on `platform`, `cat`, `ts`, `url`.
- **`saved`** — one row per saved clip: same pattern (`id`, `url`, `category`, `clipped`, `img_file`/`img_url`, `data` JSON for title/benefit/source/tags/sdate).
- **`kv`** — `key TEXT PRIMARY KEY, value TEXT` for the settings object (`ia_settings`) and the small/odds-and-ends lists currently in `localStorage` (`ia_feed`, `ia_likes`, `ia_hidden`, `ia_clicks`, `ia_shown`, `ia_spool`, view/tab/filter state, health, migration flags). Settings live here under key `ia_settings` — no separate settings table.

Per-row tables for `cards`/`saved` (rather than one big JSON blob) avoid rewriting the whole list on every change and leave room for future dedup/sync. The **storage adapter presents the same array shapes** to the UI, so the app's rendering code is unchanged.

### Image files (`images/`)

- One file per picture: `images/<cardId>.jpg`. The card row's `img_file` points to it.
- Replaces IndexedDB `ia_img/imgs`. Permanently removes the ~512 MB single-string limit and browser eviction.
- The card image reference the UI uses today (`idb:<id>`) resolves through the adapter to `GET /api/img/:id`, which streams the file.

### Image fingerprints

- The placeholder-detection fingerprint map (today's IndexedDB `ia_fp`) moves to a `fingerprints` row set (a `kv`-style table `fp(id, fp)`), preserving `fbPlaceholderGroups` behavior without loading image bytes.

---

## Local REST API (`http://localhost:3456`)

Storage (consumed by the app's `web/storage.js`):
- `GET /api/kv/:key` · `PUT /api/kv/:key` — small lists/state and settings.
- `GET /api/cards` · `PUT /api/cards` (bulk replace in a transaction) · `PATCH /api/cards/:id` · `DELETE /api/cards/:id`.
- `GET /api/saved` · `PUT /api/saved` · `PATCH /api/saved/:id` · `DELETE /api/saved/:id`.
- `GET /api/img/:id` (stream file) · `PUT /api/img/:id` (write file, body = image bytes/data URL) · `DELETE /api/img/:id`.

Capture bridge (consumed by the extension):
- `GET /api/capture-request` — next single capture request (replaces polling `ia_capture_request`).
- `GET /api/batch-state` / `POST /api/batch-progress` — batch driver state (replaces `ia_batch_*`).
- `POST /api/captures` — deliver a capture result (same capture-object shape as today: `{url, id, screenshot|ogImage, title, desc, capsrc, ok, blocked, dead, force, clip, …}`). The service writes the image file + upserts the card.

Backup/restore (consumed by the app UI):
- `POST /api/backup` (manual) · backup status in `GET /api/health`.
- `GET /api/backups` (list) · `POST /api/restore` (by name).

Data location (consumed by Settings):
- `GET /api/store-location` (current path + counts) · `POST /api/store-location/move` (target path → copy, verify, repoint, reopen).

CORS: the service allows the `chrome-extension://<id>` origin and `localhost` for these endpoints.

---

## Extension bridge change

- **Unchanged:** the capture engine — `capture-core.js`, `capture-configs.js`, and all FB/IG/Pinterest logic (raw-HTML og-image, render-in-a-focused-tab, never-crop-a-spinner, dialog scoping, dead-post detection, retry timing).
- **Changed:** `bridge.js` / `background.js` delivery:
  - Deliver a capture: `POST http://localhost:3456/api/captures` (was: write to a localhost tab's `ia_captures`).
  - Poll for work: `GET /api/capture-request` and `GET /api/batch-state` (was: read `ia_capture_request`/`ia_batch_state` from a tab).
  - Keep the existing local **queue fallback** (`chrome.storage.local`) so captures taken while the app is closed are delivered when the service is next reachable.
- **Result:** more robust than today — delivery no longer depends on an app tab being open/focused in Chrome.
- Capturing still requires Chrome + the extension (logged-in sessions). Viewing/owning the library is the Electron app.

---

## Migration (one-time, zero-risk)

Source: an existing **legacy backup folder** in Dropbox (`interests-backup-<date>/` = `data.json` + `img-*.json` shards) — it already contains everything.

1. User clicks **"Back up now" in Chrome** (where the folder backup works) to capture the latest state.
2. `core/importer.js` reads `data.json` → maps `ia_imported`→`cards`, `ia_saved`→`saved`, `ia_settings` and the remaining `ia_*` keys→`kv`.
3. Each `img-*.json` shard is unpacked: every `id → dataURL` is decoded and written to `images/<id>.jpg`; the matching card's `img_file` is set.
4. **Verify counts** (imported / saved / images) and report (e.g. "5,500 cards, 18 saved, 4,303 images — all present"); list any card whose image is missing.
5. **Idempotent & safe:** the importer only *reads* the backup; the original Chrome data is never touched. Re-running rebuilds the store. Chrome remains the safety net until the user confirms the new app looks right.

---

## Backups & restore (in the new app)

- **Triggers:** manual **"Back up now"** + a **scheduled** backup (once/day on open, gated like today's `maybeAutoBackup`).
- **What:** copy `interests.db` + **new/changed** image files into `Dropbox\Interests App\backups\<date>\`. Incremental image copy keeps it fast at 600 MB+.
- **Rotation:** keep last 3; **verify counts (rows + image files) before** deleting any older backup (never delete a good backup if the new one is incomplete — the sharded-backup lesson).
- **Restore:** pick a dated backup → take a safety snapshot of current data → swap in. Mirrors today's restore semantics.
- **No File System Access API** anywhere — the Brave incompatibility and the "storage persistence not granted" warning disappear (no browser involved).

---

## Error handling & safety

- **Port 3456 busy / service fails to start** → detect, fall back to an alternate port, surface a clear message (incl. what's holding the port).
- **SQLite integrity** → WAL mode + `PRAGMA integrity_check` on start; safety snapshot before destructive ops (dedup/groom), matching today's `snapshotBeforeDestructive`.
- **Disk full mid-backup** → verify-before-rotate guarantees good backups survive.
- **Missing image file for a card** → UI shows a placeholder (graceful degradation as today); card is re-pullable.
- **Migration shortfall** → exact-count verification; safe to re-run; original backup untouched.
- **Extension can't reach the service** → local queue holds captures and delivers when the service returns.
- **Store folder missing/moved** (e.g. an update removed the install-dir data, or the pointer resolves to nothing) → on launch the app detects an absent/empty store and offers **Restore from a Dropbox backup** or **Locate an existing store folder**, rather than silently starting empty.

---

## Testing

Reuse the existing `tests/` Node harness (syntax gate + pure-logic units), extended:
- **Importer** unit tests: legacy backup JSON → expected `cards`/`saved` rows + image files; count verification.
- **Backup** unit tests: rotation (`pickBackupsToDelete` analog), verify-before-rotate, incremental image selection.
- **Storage adapter** unit tests: request/URL building and response mapping (UI-shape in ↔ API out).
- **Migration integration test:** a tiny synthetic backup folder → run importer → assert rows + files + counts.
- **Service API tests:** spin Express in-process; exercise `kv`, `img`, `captures`, `backup` endpoints.
- **Manual smoke checklist** (user): install → migrate → see library → capture one post via extension → backup → restore round-trip.
- Built via the **subagent-driven workflow** (per-task spec + quality review, plus a final adversarial review).

---

## Distribution

- **electron-builder NSIS, assisted setup wizard** (`oneClick: false`): Welcome → optional license → **choose install directory** (`allowToChangeInstallationDirectory: true`) → desktop + Start-menu shortcuts → Finish (with launch option). Bundles Node + SQLite so recipients install nothing else.
- **Per-user install** (`perMachine: false` → `%LOCALAPPDATA%\Programs\Interests App\`): no admin prompt, and the install directory is writable for the live `data\` store.
- **Preserve the library across updates/uninstall:** a custom `build/installer.nsh` excludes the `data\` subfolder from removal during an update, and the **uninstaller prompts** "Also delete your saved library?" (default **No**). Combined with the `%APPDATA%` pointer and the Dropbox backups, the library is protected even through a reinstall.
- **No code-signing in v1:** Windows SmartScreen shows a one-time "unknown publisher" prompt (More info → Run anyway). Document this for the few recipients. Signing is a later add-on if distribution widens.
- **No auto-update in v1:** updates are a new installer sent manually.

---

## What changes for the user

- Open **"Interests App"** from the Start menu — a real program window, not a browser tab.
- **Capturing** still uses Chrome + the extension (logged into socials), exactly as today; captures flow into the app automatically.
- The library is **local, browser-independent, and auto-backed-up to Dropbox** — no eviction, no Brave problem, no 512 MB crashes.
- Brave (or any browser) can be the everyday browser; it's no longer tied to the app.

---

## Suggested implementation phases (for the plan)

1. **Core service skeleton** — Electron shell + `core/config.js` (resolve/persist the store path, default `<install>\data\`) + Express on :3456 serving the current `web/` UI unchanged (still using browser storage), proving the window + server + extension reach.
2. **Data layer** — `db.js` (schema/migrations) + `images.js` + storage REST endpoints + unit tests.
3. **Storage adapter** — `web/storage.js`; repoint the app's reads/writes; image references resolve via `/api/img`.
4. **Importer** — migrate a legacy backup folder; verify; integration test.
5. **Capture bridge** — switch extension delivery/polling to HTTP; keep the queue fallback.
6. **Backup/restore + data-location move** — scheduled + manual backup; rotation; verify; restore; Settings → Move store (copy/verify/repoint).
7. **Packaging & setup wizard** — electron-builder assisted NSIS (`oneClick:false`, choose-dir, shortcuts, per-user) + `build/installer.nsh` (preserve `data\` on update, uninstall prompt); smoke checklist.
8. **Final adversarial review** + user verification pass.

## Open assumptions

- Live store default = `<install>\data\` (per-user install at `%LOCALAPPDATA%\Programs\Interests App\`), relocatable in Settings; path pointer in `%APPDATA%\Interests App\config.json`. Backups to `Dropbox\Interests App\backups\` (confirmed).
- Port stays **3456** to match the extension's existing expectation; alternate-port fallback handles conflicts.
- The legacy backup folder is the migration source of record (not a live IndexedDB export).
