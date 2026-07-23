---
name: project-conventions
description: House rules and data-safety invariants for the Interests App. Background knowledge for any agent working in this repo — read before editing store, backup, UI, or extension code.
user-invocable: false
---

# Interests App — conventions & invariants

Read this before changing code here. These are the rules that keep the project safe and consistent.

## Data safety (hard rules — this project has lost data before)
- **Never lose user data.** Verify before you delete: backups verify counts before rotating (keep ≥3); destructive ops (dedup, groom, restore, store-move) take a safety snapshot first; the importer is **read-only** on its source; store-move keeps the old copy until the new one verifies.
- **Never commit personal data.** These are gitignored and must never be added: `saves.json`, `*-import.json`, `facebook-saves.txt`, `*.zip`, `interests-backup-*`, `interests-snapshot-*`, `_recovery/`, `data/`. (A PreToolUse hook also blocks this.)
- Images are files on disk (`data/images/<id>.jpg`); the DB stores a pointer, never the bytes. Never inline thousands of base64 images into one string — that hit JS's ~512 MB string limit and crashed render and backup before.

## Architecture (v1 target)
- Electron shell + a bundled Node/Express **Core service** on `localhost:3456` + SQLite via Node's built-in **`node:sqlite`** (`DatabaseSync`) for `cards`/`saved`/`kv`/`fp` + image files. The existing single-file UI (`web/index.html`) talks to the service through `web/storage.js`. The Chrome capture extension's engine is untouched; only its delivery is HTTP. See `docs/superpowers/specs/2026-06-26-interests-formal-app-design.md`.
- Live store defaults to `<install>\data\` (relocatable in Settings; pointer in `%APPDATA%`). Backups go to `Dropbox\Interests App\backups\`.

## Code & test conventions
- Backend code under `core/` is CommonJS, directly `require()`-able from tests.
- Tests are **plain Node `assert` scripts** (no framework), run via `node tests/<name>.test.js`; `node tests/run.js` runs the syntax gate + all `*.test.js`. HTTP is tested by mounting `createServer()` on port 0 with global `fetch`; pure logic by requiring the module.
- The single-file UI must keep parsing — every inline `<script>` passes `node tests/syntax-check.js`.
- The DB uses Node's built-in **`node:sqlite`** (`DatabaseSync`) — **no native module, no `electron-rebuild`**; it works in both system Node and Electron's runtime. Pragmas via `db.exec`; transactions via explicit `BEGIN`/`COMMIT`/`ROLLBACK` (no `.transaction()` helper).

## Environment quirks
- The repo lives in a **Dropbox** folder: retry git on intermittent `.git` lock errors; CRLF/LF warnings on commit are expected and harmless.
- Keep the GitHub repo **private**.
- End commit messages with the standard `Co-Authored-By: Codex Opus 4.8 <noreply@anthropic.com>` trailer.

## Review gates
- After store/backup/import/restore changes, use the **data-safety-reviewer** agent.
- After Electron/server/IPC/extension-bridge changes, use the **electron-security-reviewer** agent.
