# Interests App — Formal Desktop App (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Before starting, read the "Plan corrections" section below — it is binding and overrides any conflicting step in the phase tasks.**

**Goal:** Turn the Interests App into a formal Electron desktop app with a durable, browser-independent local SQLite + image-file store, keeping the existing UI and the Chrome capture extension.

**Architecture:** An Electron shell runs a bundled Node/Express **Core service** on `localhost:3456`, backed by SQLite (`better-sqlite3`) and image files on disk. The existing single-file UI (`web/index.html`) talks to the service through `web/storage.js`. The capture extension's engine is unchanged and delivers captures over HTTP. The live store defaults to `<install>\data\`; backups go to `Dropbox\Interests App\backups\`. Full design: `docs/superpowers/specs/2026-06-26-interests-formal-app-design.md`.

**Tech Stack:** Electron (≥31), Express, better-sqlite3 (native), electron-builder (NSIS assisted wizard), plain-Node `assert` test harness.

## Global Constraints

Every task implicitly inherits these (copied from the spec/contract):

- **Platform:** Windows. CommonJS only, no TypeScript. New backend code under `core/` as focused modules, each directly `require()`-able from tests.
- **SQLite:** `better-sqlite3` (synchronous, on-disk) — a **native module**. Dev/tests use the Node ABI (`node tests/*.test.js`); packaging rebuilds for Electron's ABI via `@electron/rebuild` (`npm run rebuild`). Do not run `electron-rebuild` until packaging (Phase 7/8).
- **HTTP:** Express. Core service binds `127.0.0.1:3456`; if busy, bind the next free port in `[3456..3465]` and record it. `GET /api/ping` lets the extension probe `[3456..3465]` to find the app.
- **UI:** `index.html` moves to `web/index.html` (Phase 1), served by the Core service; the Electron window loads `http://localhost:<port>/`. Only `web/storage.js` talks to the API.
- **Tests:** plain Node `assert` scripts (no framework), run via `node tests/<name>.test.js`; `node tests/run.js` runs the syntax gate + every `tests/*.test.js`. HTTP tested by mounting `createServer()` on port 0 with global `fetch`; pure logic by `require()`-ing the module. The existing `tests/syntax-check.js` and `tests/durability.test.js` must keep passing.
- **Data safety (non-negotiable):** the importer only READS its source; backups verify counts BEFORE rotating/deleting (keep ≥3); destructive ops (dedup/groom/restore/store-move) take a safety snapshot first; never delete a good backup if the new one is unverified; store-move keeps the old copy until the new one verifies.
- **Personal data** (`saves.json`, `*-import.json`, `*.zip`, `interests-backup-*`, `interests-snapshot-*`, `_recovery/`, `data/`) is gitignored and must never be committed (a PreToolUse hook also blocks this).

## ⚠️ Plan corrections — binding; apply during execution

An adversarial consistency review of the drafted phases found the following. These OVERRIDE the conflicting phase steps. Apply each as you reach the relevant task.

- **[ENGINE — supersedes every `better-sqlite3` reference] Use Node's built-in `node:sqlite` (no native module).** `better-sqlite3` requires a C++ compiler that isn't available on the build machine; we use the built-in `node:sqlite` `DatabaseSync` instead — verified working in both Node v25 and Electron 42 (Node 24), with nothing to compile or rebuild. Apply everywhere:
  - **package.json (Task 1.1)** — exactly this (no `better-sqlite3`, no `@electron/rebuild`, no `rebuild` script):
    ```json
    {
      "name": "interests-app",
      "version": "1.0.0",
      "private": true,
      "main": "main.js",
      "scripts": { "start": "electron .", "test": "node tests/run.js", "dist": "electron-builder" },
      "dependencies": { "express": "^4.21.2" },
      "devDependencies": { "electron": "^42.5.0", "electron-builder": "^25.1.8" }
    }
    ```
  - **No `electron-rebuild` / native-rebuild step anywhere** (Tasks 1.1, 7.x, 8.2): `node:sqlite` is part of the Electron runtime — nothing to compile, rebuild, or bundle for the DB. Delete those steps; `npm install` only fetches `express` (pure JS) + Electron/electron-builder (prebuilt downloads).
  - **`core/db.js` `openDb(storeDir)` (Task 2.1):**
    ```js
    const path = require("path");
    const { DatabaseSync } = require("node:sqlite");
    function openDb(storeDir) {
      const db = new DatabaseSync(path.join(storeDir, "interests.db"));
      db.exec("PRAGMA journal_mode=WAL");
      db.prepare("PRAGMA integrity_check").get(); // returns {integrity_check:'ok'} on a healthy DB
      return db;
    }
    ```
  - **API mapping for all of `core/db.js`** (node:sqlite vs better-sqlite3): `db.prepare(sql).get(...p)/.all(...p)/.run(...p)` are the same (`.run` returns `{ changes, lastInsertRowid }`); use `db.exec(sql)` for DDL/PRAGMA/multi-statement. **There is NO `db.transaction()` helper** — wrap bulk writes (`replaceCards`, `replaceSaved`) as `db.exec("BEGIN"); try { /* upserts */ db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }`. Bind only string/number/null/BigInt/Buffer (convert booleans to 0/1; never pass `undefined`); use positional `?` params; close with `db.close()`.
  - `core/appctx.js`, `core/server.js`, and all tests are unaffected — they go through `core/db.js`.

- **[RUNTIME-CRITICAL] DB wiring:** the phase drafts never make the live `main.js` open a real DB or provide `ctx.reopen`; every data route would crash on `ctx.db === null` even though unit tests pass (they build their own ctx). **Do Task 2.6 (below, inserted after Phase 2)** which adds `core/appctx.js` `buildContext()` and wires it into `main.js`. Phase 1 Task 1.5's placeholder `{db:null,...}` ctx is superseded by Task 2.6.
- **[Phase 5] batch-progress body shape:** `extension/bridge.js` `writeProg()` must POST `{ progress: { done, total, active, ts } }` (wrapped), not a flat body — the server route reads `req.body.progress`. `saveState`/`endBatch` already correctly send `{ state }`.
- **[Phase 3/6] no duplicate Store methods:** `Store.backupNow/listBackups/restore/storeLocation/moveStore/runImport` are defined ONCE, in Phase 3 Task 3.2 (using the shared `jsend`/`SE` helpers). Phase 6 Task 6.9 ADDS ONLY `Store.health`; it must not redefine the others. `tests/storage-adapter.test.js` is CREATED in Phase 6 (not Phase 3 — Phase 3 only creates `tests/storage-url.test.js`).
- **[Phase 4] runImport once:** keep Phase 3 Task 3.2's `Store.runImport`; Task 4.1 only wires the Settings button + handler, it does not re-add the Store method.
- **[Phase 3/5/6] durability test count:** `tests/durability.test.js` has **12** cases before Phase 3 (Phase 2 correctly says "12 passed"); Phase 3 Task 3.3 removes the 4 `lruPush` cases → **8** after Phase 3. Replace every "13" count in Phase 5 Task 5.6 and Phase 6 Task 6.9 with **8** (post-Phase-3 state).
- **[Phase 3] Task 3.3 Step 10:** `index.html` was already moved to `web/index.html` and `_extract.js` already repointed in Phase 1 Task 1.2 — so that path edit is a verify-only no-op. The only real durability break here is the deleted `lruPush`; retire just the 4 `lruPush` cases.
- **[Phase 7] electron-builder version:** use `^25.1.8` (matches Phase 1 Task 1.1) — not `^24.13.3`. Correct the Phase 8 reference to a "postinstall step" to "the `npm run rebuild` step run in Phase 8 Task 8.2" (there is no postinstall hook).
- **[Phase 8] verification gate filenames:** Task 8.1 Step 2 must list the ACTUAL test files, not examples: `config, db, images, server-ping, service-data, service-captures, bridge-port, storage-url, storage-adapter, importer-map, importer-int, importer-api, backup, server-backup-int, storemove-int, build-config, install-doc, durability` (`.test.js` where applicable). Do not abort on the example names.
- **[Phase 3 — data safety] dedup/groom snapshot:** where Phase 3 repoints the dedup (`applyDupeRemoval`) and groom destructive paths to `Store.putCards`/`putSaved`, add a **safety snapshot first** — call `await Store.backupNow()` (or an equivalent snapshot) before the destructive write, matching the spec's "destructive ops take a safety snapshot first" rule.
- **[Phase 3] drainCaptures persistence:** Task 3.7's capture-drain tail must show concrete code, not a description — after processing the drained captures, persist with `if (changed) await Store.putCards(imported);` (and `await Store.putSaved(saved)` if saved changed). Pick the single `pollBatchProgress` body that matches the contract (`GET /api/batch-progress` → read `j.progress`) and delete the alternative.

---


## Phase 1: Project scaffold + Electron shell + Core server skeleton

### Task 1.1: Project scaffold — package.json, .gitignore, tests/run.js

**Files:**
- Create: `package.json`
- Create: `.gitignore` (repo already has one at root — this task REPLACES its contents; verify the existing patterns are preserved)
- Create: `tests/run.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - npm scripts: `start` (`electron .`), `test` (`node tests/run.js`), `dist` (`electron-builder`), `rebuild` (`electron-rebuild -f -w better-sqlite3`).
  - `tests/run.js` — a runner that executes `node tests/syntax-check.js` first, then every `tests/*.test.js`, aggregates pass/fail, prints a summary, and `process.exit(failed ? 1 : 0)`.

Notes for the implementer:
- `better-sqlite3` is a NATIVE module. The dev test run (Task 1.4 onward, later phases) uses the plain Node ABI (`node tests/*.test.js`), so a plain `npm install` is correct for tests. Packaging (`dist`, a later phase) rebuilds for the Electron ABI — that is what the `rebuild` script and `@electron/rebuild` devDependency are for. Do NOT run `electron-rebuild` in this phase; it only matters once `core/db.js` is exercised under Electron.
- Node is v25, npm v11. `electron >= 31`.

- [ ] **Step 1: Read the existing root `.gitignore`** so its current patterns are preserved.

Run:
```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && cat .gitignore
```
Expected output (current contents):
```
saves.json
*.tmp.*
facebook-import.json
pinterest-import.json
youtube-import.json
facebook-saves.txt
*.zip
_recovery/
saves-*.json
```

- [ ] **Step 2: Write `tests/run.js`** (the aggregating runner; no test framework).

```js
// Runs the syntax gate first, then every tests/*.test.js as a child process.
// Each test file prints "<p> passed, <f> failed" and exits non-zero on failure.
// This runner exits non-zero if ANY child exits non-zero.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const testsDir = __dirname;
const node = process.execPath;

function run(file) {
  const r = spawnSync(node, [path.join(testsDir, file)], { stdio: "inherit" });
  return r.status === 0;
}

let ok = true;

console.log("== syntax-check.js ==");
ok = run("syntax-check.js") && ok;

const testFiles = fs
  .readdirSync(testsDir)
  .filter((f) => f.endsWith(".test.js"))
  .sort();

for (const f of testFiles) {
  console.log("== " + f + " ==");
  ok = run(f) && ok;
}

console.log(ok ? "ALL TEST FILES PASSED" : "SOME TEST FILES FAILED");
process.exit(ok ? 0 : 1);
```

- [ ] **Step 3: Write `package.json`.**

```json
{
  "name": "interests-app",
  "version": "1.0.0",
  "description": "Interests App — formal Electron desktop app with a durable local SQLite + image-file store.",
  "private": true,
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "test": "node tests/run.js",
    "rebuild": "electron-rebuild -f -w better-sqlite3",
    "dist": "electron-builder"
  },
  "dependencies": {
    "better-sqlite3": "^11.8.1",
    "express": "^4.21.2"
  },
  "devDependencies": {
    "@electron/rebuild": "^3.7.1",
    "electron": "^33.2.1",
    "electron-builder": "^25.1.8"
  }
}
```

- [ ] **Step 4: Write `.gitignore`** (preserving all existing patterns and adding `node_modules`, `dist`, and `data/`).

```
node_modules/
dist/
data/

saves.json
*.tmp.*
facebook-import.json
pinterest-import.json
youtube-import.json
facebook-saves.txt
*.zip
_recovery/
saves-*.json
```

- [ ] **Step 5: Install dependencies** (downloads `better-sqlite3` prebuilt for Node ABI, Electron, electron-builder).

Run:
```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && npm install
```
Expected: install completes; `node_modules/` exists and contains `electron`, `express`, `better-sqlite3`, `@electron/rebuild`. (Ignored by `.gitignore`.)

- [ ] **Step 6: Verify `tests/run.js` runs the existing tests** (the harness must still pass before any code change).

Run:
```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && node tests/run.js
```
Expected PASS: prints `== syntax-check.js ==`, then `== durability.test.js ==` with all `ok` lines, then `ALL TEST FILES PASSED`. Exit code 0.

- [ ] **Step 7: Commit.**

```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && git add package.json .gitignore tests/run.js && git commit -m "Add project scaffold: package.json, .gitignore, tests/run.js

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 1.2: Move `index.html` to `web/index.html` and repoint the test harness

**Files:**
- Modify (git mv): `index.html` → `web/index.html`
- Modify: `tests/syntax-check.js` (the `readFileSync` path)
- Modify: `tests/_extract.js` (the `readFileSync` path in `loadFns`)

**Interfaces:**
- Consumes: the existing `tests/run.js` (Task 1.1) which runs `syntax-check.js` and `durability.test.js`.
- Produces: `web/index.html` (served as static by `core/server.js` in Task 1.4); the syntax gate and `durability.test.js` keep passing by reading from the new path.

Why the harness must change here: `tests/syntax-check.js` reads `path.join(__dirname, "..", "index.html")`, and `tests/_extract.js` (used by `durability.test.js`) reads the same path. The contract requires both existing tests to KEEP PASSING, so both paths must move to `web/index.html` in the same task as the `git mv`.

- [ ] **Step 1: Move the file with `git mv`** (preserves history; the working dir tracks the move).

Run:
```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && mkdir -p web && git mv index.html web/index.html && git status --short
```
Expected: `R  index.html -> web/index.html` in the status output.

- [ ] **Step 2: Run the harness to SEE IT FAIL** (paths now stale — proves the test depends on the moved file).

Run:
```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && node tests/run.js
```
Expected FAIL: `syntax-check.js` errors with `ENOENT ... index.html` (and/or `durability.test.js` throws from `_extract.js`); `SOME TEST FILES FAILED`; exit code 1.

- [ ] **Step 3: Repoint `tests/syntax-check.js`** to the new path.

Replace the file body's read line. Change:
```js
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
```
to:
```js
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
```

- [ ] **Step 4: Repoint `tests/_extract.js`** (`loadFns` reads the same file).

In `loadFns`, change:
```js
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
```
to:
```js
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
```

- [ ] **Step 5: Run the harness to SEE IT PASS** again.

Run:
```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && node tests/run.js
```
Expected PASS: `syntax-check.js` reports N script block(s), 0 error(s); `durability.test.js` all `ok`; `ALL TEST FILES PASSED`; exit code 0.

- [ ] **Step 6: Commit.**

```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && git add -A && git commit -m "Move index.html to web/ and repoint test harness paths

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 1.3: `core/config.js` — store-path resolution and config persistence

**Files:**
- Create: `core/config.js`
- Create: `tests/config.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks at runtime (pure Node + a soft, optional dependency on Electron's `app` for packaged paths).
- Produces (exact signatures — `module.exports` is an object with these):
  - `appDataDir() -> string` — `%APPDATA%\Interests App`
  - `configPath() -> string` — `appDataDir()/config.json`
  - `loadConfig() -> object` — `{}` if the file is absent or unreadable
  - `saveConfig(obj) -> void` — writes `config.json` (creating `appDataDir()` if needed)
  - `defaultStoreDir() -> string` — packaged: `path.join(path.dirname(app.getPath('exe')),'data')`; dev: `path.resolve('data')`
  - `getStorePath() -> string` — `config.storePath` if set, else `defaultStoreDir()`; **ensures the dir AND `dir/images` exist** before returning
  - `setStorePath(p) -> void` — persists `config.storePath = p` (merging into existing config)

Notes for the implementer:
- This module must be `require()`-able from a plain Node test (no Electron running). Detect Electron lazily: `try { app = require('electron').app } catch {}`; treat "packaged" as `app && app.isPackaged`. In tests, neither branch with `app` is hit, so `defaultStoreDir()` resolves to `path.resolve('data')` (dev branch) — that is correct and what the test asserts.
- `appDataDir()` uses `process.env.APPDATA` on Windows (the test environment is Windows).
- `getStorePath()` creating dirs is the side effect the test checks — assert that `<store>/images` exists afterward.

- [ ] **Step 1: Write `tests/config.test.js`** (failing — module does not exist yet). It redirects `APPDATA` to a temp dir, points the store at a temp dir, and checks path resolution, default-vs-configured behavior, and images-dir creation.

```js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

// Isolate %APPDATA% into a throwaway temp dir so the test never touches the real one.
const tmpAppData = fs.mkdtempSync(path.join(os.tmpdir(), "ia-appdata-"));
process.env.APPDATA = tmpAppData;

// Fresh require AFTER setting APPDATA.
const cfg = require("../core/config.js");

t("appDataDir() = %APPDATA%\\Interests App", () => {
  assert.strictEqual(cfg.appDataDir(), path.join(tmpAppData, "Interests App"));
});

t("configPath() = appDataDir()/config.json", () => {
  assert.strictEqual(cfg.configPath(), path.join(cfg.appDataDir(), "config.json"));
});

t("loadConfig() -> {} when absent", () => {
  assert.deepStrictEqual(cfg.loadConfig(), {});
});

t("saveConfig/loadConfig round-trips and creates appDataDir", () => {
  cfg.saveConfig({ hello: "world" });
  assert.ok(fs.existsSync(cfg.configPath()), "config.json should exist");
  assert.deepStrictEqual(cfg.loadConfig(), { hello: "world" });
});

t("defaultStoreDir() = resolve('data') in dev (no Electron)", () => {
  assert.strictEqual(cfg.defaultStoreDir(), path.resolve("data"));
});

t("getStorePath() defaults to defaultStoreDir() and creates dir + images", () => {
  // Ensure no storePath is configured.
  cfg.saveConfig({});
  const sp = cfg.getStorePath();
  assert.strictEqual(sp, cfg.defaultStoreDir());
  assert.ok(fs.existsSync(sp), "store dir should exist");
  assert.ok(fs.existsSync(path.join(sp, "images")), "images dir should exist");
});

t("setStorePath persists and getStorePath honors it + creates images", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "ia-store-"));
  cfg.setStorePath(target);
  assert.strictEqual(cfg.loadConfig().storePath, target);
  const sp = cfg.getStorePath();
  assert.strictEqual(sp, target);
  assert.ok(fs.existsSync(path.join(target, "images")), "images dir should exist under configured store");
});

t("setStorePath merges, does not clobber other config keys", () => {
  cfg.saveConfig({ keepme: 1 });
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "ia-store2-"));
  cfg.setStorePath(target);
  const c = cfg.loadConfig();
  assert.strictEqual(c.keepme, 1);
  assert.strictEqual(c.storePath, target);
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run the test to SEE IT FAIL** (module missing).

Run:
```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && node tests/config.test.js
```
Expected FAIL: throws `Cannot find module '../core/config.js'` (the harness can't even load it). Exit code 1.

- [ ] **Step 3: Write `core/config.js`** (minimal implementation satisfying the signatures).

```js
// Store-location pointer + config persistence for the Interests App.
// %APPDATA%\Interests App\config.json holds { storePath?: string, ... }.
// Lives OUTSIDE the install dir so it survives reinstalls/updates.
const fs = require("fs");
const path = require("path");

// Electron is optional here: this module must be require()-able from plain Node tests.
let app = null;
try { app = require("electron").app; } catch (_) { /* not under Electron */ }

function appDataDir() {
  const base = process.env.APPDATA || path.join(require("os").homedir(), "AppData", "Roaming");
  return path.join(base, "Interests App");
}

function configPath() {
  return path.join(appDataDir(), "config.json");
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) || {};
  } catch (_) {
    return {};
  }
}

function saveConfig(obj) {
  fs.mkdirSync(appDataDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(obj || {}, null, 2), "utf8");
}

function defaultStoreDir() {
  if (app && app.isPackaged) {
    return path.join(path.dirname(app.getPath("exe")), "data");
  }
  return path.resolve("data");
}

function getStorePath() {
  const cfg = loadConfig();
  const dir = cfg.storePath || defaultStoreDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}

function setStorePath(p) {
  const cfg = loadConfig();
  cfg.storePath = p;
  saveConfig(cfg);
}

module.exports = {
  appDataDir,
  configPath,
  loadConfig,
  saveConfig,
  defaultStoreDir,
  getStorePath,
  setStorePath,
};
```

- [ ] **Step 4: Run the test to SEE IT PASS.**

Run:
```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && node tests/config.test.js
```
Expected PASS: all `ok` lines; `8 passed, 0 failed`; exit code 0.

- [ ] **Step 5: Run the full harness** to confirm nothing regressed.

Run:
```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && node tests/run.js
```
Expected PASS: `syntax-check.js`, `config.test.js`, `durability.test.js` all pass; `ALL TEST FILES PASSED`; exit code 0.

- [ ] **Step 6: Commit.**

```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && git add core/config.js tests/config.test.js && git commit -m "Add core/config.js store-path resolution with tests

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 1.4: `core/server.js` skeleton — static `web/` + `GET /api/ping`

**Files:**
- Create: `core/server.js`
- Create: `tests/server-ping.test.js`

**Interfaces:**
- Consumes: `express` (dependency from Task 1.1); `web/index.html` (served as static, from Task 1.2).
- Produces (exact signatures — `module.exports` is an object with these):
  - `createServer(ctx) -> express.App` — pure factory, **no `listen`**. `ctx = {db, storeDir, getStorePath, setStorePath}` (Phase 1 only needs `ctx` to exist; the ping route ignores it). Serves `web/` static files and exposes `GET /api/ping`.
  - `startServer(ctx, preferredPort=3456) -> {server, port}` — binds `preferredPort`; if busy, tries the next free port up through `3465`; returns the live `http.Server` and the chosen `port`.
  - `GET /api/ping -> {app:"interests", version}` where `version` is read from `package.json`.

Notes for the implementer:
- The static root is `path.join(__dirname, "..", "web")` so the Electron window can load `http://localhost:<port>/` and get `web/index.html`.
- HTTP is tested by mounting `createServer(ctx)` on port 0 with the real `http` module and `global fetch` — do NOT test by calling `startServer` (port binding) in the unit test; `createServer` + a port-0 listen is the convention.
- `startServer`'s alternate-port fallback: catch the `EADDRINUSE` error on `listen`, increment the port, retry up to 3465; if all busy, reject/throw a clear error. This is the contract's `[3456..3465]` discovery range.
- `version` comes from `require("../package.json").version`.

- [ ] **Step 1: Write `tests/server-ping.test.js`** (failing — module missing). Mounts `createServer` on an ephemeral port and fetches `/api/ping` and `/` (the served UI).

```js
const assert = require("assert");
const http = require("http");
const path = require("path");

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

const { createServer } = require("../core/server.js");
const pkg = require("../package.json");

function listen(appHandler) {
  return new Promise((resolve) => {
    const server = http.createServer(appHandler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

(async () => {
  // Minimal ctx — the ping route ignores it, but createServer must accept it.
  const app = createServer({ db: null, storeDir: path.resolve("data"), getStorePath: () => "", setStorePath: () => {} });
  const { server, port } = await listen(app);
  const base = "http://127.0.0.1:" + port;

  await t("GET /api/ping -> {app:'interests', version}", async () => {
    const res = await fetch(base + "/api/ping");
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.app, "interests");
    assert.strictEqual(body.version, pkg.version);
  });

  await t("GET / serves web/index.html", async () => {
    const res = await fetch(base + "/");
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.ok(text.toLowerCase().includes("<!doctype html") || text.toLowerCase().includes("<html"), "should serve HTML");
  });

  await t("unknown /api route -> 404", async () => {
    const res = await fetch(base + "/api/does-not-exist");
    assert.strictEqual(res.status, 404);
  });

  server.close();
  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run the test to SEE IT FAIL** (module missing).

Run:
```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && node tests/server-ping.test.js
```
Expected FAIL: throws `Cannot find module '../core/server.js'`; exit code 1.

- [ ] **Step 3: Write `core/server.js`** (skeleton: static `web/` + `/api/ping` + `startServer` port fallback).

```js
// Core HTTP service for the Interests App.
// Phase 1 skeleton: serves the web/ UI statically and exposes GET /api/ping.
// createServer(ctx) is a pure factory (no listen) so it can be mounted on an
// ephemeral port in tests. startServer(ctx, port) binds with [3456..3465] fallback.
const path = require("path");
const http = require("http");
const express = require("express");

const WEB_DIR = path.join(__dirname, "..", "web");
const VERSION = require("../package.json").version;

const PORT_MIN = 3456;
const PORT_MAX = 3465;

function createServer(ctx) {
  const app = express();
  app.use(express.json({ limit: "64mb" }));

  // Discovery endpoint — the extension probes [3456..3465] for this.
  app.get("/api/ping", (req, res) => {
    res.json({ app: "interests", version: VERSION });
  });

  // Serve the existing web app.
  app.use(express.static(WEB_DIR));

  // 404 for unmatched API routes (static already returns 404 for missing files).
  app.use("/api", (req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  return app;
}

function startServer(ctx, preferredPort = PORT_MIN) {
  const appHandler = createServer(ctx);
  return new Promise((resolve, reject) => {
    function tryPort(port) {
      if (port > PORT_MAX) {
        reject(new Error("No free port in [" + PORT_MIN + ".." + PORT_MAX + "]"));
        return;
      }
      const server = http.createServer(appHandler);
      server.once("error", (err) => {
        if (err && err.code === "EADDRINUSE") {
          tryPort(port + 1);
        } else {
          reject(err);
        }
      });
      server.listen(port, "127.0.0.1", () => {
        resolve({ server, port });
      });
    }
    tryPort(preferredPort);
  });
}

module.exports = { createServer, startServer };
```

- [ ] **Step 4: Run the test to SEE IT PASS.**

Run:
```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && node tests/server-ping.test.js
```
Expected PASS: all `ok` lines; `3 passed, 0 failed`; exit code 0.

- [ ] **Step 5: Run the full harness.**

Run:
```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && node tests/run.js
```
Expected PASS: `syntax-check.js`, `config.test.js`, `server-ping.test.js`, `durability.test.js` all pass; `ALL TEST FILES PASSED`; exit code 0.

- [ ] **Step 6: Commit.**

```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && git add core/server.js tests/server-ping.test.js && git commit -m "Add core/server.js skeleton: static web/ + /api/ping with port fallback

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 1.5: Electron shell — `preload.js`, `main.js`, prove the window loads the served UI

**Files:**
- Create: `preload.js`
- Create: `main.js`

**Interfaces:**
- Consumes:
  - `core/config.js` → `getStorePath()`, `setStorePath(p)` (Task 1.3).
  - `core/server.js` → `startServer(ctx, preferredPort=3456) -> {server, port}` (Task 1.4).
- Produces:
  - A running Electron app: single-instance, starts the Core service, opens a `BrowserWindow` to `http://localhost:<chosen port>/`, records the chosen port into config via `saveConfig`.
  - `preload.js` exposing a minimal `contextBridge` API named `ia`: `ia.pickFolder()` (OS folder dialog via IPC → `string|null`) and `ia.openExternal(url)` (open a link in the default browser via IPC).

Notes for the implementer:
- No HTTP/logic test here — this is the integration shell. Verification is launching the app and confirming the window loads the served UI and `/api/ping` answers on the bound port. `main.js`/`preload.js` are intentionally NOT unit-tested (Electron runtime required); the contract's unit tests cover `config` and `server` already.
- `contextIsolation: true`, `nodeIntegration: false`. The renderer talks to the Core service over HTTP (fetch), not through preload — preload is ONLY for native needs (folder dialog, open external).
- Record the chosen port: after `startServer` resolves, merge `{ port }` into config with `config.saveConfig({ ...config.loadConfig(), port })` so the extension/discovery and a future relaunch know it. (Discovery still probes [3456..3465]; the recorded port is a convenience per the global constraint.)
- Single instance: `app.requestSingleInstanceLock()`; if not acquired, `app.quit()`. Tray is optional and out of scope for proving the window loads — skip it.
- `app.whenReady()` → start server → create window → `win.loadURL("http://127.0.0.1:" + port + "/")`.

- [ ] **Step 1: Write `preload.js`** (minimal contextBridge — folder dialog + open external, via IPC).

```js
// Minimal, safe bridge. Renderer data access is over HTTP (fetch), not here.
// Only native-shell needs are exposed: pick a folder, open an external link.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ia", {
  pickFolder: () => ipcRenderer.invoke("ia:pick-folder"),
  openExternal: (url) => ipcRenderer.invoke("ia:open-external", url),
});
```

- [ ] **Step 2: Write `main.js`** (single-instance; start Core; open window to the bound port; wire the two IPC handlers).

```js
const path = require("path");
const { app, BrowserWindow, dialog, shell, ipcMain } = require("electron");
const config = require("./core/config");
const { startServer } = require("./core/server");

let mainWindow = null;
let httpServer = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    const storeDir = config.getStorePath();

    // ctx for the Core service. db is wired in a later phase (Phase 2).
    const ctx = {
      db: null,
      storeDir,
      getStorePath: config.getStorePath,
      setStorePath: config.setStorePath,
    };

    const { server, port } = await startServer(ctx, 3456);
    httpServer = server;

    // Record the chosen port so discovery/relaunch can find it.
    config.saveConfig(Object.assign({}, config.loadConfig(), { port }));

    createWindow(port);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("will-quit", () => {
    if (httpServer) {
      try { httpServer.close(); } catch (_) { /* ignore */ }
    }
  });
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "Interests App",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL("http://127.0.0.1:" + port + "/");
  mainWindow.on("closed", () => { mainWindow = null; });
}

// Native-shell IPC: folder picker + open external link.
ipcMain.handle("ia:pick-folder", async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle("ia:open-external", async (_evt, url) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    await shell.openExternal(url);
    return true;
  }
  return false;
});
```

- [ ] **Step 3: Launch the app to PROVE the window loads the served UI** (manual smoke — Electron runtime).

Run:
```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && npm start
```
Expected: an "Interests App" window opens showing the existing Interests UI (served from `web/index.html`), NOT a blank page or a browser-tab error. The DevTools console should be free of "failed to load" errors for the document. Close the window to exit.

- [ ] **Step 4: With the app still running (or a second `npm start` foregrounded), verify `/api/ping` answers on the bound port.** In a separate shell, read the recorded port from config and probe it.

Run:
```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && node -e "const c=require('./core/config').loadConfig(); const p=c.port||3456; fetch('http://127.0.0.1:'+p+'/api/ping').then(r=>r.json()).then(j=>{console.log('PING',p,JSON.stringify(j)); process.exit(j.app==='interests'?0:1)}).catch(e=>{console.log('ERR',e.message); process.exit(1)})"
```
Expected: `PING <port> {"app":"interests","version":"1.0.0"}`; exit code 0. (If the app is not running, this exits 1 — that is expected; the proof is that it succeeds while the app IS running.)

- [ ] **Step 5: Confirm the test harness still passes** (no logic changed, but verify the repo is green).

Run:
```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && node tests/run.js
```
Expected PASS: `ALL TEST FILES PASSED`; exit code 0.

- [ ] **Step 6: Commit.**

```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && git add main.js preload.js && git commit -m "Add Electron shell: main.js starts Core service and loads served UI; preload bridge

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```


## Phase 2: Data layer — db.js, images.js, storage endpoints

### Task 2.1: `core/db.js` schema, `openDb`, KV + counts

Stand up the SQLite layer: open the on-disk database in WAL mode, run idempotent migrations for all four tables, run an integrity check, and provide the KV CRUD plus `counts`. This is the foundation every later task in this phase requires. better-sqlite3 is a NATIVE module — the dev test run here uses the plain Node ABI (electron-rebuild is only needed before Electron packaging, handled in the packaging phase; tests run under plain Node so the install-time build is correct as-is).

**Files:**
- Create: `core/db.js` (`openDb`, schema/migrations, `getKV`, `setKV`, `delKV`, `counts`)
- Create: `tests/db.test.js` (KV + counts portion)
- Modify: `package.json` (add `better-sqlite3` to `dependencies`)

**Interfaces:**
- Consumes (from Phase 1): `package.json` exists; `core/config.js` exports `getStorePath()->string`. Node's `require('better-sqlite3')` resolves to a built native binary.
- Produces:
  - `openDb(storeDir: string) -> Database` — opens `storeDir/interests.db`, sets `PRAGMA journal_mode=WAL`, runs migrations, runs `PRAGMA integrity_check`.
  - `getKV(db, key: string) -> string|null`
  - `setKV(db, key: string, value: string) -> void`
  - `delKV(db, key: string) -> void`
  - `counts(db) -> { cards: number, saved: number }`

- [ ] **Step 1: Add `better-sqlite3` dependency**

In `package.json`, ensure the `dependencies` object includes `better-sqlite3`. The exact line to add inside `"dependencies"`:

```json
    "better-sqlite3": "^11.8.1"
```

Then install so the native binary is built for the current Node ABI:

```bash
cd "D:/Dropbox/Documents/Claude/Projects/Interests App" && npm install
```

Expected: install completes; `node -e "require('better-sqlite3'); console.log('ok')"` prints `ok`.

- [ ] **Step 2: Write the failing test for `openDb`, KV, and `counts`**

Create `tests/db.test.js`:

```js
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
  assert.strictEqual(d.pragma("journal_mode", { simple: true }), "wal");
  assert.strictEqual(d.pragma("integrity_check", { simple: true }), "ok");
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
```

- [ ] **Step 3: Run the test to confirm it fails**

Run: `node tests/db.test.js`
Expected: FAIL — `Cannot find module '../core/db'` (the module does not exist yet).

- [ ] **Step 4: Create `core/db.js` with `openDb`, schema, KV, and `counts`**

Create `core/db.js`:

```js
// core/db.js — SQLite open/migrate + CRUD. Synchronous (better-sqlite3).
// NOTE: better-sqlite3 is a NATIVE module. Tests run under plain Node (correct
// ABI from `npm install`). Packaging rebuilds it for the Electron ABI via
// @electron/rebuild — see the packaging phase; nothing to do here.
const path = require("path");
const Database = require("better-sqlite3");

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
  const file = path.join(storeDir, "interests.db");
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  for (const sql of MIGRATIONS) db.exec(sql);
  const ic = db.pragma("integrity_check", { simple: true });
  if (ic !== "ok") throw new Error("integrity_check failed: " + ic);
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
  return { cards, saved };
}

module.exports = { openDb, getKV, setKV, delKV, counts };
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `node tests/db.test.js`
Expected: `6 passed, 0 failed`

- [ ] **Step 6: Commit**

```bash
git add core/db.js tests/db.test.js package.json package-lock.json
git commit -m "feat(db): openDb schema/migrations + KV CRUD + counts (tested)"
```

---

### Task 2.2: `rowToCard` / `cardToRow` round-trip + cards CRUD in `core/db.js`

Add the card mapping functions and the cards CRUD. The mapping is the crux of the data layer: a card's `img` ref (`idb:<id>`, an http(s) URL, or empty) splits into `img_file`/`img_url` columns on the way in and reconstructs on the way out, while every other card field survives in the `data` JSON blob. The columns `id,url,platform,cat,ts,img` are NOT duplicated into `data`.

**Files:**
- Modify: `core/db.js` (add `rowToCard`, `cardToRow`, `allCards`, `replaceCards`, `upsertCard`, `deleteCard`)
- Modify: `tests/db.test.js` (add card mapping + CRUD tests)

**Interfaces:**
- Consumes (from Task 2.1): `openDb(storeDir)->Database`; `counts(db)->{cards,saved}`.
- Produces:
  - `rowToCard(row) -> object` — `{...JSON.parse(row.data), id, url, platform, cat, ts, img}` where `img = row.img_file ? ('idb:'+row.id) : (row.img_url || '')`.
  - `cardToRow(card) -> object` — `{id, url, platform, cat, ts, img_file, img_url, data}`; `img_file` set to `card.id+'.jpg'` when `card.img` starts with `idb:`, `img_url` set when `card.img` starts with `http`, else both null; `data` = JSON of card minus `id,url,platform,cat,ts,img`.
  - `allCards(db) -> array`
  - `replaceCards(db, arr) -> void` (single transaction: delete all, insert all)
  - `upsertCard(db, card) -> void`
  - `deleteCard(db, id) -> void`

- [ ] **Step 1: Write the failing tests for card mapping + CRUD**

Append to `tests/db.test.js`, immediately before the final `console.log(...)` line:

```js
t("cardToRow: idb img -> img_file, no img_url, data excludes column fields", () => {
  const card = { id: "c1", url: "https://x.com/p", platform: "facebook", cat: "Saved", ts: 1700000000000, img: "idb:c1", title: "Hi", tags: ["a"], blocked: false };
  const row = db.cardToRow(card);
  assert.strictEqual(row.id, "c1");
  assert.strictEqual(row.url, "https://x.com/p");
  assert.strictEqual(row.platform, "facebook");
  assert.strictEqual(row.cat, "Saved");
  assert.strictEqual(row.ts, 1700000000000);
  assert.strictEqual(row.img_file, "c1.jpg");
  assert.strictEqual(row.img_url, null);
  const data = JSON.parse(row.data);
  assert.deepStrictEqual(data, { title: "Hi", tags: ["a"], blocked: false });
  assert.ok(!("id" in data) && !("img" in data) && !("ts" in data), "column fields not duplicated in data");
});

t("cardToRow: http img -> img_url, no img_file", () => {
  const row = db.cardToRow({ id: "c2", url: "u", platform: "pinterest", cat: "Feed", ts: 1, img: "https://i.pinimg.com/x.jpg", title: "P" });
  assert.strictEqual(row.img_file, null);
  assert.strictEqual(row.img_url, "https://i.pinimg.com/x.jpg");
});

t("cardToRow: empty img -> both null", () => {
  const row = db.cardToRow({ id: "c3", url: "u", platform: "x", cat: "c", ts: 0, img: "" });
  assert.strictEqual(row.img_file, null);
  assert.strictEqual(row.img_url, null);
});

t("rowToCard: img_file -> idb:<id> ref, data merged", () => {
  const row = { id: "c1", url: "u", platform: "facebook", cat: "Saved", ts: 5, img_file: "c1.jpg", img_url: null, data: JSON.stringify({ title: "Hi", tags: ["a"] }) };
  const card = db.rowToCard(row);
  assert.strictEqual(card.img, "idb:c1");
  assert.strictEqual(card.title, "Hi");
  assert.deepStrictEqual(card.tags, ["a"]);
  assert.strictEqual(card.cat, "Saved");
});

t("rowToCard: img_url passes through; missing -> empty string", () => {
  assert.strictEqual(db.rowToCard({ id: "c2", url: "u", platform: "p", cat: "c", ts: 1, img_file: null, img_url: "https://h/x.jpg", data: "{}" }).img, "https://h/x.jpg");
  assert.strictEqual(db.rowToCard({ id: "c3", url: "u", platform: "p", cat: "c", ts: 1, img_file: null, img_url: null, data: "{}" }).img, "");
});

t("card round-trip through cardToRow -> rowToCard is lossless (idb/http/empty)", () => {
  const cards = [
    { id: "a", url: "ua", platform: "facebook", cat: "Saved", ts: 10, img: "idb:a", title: "A", desc: "d", liked: true },
    { id: "b", url: "ub", platform: "pinterest", cat: "Feed", ts: 20, img: "https://h/b.jpg", title: "B", tags: [] },
    { id: "c", url: "uc", platform: "youtube", cat: "Feed", ts: 30, img: "", title: "C" },
  ];
  for (const c of cards) {
    const back = db.rowToCard(db.cardToRow(c));
    assert.deepStrictEqual(back, c);
  }
});

t("replaceCards inserts in a transaction; allCards reads them back", () => {
  const d = db.openDb(tmpStore());
  db.replaceCards(d, [
    { id: "a", url: "ua", platform: "fb", cat: "Saved", ts: 2, img: "idb:a", title: "A" },
    { id: "b", url: "ub", platform: "pin", cat: "Feed", ts: 1, img: "", title: "B" },
  ]);
  const all = db.allCards(d).sort((x, y) => x.id.localeCompare(y.id));
  assert.strictEqual(all.length, 2);
  assert.strictEqual(all[0].id, "a");
  assert.strictEqual(all[0].img, "idb:a");
  assert.strictEqual(db.counts(d).cards, 2);
  d.close();
});

t("replaceCards is atomic replace (old rows gone)", () => {
  const d = db.openDb(tmpStore());
  db.replaceCards(d, [{ id: "old", url: "u", platform: "p", cat: "c", ts: 1, img: "" }]);
  db.replaceCards(d, [{ id: "new", url: "u", platform: "p", cat: "c", ts: 1, img: "" }]);
  const ids = db.allCards(d).map(c => c.id);
  assert.deepStrictEqual(ids, ["new"]);
  d.close();
});

t("upsertCard inserts then updates; deleteCard removes", () => {
  const d = db.openDb(tmpStore());
  db.upsertCard(d, { id: "a", url: "u1", platform: "p", cat: "c", ts: 1, img: "", title: "v1" });
  db.upsertCard(d, { id: "a", url: "u2", platform: "p", cat: "c", ts: 1, img: "", title: "v2" });
  assert.strictEqual(db.counts(d).cards, 1);
  assert.strictEqual(db.allCards(d)[0].title, "v2");
  assert.strictEqual(db.allCards(d)[0].url, "u2");
  db.deleteCard(d, "a");
  assert.strictEqual(db.counts(d).cards, 0);
  d.close();
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node tests/db.test.js`
Expected: FAIL — `db.cardToRow is not a function` (mapping not implemented yet).

- [ ] **Step 3: Add the card functions to `core/db.js`**

In `core/db.js`, add these functions just above the `module.exports` line:

```js
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

const _insCard = (db) => db.prepare(
  "INSERT INTO cards(id,url,platform,cat,ts,img_file,img_url,data) VALUES(@id,@url,@platform,@cat,@ts,@img_file,@img_url,@data) " +
  "ON CONFLICT(id) DO UPDATE SET url=excluded.url,platform=excluded.platform,cat=excluded.cat,ts=excluded.ts,img_file=excluded.img_file,img_url=excluded.img_url,data=excluded.data"
);

function upsertCard(db, card) {
  _insCard(db).run(cardToRow(card));
}

function replaceCards(db, arr) {
  const ins = _insCard(db);
  const txn = db.transaction((cards) => {
    db.prepare("DELETE FROM cards").run();
    for (const c of cards) ins.run(cardToRow(c));
  });
  txn(arr || []);
}

function deleteCard(db, id) {
  db.prepare("DELETE FROM cards WHERE id=?").run(id);
}
```

Then extend the exports object to include the new names:

```js
module.exports = { openDb, getKV, setKV, delKV, counts, rowToCard, cardToRow, allCards, replaceCards, upsertCard, deleteCard };
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node tests/db.test.js`
Expected: `16 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add core/db.js tests/db.test.js
git commit -m "feat(db): rowToCard/cardToRow round-trip + cards CRUD (replaceCards txn)"
```

---

### Task 2.3: Saved mapping/CRUD + `fp` CRUD in `core/db.js`

Add the `saved` mapping (which uses `item.image`, NOT `item.img`, and a `category`/`clipped` column shape) plus its CRUD, and the fingerprint `fp` CRUD. Saved maps the image analogously to cards: `idb:<id>` → `img_file`, http → `img_url`, empty → both null; `rowToSaved` reconstructs `item.image`.

**Files:**
- Modify: `core/db.js` (add `rowToSaved`, `savedToRow`, `allSaved`, `replaceSaved`, `upsertSaved`, `deleteSaved`, `getFp`, `setFp`, `delFp`, `allFp`)
- Modify: `tests/db.test.js` (add saved + fp tests)

**Interfaces:**
- Consumes (from Tasks 2.1–2.2): `openDb(storeDir)->Database`; `counts(db)->{cards,saved}`.
- Produces:
  - `rowToSaved(row) -> object` — `{...JSON.parse(row.data), id, url, category, clipped, image}` where `image = row.img_file ? ('idb:'+row.id) : (row.img_url || '')`.
  - `savedToRow(item) -> object` — `{id, url, category, clipped, img_file, img_url, data}`; image split from `item.image` analogous to `cardToRow`; `data` = JSON of item minus `id,url,category,clipped,image`.
  - `allSaved(db) -> array`; `replaceSaved(db, arr) -> void` (txn); `upsertSaved(db, item) -> void`; `deleteSaved(db, id) -> void`.
  - `getFp(db, id) -> string|null`; `setFp(db, id, fp) -> void`; `delFp(db, id) -> void`; `allFp(db) -> object` (`{id: fp}`).

- [ ] **Step 1: Write the failing tests for saved + fp**

Append to `tests/db.test.js`, immediately before the final `console.log(...)` line:

```js
t("savedToRow: image idb -> img_file; data excludes column fields", () => {
  const item = { id: "s1", url: "u", category: "Tips", clipped: 1700000000000, image: "idb:s1", title: "T", benefit: "B", source: "src", tags: ["x"], sdate: "2026-06-01" };
  const row = db.savedToRow(item);
  assert.strictEqual(row.id, "s1");
  assert.strictEqual(row.category, "Tips");
  assert.strictEqual(row.clipped, 1700000000000);
  assert.strictEqual(row.img_file, "s1.jpg");
  assert.strictEqual(row.img_url, null);
  const data = JSON.parse(row.data);
  assert.deepStrictEqual(data, { title: "T", benefit: "B", source: "src", tags: ["x"], sdate: "2026-06-01" });
  assert.ok(!("image" in data) && !("category" in data) && !("clipped" in data));
});

t("savedToRow: http image -> img_url; empty -> both null", () => {
  assert.strictEqual(db.savedToRow({ id: "s2", url: "u", category: "c", clipped: 0, image: "https://h/s.jpg" }).img_url, "https://h/s.jpg");
  const empty = db.savedToRow({ id: "s3", url: "u", category: "c", clipped: 0, image: "" });
  assert.strictEqual(empty.img_file, null);
  assert.strictEqual(empty.img_url, null);
});

t("saved round-trip through savedToRow -> rowToSaved is lossless (idb/http/empty)", () => {
  const items = [
    { id: "a", url: "ua", category: "Tips", clipped: 10, image: "idb:a", title: "A", benefit: "b" },
    { id: "b", url: "ub", category: "News", clipped: 20, image: "https://h/b.jpg", title: "B" },
    { id: "c", url: "uc", category: "Misc", clipped: 30, image: "", title: "C", tags: [] },
  ];
  for (const it of items) {
    const back = db.rowToSaved(db.savedToRow(it));
    assert.deepStrictEqual(back, it);
  }
});

t("replaceSaved + allSaved + counts.saved", () => {
  const d = db.openDb(tmpStore());
  db.replaceSaved(d, [
    { id: "a", url: "ua", category: "Tips", clipped: 2, image: "idb:a", title: "A" },
    { id: "b", url: "ub", category: "News", clipped: 1, image: "", title: "B" },
  ]);
  const all = db.allSaved(d).sort((x, y) => x.id.localeCompare(y.id));
  assert.strictEqual(all.length, 2);
  assert.strictEqual(all[0].image, "idb:a");
  assert.strictEqual(db.counts(d).saved, 2);
  d.close();
});

t("upsertSaved updates in place; deleteSaved removes", () => {
  const d = db.openDb(tmpStore());
  db.upsertSaved(d, { id: "a", url: "u", category: "c", clipped: 1, image: "", title: "v1" });
  db.upsertSaved(d, { id: "a", url: "u", category: "c", clipped: 1, image: "", title: "v2" });
  assert.strictEqual(db.counts(d).saved, 1);
  assert.strictEqual(db.allSaved(d)[0].title, "v2");
  db.deleteSaved(d, "a");
  assert.strictEqual(db.counts(d).saved, 0);
  d.close();
});

t("fp: set/get/all/del", () => {
  const d = db.openDb(tmpStore());
  assert.strictEqual(db.getFp(d, "x"), null);
  db.setFp(d, "x", "fpx");
  db.setFp(d, "y", "fpy");
  assert.strictEqual(db.getFp(d, "x"), "fpx");
  assert.deepStrictEqual(db.allFp(d), { x: "fpx", y: "fpy" });
  db.setFp(d, "x", "fpx2");
  assert.strictEqual(db.getFp(d, "x"), "fpx2");
  db.delFp(d, "x");
  assert.strictEqual(db.getFp(d, "x"), null);
  assert.deepStrictEqual(db.allFp(d), { y: "fpy" });
  d.close();
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node tests/db.test.js`
Expected: FAIL — `db.savedToRow is not a function`.

- [ ] **Step 3: Add saved + fp functions to `core/db.js`**

In `core/db.js`, add just above the `module.exports` line:

```js
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

const _insSaved = (db) => db.prepare(
  "INSERT INTO saved(id,url,category,clipped,img_file,img_url,data) VALUES(@id,@url,@category,@clipped,@img_file,@img_url,@data) " +
  "ON CONFLICT(id) DO UPDATE SET url=excluded.url,category=excluded.category,clipped=excluded.clipped,img_file=excluded.img_file,img_url=excluded.img_url,data=excluded.data"
);

function upsertSaved(db, item) {
  _insSaved(db).run(savedToRow(item));
}

function replaceSaved(db, arr) {
  const ins = _insSaved(db);
  const txn = db.transaction((items) => {
    db.prepare("DELETE FROM saved").run();
    for (const it of items) ins.run(savedToRow(it));
  });
  txn(arr || []);
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
```

Then replace the existing `module.exports = {...}` line with the full export set:

```js
module.exports = {
  openDb, getKV, setKV, delKV, counts,
  rowToCard, cardToRow, allCards, replaceCards, upsertCard, deleteCard,
  rowToSaved, savedToRow, allSaved, replaceSaved, upsertSaved, deleteSaved,
  getFp, setFp, delFp, allFp,
};
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node tests/db.test.js`
Expected: `22 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add core/db.js tests/db.test.js
git commit -m "feat(db): saved mapping/CRUD (item.image) + fp CRUD"
```

---

### Task 2.4: `core/images.js` — image-file store

Implement the on-disk image store that replaces IndexedDB `ia_img`. `putImg` decodes a `data:` URL's base64 payload and writes `<id>.jpg`; the rest are thin filesystem helpers. This is the backing store for the `img_file` column and the `/api/img/:id` endpoints.

**Files:**
- Create: `core/images.js` (`imagesDir`, `imgPath`, `putImg`, `getImg`, `hasImg`, `delImg`, `imageCount`, `listImageIds`)
- Create: `tests/images.test.js`

**Interfaces:**
- Consumes: nothing from earlier modules (pure Node `fs`/`path`).
- Produces:
  - `imagesDir(storeDir: string) -> string` — `storeDir/images`.
  - `imgPath(storeDir: string, id: string) -> string` — `imagesDir/<id>.jpg`.
  - `putImg(storeDir: string, id: string, dataUrl: string) -> string` — decodes the `data:...;base64,<payload>` URL, writes `<id>.jpg`, returns `<id>.jpg`.
  - `getImg(storeDir: string, id: string) -> Buffer|null`
  - `hasImg(storeDir: string, id: string) -> boolean`
  - `delImg(storeDir: string, id: string) -> void`
  - `imageCount(storeDir: string) -> number`
  - `listImageIds(storeDir: string) -> array` (ids with `.jpg` stripped)

- [ ] **Step 1: Write the failing test for the image store**

Create `tests/images.test.js`:

```js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const images = require("../core/images");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-img-"));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}

// 1x1 red pixel JPEG, base64
const PIX_B64 = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
const PIX_DATAURL = "data:image/jpeg;base64," + PIX_B64;

t("imagesDir and imgPath build the expected paths", () => {
  const dir = tmpStore();
  assert.strictEqual(images.imagesDir(dir), path.join(dir, "images"));
  assert.strictEqual(images.imgPath(dir, "abc"), path.join(dir, "images", "abc.jpg"));
});

t("putImg decodes the data URL and writes <id>.jpg with the decoded bytes", () => {
  const dir = tmpStore();
  const file = images.putImg(dir, "abc", PIX_DATAURL);
  assert.strictEqual(file, "abc.jpg");
  const onDisk = fs.readFileSync(path.join(dir, "images", "abc.jpg"));
  assert.deepStrictEqual(onDisk, Buffer.from(PIX_B64, "base64"));
});

t("getImg returns the bytes; null when absent", () => {
  const dir = tmpStore();
  assert.strictEqual(images.getImg(dir, "missing"), null);
  images.putImg(dir, "abc", PIX_DATAURL);
  assert.deepStrictEqual(images.getImg(dir, "abc"), Buffer.from(PIX_B64, "base64"));
});

t("hasImg reflects presence", () => {
  const dir = tmpStore();
  assert.strictEqual(images.hasImg(dir, "abc"), false);
  images.putImg(dir, "abc", PIX_DATAURL);
  assert.strictEqual(images.hasImg(dir, "abc"), true);
});

t("delImg removes the file (idempotent on missing)", () => {
  const dir = tmpStore();
  images.putImg(dir, "abc", PIX_DATAURL);
  images.delImg(dir, "abc");
  assert.strictEqual(images.hasImg(dir, "abc"), false);
  images.delImg(dir, "abc"); // no throw
});

t("imageCount and listImageIds report the .jpg files (ids without extension)", () => {
  const dir = tmpStore();
  assert.strictEqual(images.imageCount(dir), 0);
  images.putImg(dir, "a", PIX_DATAURL);
  images.putImg(dir, "b", PIX_DATAURL);
  assert.strictEqual(images.imageCount(dir), 2);
  assert.deepStrictEqual(images.listImageIds(dir).sort(), ["a", "b"]);
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node tests/images.test.js`
Expected: FAIL — `Cannot find module '../core/images'`.

- [ ] **Step 3: Create `core/images.js`**

Create `core/images.js`:

```js
// core/images.js — one .jpg file per picture under storeDir/images.
// Replaces IndexedDB ia_img; removes the ~512 MB single-string ceiling.
const fs = require("fs");
const path = require("path");

function imagesDir(storeDir) {
  return path.join(storeDir, "images");
}
function imgPath(storeDir, id) {
  return path.join(imagesDir(storeDir), id + ".jpg");
}

// Decode a data: URL's base64 payload to a Buffer. Accepts "data:<mime>;base64,<b64>".
function decodeDataUrl(dataUrl) {
  const s = String(dataUrl || "");
  const i = s.indexOf("base64,");
  const b64 = i >= 0 ? s.slice(i + 7) : s;
  return Buffer.from(b64, "base64");
}

function putImg(storeDir, id, dataUrl) {
  const dir = imagesDir(storeDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(imgPath(storeDir, id), decodeDataUrl(dataUrl));
  return id + ".jpg";
}

function getImg(storeDir, id) {
  const p = imgPath(storeDir, id);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

function hasImg(storeDir, id) {
  return fs.existsSync(imgPath(storeDir, id));
}

function delImg(storeDir, id) {
  const p = imgPath(storeDir, id);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function listImageIds(storeDir) {
  const dir = imagesDir(storeDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith(".jpg")).map(f => f.slice(0, -4));
}

function imageCount(storeDir) {
  return listImageIds(storeDir).length;
}

module.exports = { imagesDir, imgPath, putImg, getImg, hasImg, delImg, imageCount, listImageIds };
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node tests/images.test.js`
Expected: `6 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add core/images.js tests/images.test.js
git commit -m "feat(images): on-disk image store (putImg decode + get/has/del/count/list)"
```

---

### Task 2.5: Storage endpoints on `core/server.js` (kv / cards / saved / img / fp)

Expand the Phase 1 `createServer(ctx)` factory with the storage REST endpoints, wired to `core/db.js` and `core/images.js`. The factory stays pure (no `listen`); it reads `db` and `storeDir` from `ctx`. Tested by mounting the returned Express app via `http.createServer(app)` on port 0 and using global `fetch`.

**Files:**
- Modify: `core/server.js` (add kv/cards/saved/img/fp routes inside `createServer(ctx)`)
- Create: `tests/service-data.test.js`

**Interfaces:**
- Consumes (from Phase 1): `createServer(ctx) -> express.App` where `ctx = { db, storeDir, getStorePath, setStorePath }`; Phase 1's `GET /api/ping -> {app:'interests', version}`. The app already has `express.json()` body parsing mounted with a body limit large enough for data-URL image payloads.
- Consumes (Tasks 2.1–2.4): `db.getKV/setKV(db,key[,value])`; `db.allCards(db)`, `db.replaceCards(db,arr)`, `db.upsertCard(db,card)`, `db.deleteCard(db,id)`; `db.allSaved(db)`, `db.replaceSaved(db,arr)`, `db.upsertSaved(db,item)`, `db.deleteSaved(db,id)`; `db.allFp(db)`, `db.setFp(db,id,fp)`, `db.delFp(db,id)`; `images.putImg(storeDir,id,dataUrl)`, `images.getImg(storeDir,id)->Buffer|null`, `images.delImg(storeDir,id)`.
- Produces these routes on the app:
  - `GET /api/kv/:key -> {value}` · `PUT /api/kv/:key {value} -> {ok:true}`
  - `GET /api/cards -> {cards}` · `PUT /api/cards {cards} -> {ok:true,count}` · `PATCH /api/cards/:id {card} -> {ok:true}` · `DELETE /api/cards/:id -> {ok:true}`
  - `GET /api/saved -> {saved}` · `PUT /api/saved {saved} -> {ok:true,count}` · `PATCH /api/saved/:id {item} -> {ok:true}` · `DELETE /api/saved/:id -> {ok:true}`
  - `GET /api/img/:id -> image/jpeg bytes | 404` · `PUT /api/img/:id {data} -> {ok:true,file}` · `DELETE /api/img/:id -> {ok:true}`
  - `GET /api/fp -> {fp:{id:fp}}` · `PUT /api/fp/:id {value} -> {ok:true}` · `DELETE /api/fp/:id -> {ok:true}`

- [ ] **Step 1: Confirm the current `createServer` shape (read before editing)**

Run: `node -e "const m=require('./core/server'); console.log(typeof m.createServer);"`
Expected: `function`. Open `core/server.js` and confirm the `createServer(ctx)` factory, the `express.json()` mount (with a large body limit), and the existing `GET /api/ping` handler. The new routes are added inside this same factory, before its `return app;`.

- [ ] **Step 2: Write the failing service test**

Create `tests/service-data.test.js`:

```js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { createServer } = require("../core/server");
const db = require("../core/db");

let pass = 0, fail = 0;
const todo = [];
function t(name, fn) { todo.push([name, fn]); }

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-svc-"));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}

const PIX_B64 = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";
const PIX_DATAURL = "data:image/jpeg;base64," + PIX_B64;

function mount() {
  const storeDir = tmpStore();
  const database = db.openDb(storeDir);
  const ctx = { db: database, storeDir, getStorePath: () => storeDir, setStorePath: () => {} };
  const app = createServer(ctx);
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const base = "http://127.0.0.1:" + server.address().port;
      resolve({ base, server, database, storeDir });
    });
  });
}

(async () => {
  for (const [name, fn] of todo) {
    const env = await mount();
    try { await fn(env); pass++; console.log("  ok  " + name); }
    catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); }
    finally { env.database.close(); env.server.close(); }
  }
  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();

t("kv: GET missing -> {value:null}; PUT then GET round-trips", async ({ base }) => {
  let r = await fetch(base + "/api/kv/ia_settings");
  assert.deepStrictEqual(await r.json(), { value: null });
  r = await fetch(base + "/api/kv/ia_settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: '{"dark":true}' }) });
  assert.deepStrictEqual(await r.json(), { ok: true });
  r = await fetch(base + "/api/kv/ia_settings");
  assert.deepStrictEqual(await r.json(), { value: '{"dark":true}' });
});

t("cards: PUT bulk -> {ok,count}; GET returns them; PATCH and DELETE work", async ({ base }) => {
  let r = await fetch(base + "/api/cards", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ cards: [
    { id: "a", url: "ua", platform: "fb", cat: "Saved", ts: 2, img: "idb:a", title: "A" },
    { id: "b", url: "ub", platform: "pin", cat: "Feed", ts: 1, img: "", title: "B" },
  ] }) });
  assert.deepStrictEqual(await r.json(), { ok: true, count: 2 });
  r = await fetch(base + "/api/cards");
  const got = (await r.json()).cards.sort((x, y) => x.id.localeCompare(y.id));
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0].img, "idb:a");
  r = await fetch(base + "/api/cards/a", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ card: { id: "a", url: "ua", platform: "fb", cat: "Saved", ts: 2, img: "idb:a", title: "A2" } }) });
  assert.deepStrictEqual(await r.json(), { ok: true });
  r = await fetch(base + "/api/cards");
  assert.strictEqual((await r.json()).cards.find(c => c.id === "a").title, "A2");
  r = await fetch(base + "/api/cards/b", { method: "DELETE" });
  assert.deepStrictEqual(await r.json(), { ok: true });
  r = await fetch(base + "/api/cards");
  assert.deepStrictEqual((await r.json()).cards.map(c => c.id), ["a"]);
});

t("saved: PUT/GET/PATCH/DELETE round-trip (item.image preserved)", async ({ base }) => {
  let r = await fetch(base + "/api/saved", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ saved: [
    { id: "s", url: "u", category: "Tips", clipped: 5, image: "idb:s", title: "T" },
  ] }) });
  assert.deepStrictEqual(await r.json(), { ok: true, count: 1 });
  r = await fetch(base + "/api/saved");
  assert.strictEqual((await r.json()).saved[0].image, "idb:s");
  r = await fetch(base + "/api/saved/s", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ item: { id: "s", url: "u", category: "Tips", clipped: 5, image: "idb:s", title: "T2" } }) });
  assert.deepStrictEqual(await r.json(), { ok: true });
  r = await fetch(base + "/api/saved");
  assert.strictEqual((await r.json()).saved[0].title, "T2");
  r = await fetch(base + "/api/saved/s", { method: "DELETE" });
  assert.deepStrictEqual(await r.json(), { ok: true });
  r = await fetch(base + "/api/saved");
  assert.strictEqual((await r.json()).saved.length, 0);
});

t("img: PUT data URL writes the file; GET returns the jpeg bytes; DELETE removes; GET missing -> 404", async ({ base }) => {
  let r = await fetch(base + "/api/img/abc");
  assert.strictEqual(r.status, 404);
  r = await fetch(base + "/api/img/abc", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: PIX_DATAURL }) });
  const put = await r.json();
  assert.strictEqual(put.ok, true);
  assert.strictEqual(put.file, "abc.jpg");
  r = await fetch(base + "/api/img/abc");
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get("content-type"), "image/jpeg");
  const bytes = Buffer.from(await r.arrayBuffer());
  assert.deepStrictEqual(bytes, Buffer.from(PIX_B64, "base64"));
  r = await fetch(base + "/api/img/abc", { method: "DELETE" });
  assert.deepStrictEqual(await r.json(), { ok: true });
  r = await fetch(base + "/api/img/abc");
  assert.strictEqual(r.status, 404);
});

t("fp: PUT then GET all; DELETE removes", async ({ base }) => {
  let r = await fetch(base + "/api/fp/x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "fpx" }) });
  assert.deepStrictEqual(await r.json(), { ok: true });
  await fetch(base + "/api/fp/y", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value: "fpy" }) });
  r = await fetch(base + "/api/fp");
  assert.deepStrictEqual((await r.json()).fp, { x: "fpx", y: "fpy" });
  r = await fetch(base + "/api/fp/x", { method: "DELETE" });
  assert.deepStrictEqual(await r.json(), { ok: true });
  r = await fetch(base + "/api/fp");
  assert.deepStrictEqual((await r.json()).fp, { y: "fpy" });
});
```

- [ ] **Step 3: Run the test to confirm it fails**

Run: `node tests/service-data.test.js`
Expected: FAIL — the `kv`/`cards`/`saved`/`img`/`fp` routes do not exist yet, so responses are 404 and the `deepStrictEqual` assertions throw (e.g. first `kv` assertion fails).

- [ ] **Step 4: Add the storage routes inside `createServer(ctx)`**

In `core/server.js`, add the following block inside `createServer(ctx)` immediately before its `return app;`. It destructures `db`/`storeDir` from `ctx` and requires the two core modules at the top of the factory body (if `require('./db')`/`require('./images')` are not already present at the top of the file, add them there instead):

```js
  const dbm = require("./db");
  const images = require("./images");
  const { db, storeDir } = ctx;

  // --- KV ---
  app.get("/api/kv/:key", (req, res) => {
    res.json({ value: dbm.getKV(db, req.params.key) });
  });
  app.put("/api/kv/:key", (req, res) => {
    dbm.setKV(db, req.params.key, String(req.body && req.body.value != null ? req.body.value : ""));
    res.json({ ok: true });
  });

  // --- Cards ---
  app.get("/api/cards", (req, res) => {
    res.json({ cards: dbm.allCards(db) });
  });
  app.put("/api/cards", (req, res) => {
    const cards = (req.body && req.body.cards) || [];
    dbm.replaceCards(db, cards);
    res.json({ ok: true, count: cards.length });
  });
  app.patch("/api/cards/:id", (req, res) => {
    const card = (req.body && req.body.card) || {};
    card.id = req.params.id;
    dbm.upsertCard(db, card);
    res.json({ ok: true });
  });
  app.delete("/api/cards/:id", (req, res) => {
    dbm.deleteCard(db, req.params.id);
    res.json({ ok: true });
  });

  // --- Saved ---
  app.get("/api/saved", (req, res) => {
    res.json({ saved: dbm.allSaved(db) });
  });
  app.put("/api/saved", (req, res) => {
    const saved = (req.body && req.body.saved) || [];
    dbm.replaceSaved(db, saved);
    res.json({ ok: true, count: saved.length });
  });
  app.patch("/api/saved/:id", (req, res) => {
    const item = (req.body && req.body.item) || {};
    item.id = req.params.id;
    dbm.upsertSaved(db, item);
    res.json({ ok: true });
  });
  app.delete("/api/saved/:id", (req, res) => {
    dbm.deleteSaved(db, req.params.id);
    res.json({ ok: true });
  });

  // --- Images ---
  app.get("/api/img/:id", (req, res) => {
    const buf = images.getImg(storeDir, req.params.id);
    if (!buf) { res.status(404).end(); return; }
    res.type("image/jpeg").send(buf);
  });
  app.put("/api/img/:id", (req, res) => {
    const file = images.putImg(storeDir, req.params.id, String(req.body && req.body.data || ""));
    res.json({ ok: true, file });
  });
  app.delete("/api/img/:id", (req, res) => {
    images.delImg(storeDir, req.params.id);
    res.json({ ok: true });
  });

  // --- Fingerprints ---
  app.get("/api/fp", (req, res) => {
    res.json({ fp: dbm.allFp(db) });
  });
  app.put("/api/fp/:id", (req, res) => {
    dbm.setFp(db, req.params.id, String(req.body && req.body.value != null ? req.body.value : ""));
    res.json({ ok: true });
  });
  app.delete("/api/fp/:id", (req, res) => {
    dbm.delFp(db, req.params.id);
    res.json({ ok: true });
  });
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `node tests/service-data.test.js`
Expected: `5 passed, 0 failed`

- [ ] **Step 6: Wire the new test files into the runner and confirm the full suite passes**

`tests/run.js` already runs `tests/syntax-check.js` then every `tests/*.test.js`, so `db.test.js`, `images.test.js`, and `service-data.test.js` are picked up automatically. Run the whole suite:

Run: `npm test`
Expected: `syntax-check.js` prints `0 error(s)`; `durability.test.js` prints `12 passed, 0 failed`; `db.test.js` prints `22 passed, 0 failed`; `images.test.js` prints `6 passed, 0 failed`; `service-data.test.js` prints `5 passed, 0 failed`; the runner exits 0.

(If `tests/run.js` does not yet glob `tests/*.test.js` — verify by reading it — make it iterate every file matching `*.test.js` in `tests/` and run each with `node`, failing the run if any child exits non-zero.)

- [ ] **Step 7: Commit**

```bash
git add core/server.js tests/service-data.test.js
git commit -m "feat(server): kv/cards/saved/img/fp storage endpoints (in-process service tests)"
```

---

### Task 2.6: Wire the live database into main.js (RUNTIME-CRITICAL)

This task closes the gap the consistency review found: nothing else opens a real DB for the running app, so every data route would crash on `ctx.db === null`. We isolate context construction in `core/appctx.js` (testable) and use it from `main.js`.

**Files:**
- Create: `core/appctx.js`
- Create: `tests/appctx.test.js`
- Modify: `main.js` (replace the placeholder `ctx` from Phase 1 Task 1.5 with `buildContext(...)`, before `startServer`)

**Interfaces:**
- Consumes: `core/config.js` `getStorePath()/setStorePath(p)`; `core/db.js` `openDb(storeDir)` and `counts(db)` (Phase 2).
- Produces: `core/appctx.js` `buildContext(storeDir?) -> ctx` where `ctx = { db, storeDir, getStorePath, setStorePath, reopen() }`. `reopen()` closes the current handle, reopens from `ctx.storeDir`, rebinds `ctx.db`, and returns it. This is the exact `ctx` shape `core/server.js` `createServer(ctx)`/`startServer(ctx)` and the Phase 6 restore/move flows require.

- [ ] **Step 1: Write the failing test** `tests/appctx.test.js`.

```js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildContext } = require("../core/appctx");
const db = require("../core/db");

let pass = 0, fail = 0;
function t(name, fn){ try{ fn(); pass++; console.log("  ok  "+name); }catch(e){ fail++; console.log("  FAIL "+name+" — "+e.message); } }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-appctx-"));

t("buildContext opens a real DB at the given store dir", () => {
  const ctx = buildContext(dir);
  assert.ok(ctx.db, "ctx.db should be set");
  assert.strictEqual(ctx.storeDir, dir);
  assert.ok(fs.existsSync(path.join(dir, "interests.db")), "interests.db created");
  const c = db.counts(ctx.db);
  assert.strictEqual(c.cards, 0);
  assert.strictEqual(c.saved, 0);
});

t("reopen() rebinds ctx.db to a working handle", () => {
  const ctx = buildContext(dir);
  const before = ctx.db;
  const after = ctx.reopen();
  assert.ok(after, "reopen returns a handle");
  assert.strictEqual(ctx.db, after, "ctx.db rebound");
  assert.notStrictEqual(after, before, "a new handle");
  assert.strictEqual(db.counts(ctx.db).cards, 0, "reopened handle works");
});

t("getStorePath/setStorePath are passed through", () => {
  const ctx = buildContext(dir);
  assert.strictEqual(typeof ctx.getStorePath, "function");
  assert.strictEqual(typeof ctx.setStorePath, "function");
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it to verify it fails.**

Run: `node tests/appctx.test.js`
Expected: FAIL — `Cannot find module '../core/appctx'`.

- [ ] **Step 3: Create `core/appctx.js`.**

```js
// Builds the single server context (db + paths + reopen) used by core/server.js
// and the live Electron app. Keeping it here (not inline in main.js) makes it testable.
const db = require("./db");
const config = require("./config");

function buildContext(storeDir) {
  const dir = storeDir || config.getStorePath();
  const ctx = {
    db: db.openDb(dir),
    storeDir: dir,
    getStorePath: config.getStorePath,
    setStorePath: config.setStorePath,
    reopen: function () {
      try { if (ctx.db && typeof ctx.db.close === "function") ctx.db.close(); } catch (e) {}
      ctx.db = db.openDb(ctx.storeDir);
      return ctx.db;
    }
  };
  return ctx;
}

module.exports = { buildContext };
```

- [ ] **Step 4: Run it to verify it passes.**

Run: `node tests/appctx.test.js`
Expected: PASS — `3 passed, 0 failed`.

- [ ] **Step 5: Wire `main.js` to use it.** Replace the placeholder context from Phase 1 Task 1.5 (the `{ db: null, storeDir, getStorePath, setStorePath }` object) with `buildContext`, constructed BEFORE `startServer`, and keep the BrowserWindow loading the returned port. The relevant region of `main.js` becomes:

```js
const { buildContext } = require("./core/appctx");
const { startServer } = require("./core/server");

// ... inside app start (after app 'ready'):
const ctx = buildContext();                 // opens the live DB at the resolved store path
const { port } = startServer(ctx, 3456);    // binds 127.0.0.1, returns the actual port
win.loadURL("http://localhost:" + port + "/");
```

- [ ] **Step 6: Run the full gate.**

Run: `node tests/run.js`
Expected: PASS — the syntax gate, `appctx.test.js` (3 passed), and all other `*.test.js` green; `ALL TEST FILES PASSED`.

- [ ] **Step 7: Commit.**

```bash
git add core/appctx.js tests/appctx.test.js main.js && git commit -m "Wire live DB into main.js via core/appctx buildContext (+ ctx.reopen)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---


## Phase 3: Browser storage adapter + repoint index.html chokepoints

### Task 3.1: `web/storage.js` pure URL/endpoint builders + failing unit test

**Files:**
- Create: `web/storage.js` (initial skeleton: `endpoints` builder object + dual-export shim)
- Create: `tests/storage-url.test.js`
- Modify: `package.json` (scripts.test stays `node tests/run.js`; no change if already present — verify only)

**Interfaces:**
- Consumes (from Phase 2 REST contract, for URL shapes only): `GET /api/img/:id`, `GET/PUT /api/kv/:key`, `GET/PUT /api/cards`, `PATCH/DELETE /api/cards/:id`, `GET/PUT /api/saved`, `PATCH/DELETE /api/saved/:id`, `GET/PUT/DELETE /api/fp/:id`, `GET /api/captures`, `GET /api/capture-request`/`POST /api/capture-request`, `GET /api/batch-state`/`POST /api/batch-state`, `GET /api/batch-progress`/`POST /api/batch-progress`, `POST /api/backup`, `GET /api/backups`, `POST /api/restore`, `GET /api/store-location`, `POST /api/store-location/move`, `POST /api/import`.
- Produces (pure, `require()`-able from Node AND attachable to browser global): an object `SE` (storage endpoints) with exact members:
  - `SE.imgUrl(id) -> string` returns the string `/api/img/` concatenated with `id`
  - `SE.kv(key) -> "/api/kv/" + encodeURIComponent(key)`
  - `SE.cards() -> "/api/cards"` ; `SE.card(id) -> "/api/cards/" + encodeURIComponent(id)`
  - `SE.saved() -> "/api/saved"` ; `SE.savedItem(id) -> "/api/saved/" + encodeURIComponent(id)`
  - `SE.fp() -> "/api/fp"` ; `SE.fpItem(id) -> "/api/fp/" + encodeURIComponent(id)`
  - `SE.captures() -> "/api/captures"` ; `SE.captureRequest() -> "/api/capture-request"`
  - `SE.batchState() -> "/api/batch-state"` ; `SE.batchProgress() -> "/api/batch-progress"`
  - `SE.backup() -> "/api/backup"` ; `SE.backups() -> "/api/backups"` ; `SE.restore() -> "/api/restore"`
  - `SE.storeLocation() -> "/api/store-location"` ; `SE.storeMove() -> "/api/store-location/move"`
  - `SE.import() -> "/api/import"`

- [ ] **Step 1: Write the failing test `tests/storage-url.test.js`.** This requires the module (which does not export anything usable yet) and asserts the pure builders. Complete file:
```js
const assert = require("assert");
const { SE } = require("../web/storage.js");

let pass = 0, fail = 0;
function t(name, fn){ try{ fn(); pass++; console.log("  ok  " + name); } catch(e){ fail++; console.log("  FAIL " + name + " — " + e.message); } }

t("imgUrl(id) is /api/img/ + id (the load-bearing rule)", () => {
  assert.strictEqual(SE.imgUrl("abc123"), "/api/img/" + "abc123");
});
t("imgUrl handles an empty id", () => {
  assert.strictEqual(SE.imgUrl(""), "/api/img/");
});
t("kv encodes the key", () => {
  assert.strictEqual(SE.kv("ia_settings"), "/api/kv/ia_settings");
  assert.strictEqual(SE.kv("a b"), "/api/kv/a%20b");
});
t("cards endpoints", () => {
  assert.strictEqual(SE.cards(), "/api/cards");
  assert.strictEqual(SE.card("id-1"), "/api/cards/id-1");
});
t("saved endpoints", () => {
  assert.strictEqual(SE.saved(), "/api/saved");
  assert.strictEqual(SE.savedItem("s9"), "/api/saved/s9");
});
t("fp endpoints", () => {
  assert.strictEqual(SE.fp(), "/api/fp");
  assert.strictEqual(SE.fpItem("c4"), "/api/fp/c4");
});
t("capture + batch endpoints", () => {
  assert.strictEqual(SE.captures(), "/api/captures");
  assert.strictEqual(SE.captureRequest(), "/api/capture-request");
  assert.strictEqual(SE.batchState(), "/api/batch-state");
  assert.strictEqual(SE.batchProgress(), "/api/batch-progress");
});
t("backup/restore/store/import endpoints", () => {
  assert.strictEqual(SE.backup(), "/api/backup");
  assert.strictEqual(SE.backups(), "/api/backups");
  assert.strictEqual(SE.restore(), "/api/restore");
  assert.strictEqual(SE.storeLocation(), "/api/store-location");
  assert.strictEqual(SE.storeMove(), "/api/store-location/move");
  assert.strictEqual(SE.import(), "/api/import");
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run the test — expect FAIL.** Command:
```
node tests/storage-url.test.js
```
Expected: it throws `Cannot find module '../web/storage.js'` (file does not exist yet), so the process exits non-zero. That is the failing state.

- [ ] **Step 3: Create `web/storage.js` with the pure `SE` builders and a dual export shim.** The module must be `require()`-able in Node (CommonJS) AND, when loaded as a plain `<script>` in the browser, attach `SE` to `window` without throwing. Complete file:
```js
/* web/storage.js — the ONLY browser-side code that talks to the Core REST API.
   Pure endpoint builders (SE) are factored out so they can be unit-tested in Node
   via require(); the browser path attaches them (and the Store adapter, added in a
   later step) to window. No bundler — this file is loaded by a plain <script> tag. */
(function (root) {
  "use strict";

  // ---- Pure endpoint builders (no I/O — safe to require() in tests) ----
  var SE = {
    imgUrl: function (id) { return "/api/img/" + id; },
    kv: function (key) { return "/api/kv/" + encodeURIComponent(key); },
    cards: function () { return "/api/cards"; },
    card: function (id) { return "/api/cards/" + encodeURIComponent(id); },
    saved: function () { return "/api/saved"; },
    savedItem: function (id) { return "/api/saved/" + encodeURIComponent(id); },
    fp: function () { return "/api/fp"; },
    fpItem: function (id) { return "/api/fp/" + encodeURIComponent(id); },
    captures: function () { return "/api/captures"; },
    captureRequest: function () { return "/api/capture-request"; },
    batchState: function () { return "/api/batch-state"; },
    batchProgress: function () { return "/api/batch-progress"; },
    backup: function () { return "/api/backup"; },
    backups: function () { return "/api/backups"; },
    restore: function () { return "/api/restore"; },
    storeLocation: function () { return "/api/store-location"; },
    storeMove: function () { return "/api/store-location/move"; },
    import: function () { return "/api/import"; }
  };

  // Expose SE on the global (browser) so index.html can read /api/img/<id>.
  root.SE = SE;

  // CommonJS export for tests (no-op in the browser where module is undefined).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { SE: SE };
  }
})(typeof self !== "undefined" ? self : this);
```

- [ ] **Step 4: Run the test — expect PASS.** Command:
```
node tests/storage-url.test.js
```
Expected output ends with `9 passed, 0 failed` and exit code 0.

- [ ] **Step 5: Commit.**
```
git add web/storage.js tests/storage-url.test.js
git commit -m "Add web/storage.js pure endpoint builders + storage-url test

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3.2: `Store` adapter (kv / cards / saved / img / fp / captures / batch / backup) over fetch

**Files:**
- Modify: `web/storage.js` (append the async `Store` adapter object inside the same IIFE; `SE` unchanged)
- Modify: `tests/storage-url.test.js` (add one assertion that `require()`-ing the module still exposes `SE`; do NOT test fetch here — `Store` is browser-only, exercised against the real server in Phase 2's API tests)

**Interfaces:**
- Consumes: pure `SE.*` builders from Task 3.1; browser global `fetch`.
- Produces (browser global `Store`, all async unless noted):
  - `Store.kvGet(key) -> Promise<any|null>` (parses JSON value; null when absent) ; `Store.kvSet(key, val) -> Promise<void>`
  - `Store.getCards() -> Promise<array>` ; `Store.putCards(arr) -> Promise<{ok,count}>` ; `Store.patchCard(card) -> Promise<void>` ; `Store.delCard(id) -> Promise<void>`
  - `Store.getSaved() -> Promise<array>` ; `Store.putSaved(arr) -> Promise<{ok,count}>` ; `Store.patchSaved(item) -> Promise<void>` ; `Store.delSaved(id) -> Promise<void>`
  - `Store.imgUrl(id) -> string` (NON-async; returns `SE.imgUrl(id)`; no blob fetch, no cache) ; `Store.imgPut(id, dataUrl) -> Promise<void>` ; `Store.imgDel(id) -> Promise<void>` ; `Store.imgHas(id) -> Promise<boolean>`
  - `Store.fpGet(id) -> Promise<string|null>` ; `Store.fpSet(id, fp) -> Promise<void>` ; `Store.fpDel(id) -> Promise<void>` ; `Store.fpAll() -> Promise<object>`
  - `Store.drainCaptures() -> Promise<array>` (GET /api/captures — returns AND clears the queue)
  - `Store.setCaptureRequest(req) -> Promise<void>` ; `Store.getBatchState() -> Promise<object|null>` ; `Store.setBatchState(s) -> Promise<void>` ; `Store.setBatchProgress(p) -> Promise<void>`
  - `Store.backupNow() -> Promise<object>` ; `Store.listBackups() -> Promise<array>` ; `Store.restore(name) -> Promise<object>` ; `Store.storeLocation() -> Promise<object>` ; `Store.moveStore(target) -> Promise<object>` ; `Store.runImport(srcDir) -> Promise<object>`

- [ ] **Step 1: Add the failing-ish guard test for module re-require.** Append to `tests/storage-url.test.js` immediately before the final `console.log(...)` line:
```js
t("Store is NOT exported to Node (browser-only); SE still is", () => {
  const mod = require("../web/storage.js");
  assert.ok(mod.SE, "SE must be exported for Node tests");
  assert.strictEqual(mod.Store, undefined, "Store must remain browser-only (uses fetch)");
});
```
Update the expected count comment in your head: the file now has 10 tests.

- [ ] **Step 2: Run the test — expect PASS for existing 9, and the new one already passes** (module currently exports only `{SE}`, so `mod.Store` is `undefined`). Command:
```
node tests/storage-url.test.js
```
Expected: `10 passed, 0 failed`. (This locks the invariant before we add `Store`.)

- [ ] **Step 3: Append the `Store` adapter to `web/storage.js`.** Insert the following block inside the IIFE, immediately AFTER `root.SE = SE;` and BEFORE the `if (typeof module ...)` export block. Complete code:
```js
  // ---- Async adapter over the Core REST API (browser-only; uses fetch) ----
  // Only attached when fetch exists (i.e. in the browser). Tests require() the
  // module purely for SE and must NOT see Store.
  if (typeof root.fetch === "function") {
    var jget = function (url) {
      return root.fetch(url).then(function (r) {
        if (!r.ok) throw new Error("GET " + url + " -> " + r.status);
        return r.json();
      });
    };
    var jsend = function (method, url, body) {
      return root.fetch(url, {
        method: method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      }).then(function (r) {
        if (!r.ok) throw new Error(method + " " + url + " -> " + r.status);
        return r.json();
      });
    };

    var Store = {
      // --- kv (replaces persistent ia_* localStorage) ---
      kvGet: function (key) {
        return jget(SE.kv(key)).then(function (j) {
          if (j == null || j.value == null) return null;
          try { return JSON.parse(j.value); } catch (e) { return j.value; }
        });
      },
      kvSet: function (key, val) {
        return jsend("PUT", SE.kv(key), { value: JSON.stringify(val) }).then(function () {});
      },

      // --- cards ---
      getCards: function () { return jget(SE.cards()).then(function (j) { return (j && j.cards) || []; }); },
      putCards: function (arr) { return jsend("PUT", SE.cards(), { cards: arr || [] }); },
      patchCard: function (card) { return jsend("PATCH", SE.card(card.id), { card: card }).then(function () {}); },
      delCard: function (id) { return jsend("DELETE", SE.card(id)).then(function () {}); },

      // --- saved ---
      getSaved: function () { return jget(SE.saved()).then(function (j) { return (j && j.saved) || []; }); },
      putSaved: function (arr) { return jsend("PUT", SE.saved(), { saved: arr || [] }); },
      patchSaved: function (item) { return jsend("PATCH", SE.savedItem(item.id), { item: item }).then(function () {}); },
      delSaved: function (id) { return jsend("DELETE", SE.savedItem(id)).then(function () {}); },

      // --- images: plain URLs for <img src>; no blob fetch, no in-memory cache ---
      imgUrl: function (id) { return SE.imgUrl(id); },
      imgPut: function (id, dataUrl) { return jsend("PUT", SE.imgUrl(id), { data: dataUrl }).then(function () {}); },
      imgDel: function (id) { return jsend("DELETE", SE.imgUrl(id)).then(function () {}); },
      imgHas: function (id) {
        return root.fetch(SE.imgUrl(id), { method: "GET" }).then(function (r) { return r.ok; }).catch(function () { return false; });
      },

      // --- fingerprints (placeholder detection; no image bytes) ---
      fpGet: function (id) { return jget(SE.fp()).then(function (j) { return ((j && j.fp) || {})[id] || null; }); },
      fpSet: function (id, fp) { return jsend("PUT", SE.fpItem(id), { value: fp }).then(function () {}); },
      fpDel: function (id) { return jsend("DELETE", SE.fpItem(id)).then(function () {}); },
      fpAll: function () { return jget(SE.fp()).then(function (j) { return (j && j.fp) || {}; }); },

      // --- capture bridge ---
      drainCaptures: function () { return jget(SE.captures()).then(function (j) { return (j && j.captures) || []; }); },
      setCaptureRequest: function (req) { return jsend("POST", SE.captureRequest(), { request: req }).then(function () {}); },
      getBatchState: function () { return jget(SE.batchState()).then(function (j) { return (j && j.state) || null; }); },
      setBatchState: function (s) { return jsend("POST", SE.batchState(), { state: s }).then(function () {}); },
      setBatchProgress: function (p) { return jsend("POST", SE.batchProgress(), { progress: p }).then(function () {}); },

      // --- backup / restore / store location / import ---
      backupNow: function () { return jsend("POST", SE.backup()); },
      listBackups: function () { return jget(SE.backups()).then(function (j) { return (j && j.backups) || []; }); },
      restore: function (name) { return jsend("POST", SE.restore(), { name: name }); },
      storeLocation: function () { return jget(SE.storeLocation()); },
      moveStore: function (target) { return jsend("POST", SE.storeMove(), { target: target }); },
      runImport: function (srcDir) { return jsend("POST", SE.import(), { srcDir: srcDir }); }
    };

    root.Store = Store;
  }
```

- [ ] **Step 4: Run the URL test — expect PASS (Store still NOT in Node export).** Command:
```
node tests/storage-url.test.js
```
Expected: `10 passed, 0 failed`. In Node there is no `root.fetch`, so `Store` is never attached and the export remains `{SE}` — the guard test confirms it.

- [ ] **Step 5: Run the syntax gate against the new file via Node parse — expect PASS.** Command:
```
node -e "new Function(require('fs').readFileSync('web/storage.js','utf8')); console.log('storage.js parses OK')"
```
Expected: prints `storage.js parses OK`, exit 0.

- [ ] **Step 6: Commit.**
```
git add web/storage.js tests/storage-url.test.js
git commit -m "Add Store fetch adapter (kv/cards/saved/img/fp/captures/batch/backup)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3.3: Load `web/storage.js` in `index.html`; repoint `resolveImg` + remove bounded-image-cache machinery

**Files:**
- Modify: `web/index.html` — add `<script src="storage.js"></script>` before the main inline script; gut the image-store section (lines around the `_imgDB`/`_imgCache`/`lruPush`/`cachePut`/`idb*Img`/`resolveImg`/`initImageStore` block, ~558–700) so card images are plain URLs.
- Modify: `tests/syntax-check.js` — extend it to ALSO parse every inline `<script>` block in `web/index.html` and to parse `web/storage.js`.

**Interfaces:**
- Consumes: browser global `Store.imgUrl(id) -> string`, `Store.imgPut(id, dataUrl) -> Promise`, `Store.imgDel(id) -> Promise`.
- Produces: `resolveImg(v) -> string` (now: `idb:<id>` → `Store.imgUrl(id)`; `http(s)` unchanged; empty → `""`); `setCardImage(it, src) -> void` (data URL → `Store.imgPut`; empty/http → set `it.img` + `Store.imgDel` when clearing an idb image); `attachCardImages() -> void` (sets `src = Store.imgUrl(id)`); a no-op `initImageStore()` retained as an async function for boot compatibility.

> NOTE: Phase 3's scope says `index.html` "moves to `web/index.html` (git mv)". If that move has not happened in an earlier phase, do it as the first step here. If `web/index.html` already exists, skip Step 1.

- [ ] **Step 1: Move `index.html` into `web/` (only if not already there).** Command (skip if `web/index.html` exists):
```
git mv index.html web/index.html
```

- [ ] **Step 2: Update `tests/syntax-check.js` to gate BOTH `web/index.html` and `web/storage.js` — write the new gate (this is the failing test that proves the move + new file parse).** Complete file:
```js
// Validates every inline <script> block in web/index.html parses, and that
// web/storage.js parses. Exit 1 on any error.
const fs = require("fs");
const path = require("path");

let total = 0, errors = 0;
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

const htmlPath = path.join(__dirname, "..", "web", "index.html");
const html = fs.readFileSync(htmlPath, "utf8");
let m, i = 0;
while ((m = re.exec(html))) {
  i++; total++;
  try { new Function(m[1]); }
  catch (x) { errors++; console.log("web/index.html BLOCK " + i + ": " + x.message); }
}

const storagePath = path.join(__dirname, "..", "web", "storage.js");
total++;
try { new Function(fs.readFileSync(storagePath, "utf8")); }
catch (x) { errors++; console.log("web/storage.js: " + x.message); }

console.log(i + " inline script block(s) + storage.js = " + total + " unit(s), " + errors + " error(s)");
process.exit(errors ? 1 : 0);
```

- [ ] **Step 3: Run the gate — expect PASS on the moved file (still using old in-page code).** Command:
```
node tests/syntax-check.js
```
Expected: prints `... unit(s), 0 error(s)`, exit 0. (If it errors with `ENOENT` on `web/index.html`, the move in Step 1 did not happen — fix that first.)

- [ ] **Step 4: Add the storage.js `<script>` include to `web/index.html`.** Find the existing dark-theme bootstrap line (`<script>try{if(localStorage.getItem("ia_theme")...`) and add the include on the line immediately AFTER it. Replace:
```html
<script>try{if(localStorage.getItem("ia_theme")==="dark")document.documentElement.classList.add("dark");}catch(e){}</script>
```
with:
```html
<script>try{if(localStorage.getItem("ia_theme")==="dark")document.documentElement.classList.add("dark");}catch(e){}</script>
<script src="storage.js"></script>
```

- [ ] **Step 5: Replace the bounded-image-cache block with URL-based stubs.** In `web/index.html`, replace the entire span from the comment `/* ============ image store (IndexedDB) ============` through the end of `function initImageStore(){ ... }` (the original lines ~558–700) with the following. This removes `_imgDB`/`_imgCache`/`_imgCacheKeys`/`lruPush`/`cachePut`/`imgDB`/`idbPutImg`/`idbDelImg`/`idbAllImgs`/`idbAllKeys`/`idbGetImg` and rewrites `resolveImg`/`setCardImage`/`initImageStore`. Keep the `_fpMap`/`fpDB` lines that the NEXT task repoints — i.e. replace ONLY up to and including the close of `initImageStore`, leaving the `let _fpDB=null, _fpMap={};` cluster in place for Task 3.4. Complete replacement block:
```js
/* ============ image store (Core service) ============
   Card images are now plain files served by the Core service at /api/img/<id>.
   The browser no longer caches image bytes — <img src> points straight at the URL,
   so there is no 512 MB string ceiling and nothing to evict. resolveImg() turns an
   "idb:<id>" reference into that URL; setCardImage() PUT/DELETEs the file. */
// keep a fingerprint map only (loaded once from the service in Task 3.4)
let _fpMap={};

// assign an image to a card: data URLs are written to the service (ref kept as
// "idb:<id>"); http(s) URLs are stored inline; clearing removes the file.
function setCardImage(it, src){
  if(src && src.indexOf("data:")===0){
    it.img="idb:"+it.id;
    Store.imgPut(it.id, src);                                   // write the file
    const fp = imgFp(src); _fpMap[it.id]=fp; Store.fpSet(it.id, fp);   // placeholder fp (no bytes kept)
  } else {
    const wasIdb = (it.img && (""+it.img).indexOf("idb:")===0);
    it.img=src||"";
    if(wasIdb){ Store.imgDel(it.id); if(_fpMap[it.id]){ delete _fpMap[it.id]; Store.fpDel(it.id); } }
  }
}
// resolve a card's stored image to something usable in an <img src>
function resolveImg(v){ if(!v) return ""; return (""+v).indexOf("idb:")===0 ? Store.imgUrl((""+v).slice(4)) : v; }
// image bytes are no longer preloaded; nothing to do at boot. Kept async so the
// existing boot sequence (await initImageStore()) is unchanged.
async function initImageStore(){ /* images are plain URLs now — no preload */ }
```

- [ ] **Step 6: Rewrite `attachCardImages()` to set `src` straight from the URL (no idbGetImg/cachePut).** Replace the existing `function attachCardImages(){ ... }` body. Complete replacement:
```js
function attachCardImages(){
  try{
    const imgs = document.querySelectorAll("img[data-imgid],img[data-imgsrc]");
    if(!imgs.length){ if(_imgObserver){ _imgObserver.disconnect(); _imgObserver=null; } return; }
    if(_imgObserver) _imgObserver.disconnect();
    const load = im=>{
      if(im.getAttribute("src")) return;
      const idbId = im.getAttribute("data-imgid");        // Imported card: keyed by card id
      if(idbId){ im.loading="lazy"; im.src=Store.imgUrl(idbId); return; }
      const sid = im.getAttribute("data-imgsrc");          // Feed/Saved card: resolve the item's image
      if(sid){ const it=findItem(sid); const s=it&&it.image; if(s && String(s).indexOf("idb:")===0){ im.loading="lazy"; im.src=Store.imgUrl(String(s).slice(4)); } else if(s){ im.src=s; } else { nextImg(im, sid); } }
    };
    if(!("IntersectionObserver" in window)){ imgs.forEach(load); return; }
    _imgObserver=new IntersectionObserver((entries,obs)=>{ for(const e of entries){ if(e.isIntersecting){ load(e.target); obs.unobserve(e.target); } } },{root:null,rootMargin:"800px 0px"});
    imgs.forEach(im=>_imgObserver.observe(im));
  }catch(e){ console.warn("attachCardImages failed",e); }
}
```

- [ ] **Step 7: Repoint the remaining `_imgCache`/`idbDelImg`/`idbGetImg` references in render/groom/saved code.** Apply these exact edits in `web/index.html`:
  - The feed-card image push (originally `if(item.image){ const r = item.image.indexOf("idb:")===0 ? (_imgCache[item.image.slice(4)]||"") : item.image; if(r) c.push(r); }`) becomes:
```js
  if(item.image){ const r = (""+item.image).indexOf("idb:")===0 ? Store.imgUrl((""+item.image).slice(4)) : item.image; if(r) c.push(r); }
```
  - The groom no-link cleanup (originally `nolink.forEach(it=>{ if(it.img && (it.img+"").indexOf("idb:")===0){ idbDelImg(it.id); delete _imgCache[it.id]; } });`) becomes:
```js
  nolink.forEach(it=>{ if(it.img && (it.img+"").indexOf("idb:")===0){ Store.imgDel(it.id); } });
```
  - The single-card delete (originally `if(gone && gone.img && gone.img.indexOf("idb:")===0){ idbDelImg(gone.id); delete _imgCache[gone.id]; }`) becomes:
```js
  if(gone && gone.img && (""+gone.img).indexOf("idb:")===0){ Store.imgDel(gone.id); }
```
  - The saved-image clear (originally `else { item.image=src||""; if(_imgCache[item.id]){ delete _imgCache[item.id]; idbDelImg(item.id); } }`) becomes:
```js
  else { const wasIdb=(item.image && (""+item.image).indexOf("idb:")===0); item.image=src||""; if(wasIdb) Store.imgDel(item.id); }
```
  - The two remaining `if(item.image && (item.image+"").indexOf("idb:")===0 && _imgCache[item.id]){ delete _imgCache[item.id]; idbDelImg(item.id); }` lines (one in setSavedImage path, one in the `cap.clipImage` http branch `else if(/^https?:/.test(cap.clipImage)){ item.image=cap.clipImage; if(_imgCache[item.id]){ delete _imgCache[item.id]; idbDelImg(item.id); } }`) become, respectively:
```js
  if(item.image && (item.image+"").indexOf("idb:")===0){ Store.imgDel(item.id); }
```
```js
  else if(/^https?:/.test(cap.clipImage)){ const wasIdb=(item.image && (""+item.image).indexOf("idb:")===0); item.image=cap.clipImage; if(wasIdb) Store.imgDel(item.id); }
```
  - In `impThumb`/render where `_imgCache` is consulted for an idb image (the `isIdbImg`-first branch around the old line 2698 and the saved-card resolve), replace any `_imgCache[k]` lookup used to build an `<img>` source with `Store.imgUrl(k)` and drop the `idbGetImg` fallback. (Search the file for remaining `_imgCache` and `idbGetImg`/`idbDelImg`/`idbAllImgs`/`idbAllKeys`/`cachePut`/`lruPush` identifiers — there must be ZERO left after this task except inside this task's intended replacements.)

- [ ] **Step 8: Verify no orphaned image-cache identifiers remain.** Command (expect NO output):
```
grep -nE "_imgCache|_imgCacheKeys|idbGetImg|idbPutImg|idbDelImg|idbAllImgs|idbAllKeys|cachePut|lruPush|IMG_CACHE_MAX|_imgDB|function imgDB" web/index.html
```
Expected: empty output (every reference repointed/removed). If any line prints, repoint it to `Store.imgUrl`/`Store.imgPut`/`Store.imgDel` per the patterns above.

- [ ] **Step 9: Run the syntax gate — expect PASS.** Command:
```
node tests/syntax-check.js
```
Expected: `... unit(s), 0 error(s)`, exit 0.

- [ ] **Step 10: Run the durability test — expect PASS (it extracts `lruPush` from `index.html`; now that the function is gone it will fail, so the durability test's `lruPush` cases must be retired here).** First run to observe the break:
```
node tests/durability.test.js
```
Expected: it throws `function not found in index.html: lruPush` (the extractor reads `index.html`, which no longer exists / no longer has `lruPush`). Fix by pointing the extractor at the new path AND dropping the retired `lruPush` cases. Apply these two edits to `tests/_extract.js` and `tests/durability.test.js`:
  - In `tests/_extract.js`, change the read path inside `loadFns` from `path.join(__dirname, "..", "index.html")` to:
```js
  const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
```
  - In `tests/durability.test.js`, change the destructure line and delete the four `lruPush` test cases. The new top of the file:
```js
const assert = require("assert");
const { loadFns } = require("./_extract");
const { pickBackupsToDelete, backupCountsMatch } = loadFns(["pickBackupsToDelete", "backupCountsMatch"]);
```
  and remove the four `t("lruPush ...", ...)` blocks near the end.

- [ ] **Step 11: Run the durability test — expect PASS.** Command:
```
node tests/durability.test.js
```
Expected: ends with `N passed, 0 failed` (N reduced by 4), exit 0.

- [ ] **Step 12: Commit.**
```
git add web/index.html web/storage.js tests/syntax-check.js tests/_extract.js tests/durability.test.js
git commit -m "Repoint resolveImg/setCardImage/attachCardImages to Store URLs; drop image cache

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3.4: Repoint fingerprints (`fp*`/`_fpMap`) to `Store.fp*`

**Files:**
- Modify: `web/index.html` — remove `_fpDB`/`fpDB`/`fpPut`/`fpDel`/`fpAll` (IndexedDB) functions; load `_fpMap` once from `Store.fpAll()` at boot; route writes through `Store.fpSet`/`Store.fpDel`.

**Interfaces:**
- Consumes: `Store.fpAll() -> Promise<object{id:fp}>`, `Store.fpSet(id, fp) -> Promise`, `Store.fpDel(id) -> Promise`.
- Produces: in-memory `_fpMap` (object) loaded once; `fbPlaceholderGroups` continues to read `_fpMap[it.id]` synchronously (unchanged behavior).

- [ ] **Step 1: Remove the IndexedDB fp helpers.** In `web/index.html`, delete the block (originally lines ~599–605):
```js
// Tiny separate DB mapping card id -> image fingerprint, so FB placeholder detection
// (fbPlaceholderGroups) never needs the image bytes in memory. Mirrored in _fpMap.
let _fpDB=null, _fpMap={};
function fpDB(){ ... }
async function fpPut(id, fp){ ... }
async function fpDel(id){ ... }
async function fpAll(){ ... }
```
Note `let _fpMap={};` was already re-declared in Task 3.3's image block, so do NOT re-declare it here — just ensure exactly ONE `let _fpMap` survives (the one in the image-store block). Delete this entire stale cluster including its `let _fpDB=null, _fpMap={};` line.

- [ ] **Step 2: Load `_fpMap` once at boot from the service.** In the async boot IIFE (originally `try{ await initImageStore(); ... }`), add an `await Store.fpAll()` assignment before `initImageStore()`. Replace:
```js
  try{ await initImageStore(); if(curTab==="imported") renderImported(); }
  catch(e){ console.warn("image store init failed", e); }
```
with:
```js
  try{ _fpMap = await Store.fpAll(); }catch(e){ console.warn("fp load failed", e); _fpMap = {}; }
  try{ await initImageStore(); if(curTab==="imported") renderImported(); }
  catch(e){ console.warn("image store init failed", e); }
```

- [ ] **Step 3: Repoint any direct `fpPut`/`fpDel`/`fpAll` calls left in render/migration code to `Store.fp*`.** Search and replace remaining call sites:
  - In the old `initImageStore` fp-migration and inline-migration loops there were `fpPut(id, fp)` / `fpPut(it.id, fp)` calls — those loops were removed in Task 3.3; verify none remain.
  - Any surviving `fpPut(` → `Store.fpSet(`, `fpDel(` → `Store.fpDel(`, `await fpAll()` → `await Store.fpAll()`.

- [ ] **Step 4: Verify no orphaned fp-IndexedDB identifiers remain.** Command (expect NO output):
```
grep -nE "_fpDB|function fpDB|async function fpPut|async function fpDel|async function fpAll|[^.]fpPut\(|[^.]fpDel\(|[^.]fpAll\(" web/index.html
```
Expected: empty output. (`_fpMap`, `Store.fpSet`, `Store.fpDel`, `Store.fpAll` are the only fp references that may remain.)

- [ ] **Step 5: Run the syntax gate — expect PASS.** Command:
```
node tests/syntax-check.js
```
Expected: `... unit(s), 0 error(s)`, exit 0.

- [ ] **Step 6: Commit.**
```
git add web/index.html
git commit -m "Repoint image fingerprints from IndexedDB to Store.fp*

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3.5: Repoint persistent `ia_*` localStorage to `Store.kv`; cards/saved load+save to `Store`

**Files:**
- Modify: `web/index.html` — rewrite `load`/`save` to async `Store.kvGet`/`Store.kvSet`; load `imported`/`saved` from `Store.getCards`/`Store.getSaved`; persist via `Store.putCards`/`Store.putSaved`; wrap the module-top synchronous boot in an async sequence.

**Interfaces:**
- Consumes: `Store.kvGet(key) -> Promise<any|null>`, `Store.kvSet(key, val) -> Promise`, `Store.getCards() -> Promise<array>`, `Store.putCards(arr) -> Promise`, `Store.getSaved() -> Promise<array>`, `Store.putSaved(arr) -> Promise`.
- Produces: async `loadKV(key, dflt) -> Promise<any>`; `saveKV(key, val) -> Promise<void>`; a single `await bootData()` that populates `feed/saved/hidden/clicks/shown/likes/imported/spool/stCur/S` before first render. Theme reads (`ia_theme`) stay synchronous localStorage (loaded before the body, transient/UX-only — allowed to remain in localStorage).

- [ ] **Step 1: Replace the synchronous module-top list loads with declarations only.** The current lines (originally 541–549) synchronously call `load(...)`. Replace:
```js
let feed   = load("feed", []);
let saved  = load("saved", []);
let hidden = load("hidden", []);
let clicks = load("clicks", []);
let shown  = load("shown", []);
let likes  = load("likes", []);
let imported = load("imported", []);
let spool  = load("spool", []);
let stCur  = load("stcur", null);
```
with:
```js
let feed=[], saved=[], hidden=[], clicks=[], shown=[], likes=[], imported=[], spool=[], stCur=null;
```

- [ ] **Step 2: Rewrite `load`/`save` to async kv helpers and keep `save`/`load` call sites working.** Replace:
```js
function load(k,d){ try{ const v=localStorage.getItem("ia_"+k); return v?JSON.parse(v):d; }catch(e){ return d; } }
function save(k,v){ try{ localStorage.setItem("ia_"+k, JSON.stringify(v)); return true; }catch(e){ console.warn("save failed ("+k+"):", e && e.name); return false; } }
```
with:
```js
// Persistent app state now lives in the Core service kv store (key "ia_<k>").
// load() returns a Promise; the few synchronous-default call sites use loadKVSync's
// cached value populated at boot. save() fires-and-forgets the PUT (the in-memory
// array is the source of truth during a session; the service persists it).
function load(k,d){ return Store.kvGet("ia_"+k).then(function(v){ return (v==null)?d:v; }); }
function save(k,v){ Store.kvSet("ia_"+k, v); return true; }
```

- [ ] **Step 3: Repoint the special-cased persistent `ia_*` localStorage call sites to `Store.kv`.** These are the keys the contract marks persistent (settings, backup metadata, health, batch/capture state, placeholder fps, dedup/migration flags, last-opened/last-backup). Apply, in `web/index.html`:
  - `localStorage.setItem("ia_lastbackup", String(Date.now()))` → `Store.kvSet("ia_lastbackup", Date.now())`
  - `localStorage.setItem("ia_backup_last", JSON.stringify(obj))` → `Store.kvSet("ia_backup_last", obj)` (pass the object, not a string)
  - `+localStorage.getItem("ia_lastbackup") || 0` (both occurrences) → `(+(await Store.kvGet("ia_lastbackup")) || 0)` inside the already-async `maybeAutoBackup`/health functions
  - `localStorage.setItem("ia_health", JSON.stringify(health))` → `Store.kvSet("ia_health", health)`; `JSON.parse(localStorage.getItem("ia_health")||"null")` → `await Store.kvGet("ia_health")`
  - `JSON.parse(localStorage.getItem("ia_backup_last")||"null")` → `await Store.kvGet("ia_backup_last")`
  - `localStorage.getItem("ia_ph_fps")` / `setItem("ia_ph_fps", ...)` → load `_phFps` at boot from `await Store.kvGet("ia_ph_fps")` and write via `Store.kvSet("ia_ph_fps", [..._phFps].slice(-200))` (replace the IIFE initializer with `let _phFps=new Set();` and seed it in `bootData`)
  - `localStorage.setItem("ia_batch_state", ...)`, `getItem/removeItem("ia_batch_state")`, `ia_batch_progress`, `ia_batch_cancel` → handled by Task 3.7 (capture/batch). Leave for that task; do NOT touch here.
  - `localStorage.setItem("ia_capture_request", ...)` → handled by Task 3.7. Leave.
  - `localStorage.setItem("ia_last_opened", ...)` / `getItem("ia_last_opened")` → `Store.kvSet("ia_last_opened", obj)` / `await Store.kvGet("ia_last_opened")` (these read inside async functions; for `drainCaptures` they move to Task 3.7)
  - `localStorage.getItem("ia_fbtested")`, `setItem("ia_fbtested","1")`, `ia_fbrender_tested` → `await Store.kvGet("ia_fbtested")` / `Store.kvSet("ia_fbtested", 1)` (these read inside async capture-trigger functions — Task 3.7 owns the batch writers; here only convert the non-batch flag reads that are in already-async scopes, otherwise defer to 3.7)
  - `localStorage.setItem("ia_last_opened",...)` in `impOpen` → `Store.kvSet("ia_last_opened", {id:it.id, ts:Date.now()})`
  - `ia_fp_migrated` reads/writes were removed with `initImageStore` in Task 3.3 — verify none remain.
  - Theme: `localStorage.getItem("ia_theme")`/`setItem("ia_theme",...)` STAY as localStorage (transient/UX, read before the body loads). Do not convert.

- [ ] **Step 4: Add a `bootData()` async loader and call it before first render.** Replace the synchronous tail of the script (the cleanup IIFE at ~3940, `save("settings", S)`, `updateCounts()`, `showTab(load("tab","feed"))`, and the async boot IIFE) with a single async boot that first loads all data from the service. Replace:
```js
(function(){
  feed = dropAlreadySaved(feed); save("feed", feed);
  const before=imported.length;
  ... existing cleanup body ...
  ensureIds();
})();
save("settings", S);
updateCounts();
showTab(load("tab","feed"));
(async()=>{
  try{ await restoreFolder(); }catch(e){ console.warn("restoreFolder failed", e); }
  try{ _fpMap = await Store.fpAll(); }catch(e){ console.warn("fp load failed", e); _fpMap = {}; }
  try{ await initImageStore(); if(curTab==="imported") renderImported(); }
  catch(e){ console.warn("image store init failed", e); }
  try{ await storageHealthCheck(); }catch(e){ console.warn("health check failed", e); }
  maybeAutoBackup();
})();
```
with:
```js
async function bootData(){
  // pull all persistent state from the Core service before first render
  imported = await Store.getCards();
  saved    = await Store.getSaved();
  feed   = (await load("feed",   [])) || [];
  hidden = (await load("hidden", [])) || [];
  clicks = (await load("clicks", [])) || [];
  shown  = (await load("shown",  [])) || [];
  likes  = (await load("likes",  [])) || [];
  spool  = (await load("spool",  [])) || [];
  stCur  = await load("stcur", null);
  try{ const ph = await Store.kvGet("ia_ph_fps"); _phFps = new Set(Array.isArray(ph)?ph:[]); }catch(e){ _phFps = new Set(); }
  const st = await Store.kvGet("ia_settings"); if(st && typeof st==="object") S = Object.assign(S, st);

  // one-time data hygiene (was a synchronous IIFE)
  feed = dropAlreadySaved(feed); save("feed", feed);
  const before=imported.length;
  imported = imported.filter(i=>!/^https?:\/\//i.test(i.title));
  imported = imported.filter(i=>!/^.{2,40}\bsaved\b.{0,80}\b(link|post|video|event)\b\.?$/i.test(i.title));
  let wiped=0;
  imported.forEach(i=>{ if(i.desc && /\blikely\b/i.test(i.desc) && /\b(pin|post|video|image|idea|visual|interest)\b/i.test(i.desc)){ delete i.desc; wiped++; } });
  if(imported.length!==before || wiped){
    await Store.putCards(imported);
    setTimeout(()=>toast("Cleaned up "+(before-imported.length)+" junk imports, reset "+wiped+" vague descriptions — re-import pinterest-import.json, then hit Enrich"), 800);
  }
  ensureIds();
  save("settings", S);
  updateCounts();
  showTab(await load("tab","feed"));

  try{ _fpMap = await Store.fpAll(); }catch(e){ console.warn("fp load failed", e); _fpMap = {}; }
  try{ await initImageStore(); if(curTab==="imported") renderImported(); }catch(e){ console.warn("image store init failed", e); }
  try{ await storageHealthCheck(); }catch(e){ console.warn("health check failed", e); }
  maybeAutoBackup();
}
bootData();
```

- [ ] **Step 5: Repoint `ensureIds`/`persistAll` and cards/saved persistence to `Store`.** `ensureIds()` calls `save("imported",imported)` — that now hits kv, but cards must persist to the cards table. Replace `ensureIds`'s save line `if(n) save("imported",imported);` with `if(n) Store.putCards(imported);` and change its remaining behavior to return `n`. In `persistAll()` (originally `function persistAll(){ save("feed",feed); save("saved",saved); ... writeSavesFile(); }`), route the two table-backed lists to their endpoints:
```js
function persistAll(){ save("feed",feed); Store.putSaved(saved); save("hidden",hidden); save("clicks",clicks); save("shown",shown); save("likes",likes); save("spool",spool); writeSavesFile(); }
```
Then audit every other `save("imported", imported)` call in the file and change it to `Store.putCards(imported)`, and every `save("saved", saved)` to `Store.putSaved(saved)`. (Search: `grep -nE 'save\("(imported|saved)"' web/index.html` — there must be ZERO left after this step.)

- [ ] **Step 6: Verify no persistent `ia_*` localStorage chokepoints remain (theme + batch/capture excepted).** Command:
```
grep -nE "localStorage\.(getItem|setItem|removeItem)\(\"ia_" web/index.html | grep -vE "ia_theme|ia_batch|ia_capture_request|ia_last_opened|ia_fbtested|ia_fbrender_tested"
```
Expected: empty output. Any remaining persistent key must route through `Store.kv*`. (Batch/capture/last-opened/fbtested keys are intentionally deferred to Task 3.7; theme stays.)

- [ ] **Step 7: Confirm no `save("imported"|"saved")` table writes leak into kv.** Command (expect NO output):
```
grep -nE 'save\("(imported|saved)"' web/index.html
```

- [ ] **Step 8: Run the syntax gate — expect PASS.** Command:
```
node tests/syntax-check.js
```
Expected: `... unit(s), 0 error(s)`, exit 0.

- [ ] **Step 9: Commit.**
```
git add web/index.html
git commit -m "Repoint persistent ia_* state to Store.kv; cards/saved to Store tables

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3.6: Repoint backup / restore / connect-folder to `Store`; remove `showDirectoryPicker`; add Settings Move-data-location

**Files:**
- Modify: `web/index.html` — replace `connectFolder`/`restoreFolder`/`writeSavesFile`/`doBackup`/`backupNow`/`restoreLatest`/`restoreFromDir`/`restoreFromList`/`renderBackupList` bodies to call `Store.backupNow`/`listBackups`/`restore`; delete every `showDirectoryPicker`/File System Access path; add a Settings "Move…" action wired to `Store.moveStore`.

**Interfaces:**
- Consumes: `Store.backupNow() -> Promise<object>`, `Store.listBackups() -> Promise<array<{name,date,counts}>>`, `Store.restore(name) -> Promise<object>`, `Store.storeLocation() -> Promise<{path,counts}>`, `Store.moveStore(target) -> Promise<{ok,path}>`.
- Produces: `backupNow() -> Promise`; `renderBackupList() -> Promise<void>` (renders from `Store.listBackups()`); `moveDataLocation() -> Promise<void>` (Settings action calling `Store.moveStore`).

- [ ] **Step 1: Remove the File System Access API entirely.** Replace `connectFolder` and `restoreFolder` and the `writeSavesFile` debounced writer with service-backed no-ops/equivalents. Replace `async function connectFolder(){ ... }` (the `showDirectoryPicker` body) with:
```js
// Folder picking via the File System Access API is gone — the Core service owns
// the store and backups. "Connect" now just confirms the service is reachable and
// triggers an initial backup.
async function connectFolder(){
  try{
    await Store.storeLocation();           // reachable?
    if(!(+S.autoBackup)){ S.autoBackup = 1; save("settings", S); const sel=document.getElementById("autoBackup"); if(sel) sel.value="1"; }
    toast("Backups on — saving to Dropbox\\Interests App\\backups");
    await doBackup(true);
    try{ await storageHealthCheck(); }catch(e){}
  }catch(e){ toast("Couldn't reach the app service"); }
}
```
Replace `async function restoreFolder(){ ... }` (the `idbGet("dir")`/`queryPermission` body) with:
```js
// no browser folder handle to reconnect anymore — the service is always the store.
async function restoreFolder(){ /* no-op: Core service owns the store */ }
```
Replace `function writeSavesFile(){ ... }` (the `dirHandle.getFileHandle` writer) with:
```js
// saves.json export is now handled by the service's backup; nothing to write here.
function writeSavesFile(){ /* no-op: backups handled by the Core service */ }
```
Also delete `function setFsStatus(on){ ... }`'s dependence on `dirHandle` if present, and any module-level `let dirHandle` / `idbGet("dir")` / `idbSet("dir", ...)` references.

- [ ] **Step 2: Verify `showDirectoryPicker` and File System Access remnants are gone.** Command (expect NO output):
```
grep -nE "showDirectoryPicker|getFileHandle|createWritable|queryPermission|requestPermission|dirHandle|idbSet\(\"dir|idbGet\(\"dir" web/index.html
```
Expected: empty output.

- [ ] **Step 3: Repoint `doBackup`/`backupNow` to the service.** Replace `async function backupNow(){ return doBackup(true); }` and the body of `doBackup` so the actual copy is delegated to the service. Make `doBackup` call `Store.backupNow()` and update the local last-backup metadata via `Store.kvSet`. Replace `async function backupNow(){ return doBackup(true); }` with:
```js
async function backupNow(){ return doBackup(true); }
async function doBackup(manual){
  try{
    const res = await Store.backupNow();                 // {ok,name,counts}
    const counts = res && res.counts ? res.counts : {imported:imported.length, saved:saved.length, images:0};
    await Store.kvSet("ia_lastbackup", Date.now());
    await Store.kvSet("ia_backup_last", { ts:Date.now(), counts:counts, verified:true, where:"Dropbox", name:(res&&res.name)||"" });
    if(manual) toast("Backed up: "+(counts.imported||0)+" cards, "+(counts.images||0)+" images");
    try{ await storageHealthCheck(); }catch(e){}
    return res;
  }catch(e){ if(manual) toast("Backup failed: "+(e&&e.message||e)); console.warn("backup failed", e); }
}
```

- [ ] **Step 4: Repoint restore paths to `Store.restore`.** Replace `restoreLatest`, `restoreFromDir`, and `restoreFromList` to delegate to the service by backup name. Replace their bodies:
```js
async function restoreFromList(name){
  if(!name) return;
  if(!confirm("Restore from "+name+"? A safety snapshot of your current data is taken first.")) return;
  try{
    await Store.restore(name);
    toast("Restored from "+name+" — reloading");
    setTimeout(()=>location.reload(), 600);
  }catch(e){ toast("Restore failed: "+(e&&e.message||e)); }
}
async function restoreFromDir(name){ return restoreFromList(name); }
async function restoreLatest(){
  const list = await Store.listBackups();
  if(!list || !list.length){ toast("No backups found"); return; }
  return restoreFromList(list[0].name);
}
```
(If existing callers pass a second `isDir`/`label` arg, the new signatures ignore it harmlessly.)

- [ ] **Step 5: Repoint `renderBackupList` to `Store.listBackups`.** Replace `async function renderBackupList(){ ... }` with a version that lists from the service. Complete:
```js
async function renderBackupList(){
  const host = document.getElementById("backupList");
  if(!host) return;
  let list = [];
  try{ list = await Store.listBackups(); }catch(e){ host.innerHTML = "<div class='muted'>Couldn't load backups.</div>"; return; }
  if(!list.length){ host.innerHTML = "<div class='muted'>No backups yet.</div>"; return; }
  host.innerHTML = list.map(function(b){
    const c = b.counts || {};
    const label = (b.date||b.name) + " · " + (c.cards!=null?c.cards:(c.imported||0)) + " cards, " + (c.images||0) + " images";
    return "<div class='backup-row'><span>"+label+"</span> " +
           "<button class='btn btn-ghost' onclick=\"restoreFromList('"+b.name.replace(/'/g,"\\'")+"')\">Restore</button></div>";
  }).join("");
}
```

- [ ] **Step 6: Add a Settings "Move data location" action wired to `Store.moveStore`.** Add this function near `renderBackupList`:
```js
async function moveDataLocation(){
  let cur = {};
  try{ cur = await Store.storeLocation(); }catch(e){}
  const target = prompt("Move the data store to a new folder.\nCurrent: " + (cur.path||"(unknown)") + "\n\nEnter the FULL path of the new folder:", cur.path||"");
  if(!target || target === cur.path) return;
  toast("Moving data store… (the old copy is kept until the move verifies)");
  try{
    const res = await Store.moveStore(target);
    toast("Data store moved to " + (res.path||target));
    try{ await storageHealthCheck(); }catch(e){}
  }catch(e){ toast("Move failed: " + (e&&e.message||e)); }
}
```
Then add a button to the Settings/data section markup next to the backup controls:
```html
<button class="btn btn-ghost" id="moveDataBtn" onclick="moveDataLocation()" title="Copy the database + images to a new folder, verify, then switch to it. The old copy is kept until verified.">Move data location…</button>
```
(Place it adjacent to the existing "Back up now" / backup-list block in the Settings panel; if a current-store-path label is shown there, populate it from `Store.storeLocation()` in `storageHealthCheck`.)

- [ ] **Step 7: Verify the restore/backup call sites use `Store` and no folder API.** Command (expect every backup/restore reference to be `Store.*`; NO File System Access):
```
grep -nE "Store\.(backupNow|listBackups|restore|storeLocation|moveStore)" web/index.html
```
Expected: non-empty (the new calls). And re-run the Step 2 grep — still empty.

- [ ] **Step 8: Run the syntax gate — expect PASS.** Command:
```
node tests/syntax-check.js
```
Expected: `... unit(s), 0 error(s)`, exit 0.

- [ ] **Step 9: Commit.**
```
git add web/index.html
git commit -m "Repoint backup/restore/connect-folder to Store; remove showDirectoryPicker; add Move-data-location

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3.7: Repoint `drainCaptures` + capture-request/batch writers to `Store`; final phase gate

**Files:**
- Modify: `web/index.html` — `drainCaptures` reads from `Store.drainCaptures()`; capture-request writers use `Store.setCaptureRequest`; batch-state writers use `Store.setBatchState`; batch-progress reader/writer use `Store.getBatchState`/`Store.setBatchProgress`; the cards/saved persistence inside `drainCaptures` uses `Store.putCards`/`Store.putSaved`.
- Modify: `tests/run.js` (verify it discovers `tests/storage-url.test.js`; create it if Phase 2 did not).

**Interfaces:**
- Consumes: `Store.drainCaptures() -> Promise<array>`, `Store.setCaptureRequest(req) -> Promise`, `Store.getBatchState() -> Promise<object|null>`, `Store.setBatchState(s) -> Promise`, `Store.setBatchProgress(p) -> Promise`, `Store.kvGet/kvSet`, `Store.putCards`, `Store.putSaved`.
- Produces: async `drainCaptures() -> Promise<void>`; `pollBatchProgress() -> Promise<void>`; batch-trigger functions writing state via `Store.setBatchState`.

- [ ] **Step 1: Make `drainCaptures` async and read the queue from the service.** Replace the head of `function drainCaptures(){ ... }`. Change the signature and the queue source. Replace:
```js
function drainCaptures(){
  let raw;
  try{ raw=localStorage.getItem("ia_captures"); }catch(e){ return; }
  if(!raw) return;
  let queue;
  try{ queue=JSON.parse(raw); }catch(e){ return; }
  if(!Array.isArray(queue)||!queue.length) return;
```
with:
```js
async function drainCaptures(){
  let queue;
  try{ queue = await Store.drainCaptures(); }catch(e){ return; }   // GET /api/captures returns AND clears the queue
  if(!Array.isArray(queue)||!queue.length) return;
```

- [ ] **Step 2: Repoint the `ia_last_opened` reads and the queue persistence inside `drainCaptures`.** Within `drainCaptures`:
  - Replace each `try{ lastOpened=JSON.parse(localStorage.getItem("ia_last_opened")||"null"); }catch(e){}` and the two inner `let lo=null; try{ lo=JSON.parse(localStorage.getItem("ia_last_opened")||"null"); }catch(e){}` with the awaited form: `let lo=null; try{ lo=await Store.kvGet("ia_last_opened"); }catch(e){}` (and `lastOpened = await Store.kvGet("ia_last_opened")` for the outer one).
  - The service already cleared the queue on GET, so DELETE the re-persist line `try{ localStorage.setItem("ia_captures", JSON.stringify(remaining)); }catch(e){}`. If `remaining` holds items that must be retried (deferred captures), re-enqueue them instead: replace that line with:
```js
  if(remaining.length){ for(const r of remaining){ try{ await Store.kvSet("ia_last_opened", await Store.kvGet("ia_last_opened")); }catch(e){} } }
```
  Simpler and correct: re-POST any deferred items back. Replace the persist line with:
```js
  // queue was drained server-side; re-enqueue anything we deliberately deferred
  if(remaining.length){ try{ await Promise.all(remaining.map(function(c){ return fetch("/api/captures",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({capture:c})}); })); }catch(e){} }
```
  - Replace the `refreshActive` write `try{ localStorage.setItem("ia_last_opened", JSON.stringify({id:lastOpened.id, ts:Date.now()})); }catch(e){}` with `try{ await Store.kvSet("ia_last_opened", {id:lastOpened.id, ts:Date.now()}); }catch(e){}`.
  - Where the function persists changed cards/saved at its end (it currently relies on `save`/`writeSavesFile` via the caller), ensure any `save("imported",imported)`/`save("saved",saved)` inside it became `Store.putCards`/`Store.putSaved` in Task 3.5; if a local persist exists, set `if(changed) await Store.putCards(imported);` and `if(persisted) await Store.putSaved(saved);`.

- [ ] **Step 3: Repoint capture-request writers.** Replace each `localStorage.setItem("ia_capture_request", JSON.stringify(payload))` (in the impOpen single-capture and the force/closeAfter path) with `Store.setCaptureRequest(payload)`. The two originals:
```js
  try{ localStorage.setItem("ia_capture_request", JSON.stringify({url:it.url, id:it.id, delay:(S.captureDelay||0)*1000, force:stale, capture:doCapture})); }catch(e){}
```
becomes:
```js
  Store.setCaptureRequest({url:it.url, id:it.id, delay:(S.captureDelay||0)*1000, force:stale, capture:doCapture});
```
and:
```js
  try{ localStorage.setItem("ia_capture_request", JSON.stringify({url:it.url, id:it.id, delay:(S.captureDelay||0)*1000, force:true, capture:true, closeAfter:true, render: isFb?1:undefined})); }catch(e){}
```
becomes:
```js
  Store.setCaptureRequest({url:it.url, id:it.id, delay:(S.captureDelay||0)*1000, force:true, capture:true, closeAfter:true, render: isFb?1:undefined});
```
Also convert the surrounding `localStorage.setItem("ia_last_opened", JSON.stringify({id:it.id, ts:Date.now()}))` in those two functions to `Store.kvSet("ia_last_opened", {id:it.id, ts:Date.now()})`.

- [ ] **Step 4: Repoint batch-state writers.** Replace each `localStorage.setItem("ia_batch_state", JSON.stringify(stateObj))` with `Store.setBatchState(stateObj)`. There are several (manual batch, fb batch, fb-render batch). Example — the original:
```js
    localStorage.setItem("ia_batch_state", JSON.stringify({items, next:0, done:0, total:items.length, delay:(S.captureDelay||0)*1000, concurrency:Math.max(1,Math.min(10,S.captureConcurrency||1)), active:true}));
```
becomes:
```js
    Store.setBatchState({items, next:0, done:0, total:items.length, delay:(S.captureDelay||0)*1000, concurrency:Math.max(1,Math.min(10,S.captureConcurrency||1)), active:true});
```
Apply the same transform to the other `ia_batch_state` writers (the `delay:4000 ... fb:1` and `... render:1` variants). Convert the `ia_fbtested`/`ia_fbrender_tested` flag reads/writes in these (now-async) trigger functions: `localStorage.getItem("ia_fbtested")` → `await Store.kvGet("ia_fbtested")`, `localStorage.setItem("ia_fbtested","1")` → `Store.kvSet("ia_fbtested", 1)` (and the `_render_tested` pair), making each trigger function `async` as needed.

- [ ] **Step 5: Repoint batch cancel + progress.** Replace the cancel block:
```js
  try{ localStorage.setItem("ia_batch_cancel","1"); localStorage.removeItem("ia_batch_progress"); localStorage.removeItem("ia_batch_state"); }catch(e){}
```
with:
```js
  try{ Store.setBatchState({active:false, cancel:true}); Store.setBatchProgress(null); }catch(e){}
```
Replace the progress poller body. The original:
```js
  let p; try{ p=JSON.parse(localStorage.getItem("ia_batch_progress")||"null"); }catch(e){ return; }
```
becomes (make `pollBatchProgress` async):
```js
  let p; try{ p = await Store.getBatchState(); p = p && p.progress ? p.progress : await (async()=>{ const j=await fetch("/api/batch-progress").then(r=>r.json()).catch(()=>null); return j && j.progress; })(); }catch(e){ return; }
```
Simpler and matching the contract (progress has its own GET): replace with:
```js
  let p; try{ const j = await fetch("/api/batch-progress").then(r=>r.json()); p = j && j.progress; }catch(e){ return; }
```

- [ ] **Step 6: Verify all batch/capture/last-opened localStorage chokepoints are gone.** Command (expect NO output):
```
grep -nE "localStorage\.(getItem|setItem|removeItem)\(\"ia_(captures|capture_request|batch_state|batch_progress|batch_cancel|last_opened|fbtested|fbrender_tested)" web/index.html
```
Expected: empty output.

- [ ] **Step 7: Confirm the only remaining `ia_*` localStorage usage is the allowed theme key.** Command:
```
grep -nE "localStorage\.(getItem|setItem|removeItem)\(\"ia_" web/index.html
```
Expected: only `ia_theme` lines (the pre-body dark-mode bootstrap + `setTheme`/`darkToggle`). Nothing else.

- [ ] **Step 8: Run the full test runner — expect PASS across syntax + units.** Command:
```
node tests/run.js
```
Expected: `tests/syntax-check.js` prints `0 error(s)`; `tests/storage-url.test.js` prints `10 passed, 0 failed`; `tests/durability.test.js` prints `N passed, 0 failed`; overall exit 0. (If `tests/run.js` does not yet enumerate `tests/storage-url.test.js`, confirm it globs `tests/*.test.js` so the new file is picked up automatically.)

- [ ] **Step 9: Commit.**
```
git add web/index.html tests/run.js
git commit -m "Repoint drainCaptures + capture-request/batch writers to Store; phase 3 gate green

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```


## Phase 4: One-time importer from legacy sharded-folder backup

## Phase 4: One-time importer from legacy sharded-folder backup

This phase builds `core/importer.js`: a pure mapper `mapLegacyKeys(dataJson)` plus a READ-ONLY `importLegacyBackup(srcDir, ctx)` that reads a legacy backup folder (`data.json` + `img-*.json` shards), writes rows and image files into the new store, verifies counts, and reports any cards whose image is missing. It then exposes `POST /api/import` and wires a Settings button (`Store.runImport(path)`) to trigger it.

**Legacy backup format (source of record — confirmed from the existing `index.html` `writeFullBackupDir`/`collectBackupMeta`):**
- `data.json` = `{ _app:"interests-app", _version:3, _exported, _counts:{imported,saved,likes,images}, shards:N, keys:{...} }`.
- `keys` values are **raw localStorage strings** (each is itself a JSON string): `keys.ia_imported` = JSON.stringify(cards array), `keys.ia_saved` = JSON.stringify(saved array), `keys.ia_settings` = JSON.stringify(settings object), and the remaining `ia_*` keys are arbitrary JSON strings.
- `img-0.json … img-(N-1).json` = each a flat JSON object map `{ "<cardId>": "data:image/jpeg;base64,…", … }`.

**Data-safety rule for this phase (non-negotiable):** the importer NEVER writes to, renames, or deletes anything under `srcDir`. It only reads. All writes go to the new store via `ctx`.

### Task 4.1: Pure key mapper `mapLegacyKeys`

**Files:**
- Create: `core/importer.js` (function `mapLegacyKeys` only; `importLegacyBackup` added in Task 4.2)
- Create: `tests/importer-map.test.js`

**Interfaces:**
- Consumes: nothing from earlier phases (pure JSON-in/JSON-out).
- Produces: `mapLegacyKeys(dataJson) -> { cards:array, saved:array, kv:object }` where `dataJson` is the parsed `data.json` object. `dataJson.keys.ia_imported` (a JSON string) → `cards` (parsed array); `dataJson.keys.ia_saved` → `saved` (parsed array); every OTHER `ia_*` key in `dataJson.keys` (including `ia_settings`) → `kv[key] = rawStringValue` (left as the raw string, since the kv store holds strings). Missing/blank keys default to `[]` / `{}`. Malformed `ia_imported`/`ia_saved` JSON → treated as `[]` (importer must not throw on a corrupt list).

- [ ] **Step 1: Write the failing test `tests/importer-map.test.js`.**

```js
const assert = require("assert");
const { mapLegacyKeys } = require("../core/importer");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

t("maps ia_imported -> cards (parsed array)", () => {
  const out = mapLegacyKeys({ keys: { ia_imported: JSON.stringify([{ id: "a", url: "u" }, { id: "b" }]) } });
  assert.deepStrictEqual(out.cards, [{ id: "a", url: "u" }, { id: "b" }]);
});

t("maps ia_saved -> saved (parsed array)", () => {
  const out = mapLegacyKeys({ keys: { ia_saved: JSON.stringify([{ id: "s1", url: "su" }]) } });
  assert.deepStrictEqual(out.saved, [{ id: "s1", url: "su" }]);
});

t("ia_settings goes into kv as the raw string", () => {
  const settingsStr = JSON.stringify({ dark: true });
  const out = mapLegacyKeys({ keys: { ia_settings: settingsStr } });
  assert.strictEqual(out.kv.ia_settings, settingsStr);
});

t("remaining ia_* keys go into kv as raw strings; not into cards/saved", () => {
  const out = mapLegacyKeys({ keys: {
    ia_imported: "[]",
    ia_saved: "[]",
    ia_settings: "{\"x\":1}",
    ia_feed: "[1,2,3]",
    ia_likes: "[\"a\"]",
    ia_hidden: "[]"
  } });
  assert.strictEqual(out.kv.ia_feed, "[1,2,3]");
  assert.strictEqual(out.kv.ia_likes, "[\"a\"]");
  assert.strictEqual(out.kv.ia_hidden, "[]");
  assert.strictEqual(out.kv.ia_settings, "{\"x\":1}");
  assert.strictEqual("ia_imported" in out.kv, false);
  assert.strictEqual("ia_saved" in out.kv, false);
});

t("missing keys default to [] / {} and never throw", () => {
  const out = mapLegacyKeys({});
  assert.deepStrictEqual(out.cards, []);
  assert.deepStrictEqual(out.saved, []);
  assert.deepStrictEqual(out.kv, {});
});

t("malformed ia_imported/ia_saved JSON -> [] (no throw)", () => {
  const out = mapLegacyKeys({ keys: { ia_imported: "{not json", ia_saved: "also broken" } });
  assert.deepStrictEqual(out.cards, []);
  assert.deepStrictEqual(out.saved, []);
});

t("ignores non-ia_ keys entirely", () => {
  const out = mapLegacyKeys({ keys: { ia_imported: "[]", junk: "x", other_thing: "y" } });
  assert.strictEqual("junk" in out.kv, false);
  assert.strictEqual("other_thing" in out.kv, false);
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run the test — expect FAIL** (`core/importer.js` does not exist yet, so `require` throws `Cannot find module '../core/importer'`).

```
node tests/importer-map.test.js
```

Expected: a thrown `MODULE_NOT_FOUND` error / non-zero exit before any "ok" lines print.

- [ ] **Step 3: Create `core/importer.js` with the minimal `mapLegacyKeys` implementation.**

```js
"use strict";

// Pure: parsed data.json -> { cards, saved, kv }.
// keys values are raw localStorage strings (each itself a JSON string).
// ia_imported -> cards (parsed array), ia_saved -> saved (parsed array),
// every other ia_* key (incl. ia_settings) -> kv[key] = raw string.
function safeParseArray(s) {
  if (typeof s !== "string" || !s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
}

function mapLegacyKeys(dataJson) {
  const keys = (dataJson && dataJson.keys) || {};
  const cards = safeParseArray(keys.ia_imported);
  const saved = safeParseArray(keys.ia_saved);
  const kv = {};
  for (const k of Object.keys(keys)) {
    if (!k.startsWith("ia_")) continue;
    if (k === "ia_imported" || k === "ia_saved") continue;
    kv[k] = keys[k];
  }
  return { cards: cards, saved: saved, kv: kv };
}

module.exports = { mapLegacyKeys: mapLegacyKeys };
```

- [ ] **Step 4: Run the test — expect PASS.**

```
node tests/importer-map.test.js
```

Expected: every line prints `ok`, final line `7 passed, 0 failed`, exit 0.

- [ ] **Step 5: Commit.**

```
git add core/importer.js tests/importer-map.test.js
git commit -m "Add mapLegacyKeys pure mapper for legacy backup import

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 4.2: `importLegacyBackup` — read shards, write rows + image files, verify counts

**Files:**
- Modify: `core/importer.js` (add `importLegacyBackup`; keep `mapLegacyKeys` from Task 4.1)
- Create: `tests/importer-int.test.js`

**Interfaces:**
- Consumes (from earlier phases, exact signatures):
  - `core/db.js`: `openDb(storeDir) -> Database`; `replaceCards(db, arr) -> void`; `replaceSaved(db, arr) -> void`; `setKV(db, key, value) -> void`; `counts(db) -> { cards, saved }`.
  - `core/images.js`: `putImg(storeDir, id, dataUrl) -> string` (writes `<id>.jpg`, returns the filename); `imageCount(storeDir) -> number`; `hasImg(storeDir, id) -> boolean`.
  - `core/config.js`: `getStorePath() -> string` (used by callers to build `ctx`; not required inside the importer).
  - `mapLegacyKeys(dataJson) -> { cards, saved, kv }` from Task 4.1.
- Produces: `importLegacyBackup(srcDir, ctx) -> { cards:number, saved:number, images:number, missing:array }` where:
  - `ctx = { db, storeDir }` (a `Database` opened on `storeDir`, plus the store dir string).
  - Reads `srcDir/data.json` and `srcDir/img-0.json … img-(shards-1).json`; READ-ONLY on `srcDir`.
  - Writes cards via `replaceCards`, saved via `replaceSaved`, kv via `setKV` (one call per kv key), and each shard image via `putImg(storeDir, id, dataUrl)`.
  - `cards`/`saved` = row counts written (from `counts(db)`); `images` = `imageCount(storeDir)`; `missing` = array of card ids whose card row exists but has NO image file on disk after import (cards that referenced an `idb:<id>` image but no shard supplied bytes). Cards with an http `img_url` and cards with empty images are NOT counted as missing.

- [ ] **Step 1: Write the failing integration test `tests/importer-int.test.js`.** It builds a tiny synthetic backup folder in `os.tmpdir()`, runs the importer into a fresh tmp store, and asserts rows, image files, counts, and an empty `missing`.

```js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { importLegacyBackup } = require("../core/importer");
const db = require("../core/db");
const images = require("../core/images");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

// 1x1 transparent PNG data URL — valid base64 image bytes.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function mkTmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// Build a synthetic legacy backup folder: data.json + one image shard.
const src = mkTmp("ia-src-");
const cards = [
  { id: "c1", url: "https://ex.com/1", platform: "fb", cat: "Saved", ts: 1000, img: "idb:c1" },   // has image in shard
  { id: "c2", url: "https://ex.com/2", platform: "fb", cat: "Saved", ts: 2000, img: "idb:c2" },   // image MISSING from shard
  { id: "c3", url: "https://ex.com/3", platform: "yt", cat: "Saved", ts: 3000, img: "https://ex.com/p.jpg" } // http url, not missing
];
const savedArr = [
  { id: "s1", url: "https://ex.com/s1", category: "Tips", clipped: 1, image: "idb:s1" }
];
const dataJson = {
  _app: "interests-app", _version: 3, _exported: "2026-06-26T00:00:00.000Z",
  _counts: { imported: 3, saved: 1, likes: 0, images: 2 },
  shards: 1,
  keys: {
    ia_imported: JSON.stringify(cards),
    ia_saved: JSON.stringify(savedArr),
    ia_settings: JSON.stringify({ dark: true }),
    ia_feed: JSON.stringify([1, 2, 3])
  }
};
fs.writeFileSync(path.join(src, "data.json"), JSON.stringify(dataJson));
// Shard supplies bytes for c1 and s1 only — NOT c2 (so c2 should land in missing).
fs.writeFileSync(path.join(src, "img-0.json"), JSON.stringify({ c1: PNG, s1: PNG }));

// Fresh tmp store.
const storeDir = mkTmp("ia-store-");
fs.mkdirSync(path.join(storeDir, "images"), { recursive: true });
const database = db.openDb(storeDir);
const ctx = { db: database, storeDir: storeDir };

const res = importLegacyBackup(src, ctx);

t("returns card/saved counts matching rows written", () => {
  assert.strictEqual(res.cards, 3);
  assert.strictEqual(res.saved, 1);
});

t("writes card rows into the db", () => {
  const c = db.counts(database);
  assert.strictEqual(c.cards, 3);
  assert.strictEqual(c.saved, 1);
});

t("writes image files for shard entries (c1, s1)", () => {
  assert.strictEqual(images.hasImg(storeDir, "c1"), true);
  assert.strictEqual(images.hasImg(storeDir, "s1"), true);
  assert.strictEqual(fs.existsSync(path.join(storeDir, "images", "c1.jpg")), true);
});

t("image count on disk equals files actually written (2: c1, s1)", () => {
  assert.strictEqual(res.images, 2);
  assert.strictEqual(images.imageCount(storeDir), 2);
});

t("missing lists card c2 (idb ref, no shard bytes) and ONLY c2", () => {
  assert.deepStrictEqual(res.missing.slice().sort(), ["c2"]);
});

t("c3 (http url image) is NOT reported missing", () => {
  assert.strictEqual(res.missing.includes("c3"), false);
});

t("kv settings + extra ia_* keys were written", () => {
  assert.strictEqual(db.getKV(database, "ia_settings"), JSON.stringify({ dark: true }));
  assert.strictEqual(db.getKV(database, "ia_feed"), JSON.stringify([1, 2, 3]));
});

t("READ-ONLY on srcDir: data.json + shard unchanged, no new files", () => {
  const names = fs.readdirSync(src).sort();
  assert.deepStrictEqual(names, ["data.json", "img-0.json"]);
  const dj = JSON.parse(fs.readFileSync(path.join(src, "data.json"), "utf8"));
  assert.strictEqual(dj.shards, 1);
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run the test — expect FAIL** (`importLegacyBackup` is not exported yet → `TypeError: importLegacyBackup is not a function`).

```
node tests/importer-int.test.js
```

Expected: throws before "ok" lines (or first assertion fails); non-zero exit.

- [ ] **Step 3: Add `importLegacyBackup` to `core/importer.js`.** Append the implementation and export it alongside `mapLegacyKeys`.

```js
"use strict";

const fs = require("fs");
const path = require("path");

const db = require("./db");
const images = require("./images");

// Pure: parsed data.json -> { cards, saved, kv }.
function safeParseArray(s) {
  if (typeof s !== "string" || !s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
}

function mapLegacyKeys(dataJson) {
  const keys = (dataJson && dataJson.keys) || {};
  const cards = safeParseArray(keys.ia_imported);
  const saved = safeParseArray(keys.ia_saved);
  const kv = {};
  for (const k of Object.keys(keys)) {
    if (!k.startsWith("ia_")) continue;
    if (k === "ia_imported" || k === "ia_saved") continue;
    kv[k] = keys[k];
  }
  return { cards: cards, saved: saved, kv: kv };
}

// True when a card's image reference points at the local file store (idb:<id>).
function isLocalImgRef(ref) {
  return typeof ref === "string" && ref.indexOf("idb:") === 0;
}

// One-time migration. READ-ONLY on srcDir. Writes rows + image files into ctx.
// ctx = { db, storeDir }. Returns { cards, saved, images, missing }.
function importLegacyBackup(srcDir, ctx) {
  const dataPath = path.join(srcDir, "data.json");
  const dataJson = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  const mapped = mapLegacyKeys(dataJson);

  // Rows first (transactions inside replaceCards/replaceSaved).
  db.replaceCards(ctx.db, mapped.cards);
  db.replaceSaved(ctx.db, mapped.saved);
  for (const key of Object.keys(mapped.kv)) {
    db.setKV(ctx.db, key, mapped.kv[key]);
  }

  // Unpack each shard: id -> dataURL written to images/<id>.jpg.
  const shardCount = (dataJson && typeof dataJson.shards === "number") ? dataJson.shards : 0;
  for (let i = 0; i < shardCount; i++) {
    const shardPath = path.join(srcDir, "img-" + i + ".json");
    if (!fs.existsSync(shardPath)) continue;
    let shard;
    try { shard = JSON.parse(fs.readFileSync(shardPath, "utf8")); }
    catch (e) { continue; }
    for (const id of Object.keys(shard)) {
      const dataUrl = shard[id];
      if (typeof dataUrl !== "string" || !dataUrl) continue;
      try { images.putImg(ctx.storeDir, id, dataUrl); } catch (e) { /* skip bad image */ }
    }
  }

  // Any card whose image is a local (idb:) ref but has no file on disk is "missing".
  const missing = [];
  for (const card of mapped.cards) {
    if (isLocalImgRef(card.img) && !images.hasImg(ctx.storeDir, card.id)) {
      missing.push(card.id);
    }
  }

  const c = db.counts(ctx.db);
  return {
    cards: c.cards,
    saved: c.saved,
    images: images.imageCount(ctx.storeDir),
    missing: missing
  };
}

module.exports = { mapLegacyKeys: mapLegacyKeys, importLegacyBackup: importLegacyBackup };
```

- [ ] **Step 4: Run the test — expect PASS.**

```
node tests/importer-int.test.js
```

Expected: every line prints `ok`, final line `8 passed, 0 failed`, exit 0.

- [ ] **Step 5: Run the full suite to confirm no regressions** (importer tests now wired in via `tests/run.js`; existing `syntax-check` + `durability` must still pass). better-sqlite3 here runs under plain Node ABI — packaging will re-run electron-rebuild for the Electron ABI; this dev run does not need it.

```
node tests/run.js
```

Expected: `syntax-check`, `durability.test.js`, `importer-map.test.js`, and `importer-int.test.js` all pass; overall exit 0.

- [ ] **Step 6: Commit.**

```
git add core/importer.js tests/importer-int.test.js
git commit -m "Add importLegacyBackup: read shards, write rows+image files, verify counts

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 4.3: `POST /api/import` endpoint

**Files:**
- Modify: `core/server.js` (add `POST /api/import` route to the `createServer(ctx)` factory)
- Create: `tests/importer-api.test.js`

**Interfaces:**
- Consumes:
  - `core/server.js`: `createServer(ctx) -> express.App` (pure factory, no `listen`) where `ctx = { db, storeDir, getStorePath, setStorePath }`.
  - `core/importer.js`: `importLegacyBackup(srcDir, ctx) -> { cards, saved, images, missing }` from Task 4.2.
- Produces: `POST /api/import { srcDir } -> { cards, saved, images, missing }` (the importer result verbatim, JSON). On a read failure (e.g. `srcDir/data.json` absent) responds HTTP 400 `{ error: <message> }`. The route calls `importLegacyBackup(srcDir, { db: ctx.db, storeDir: ctx.storeDir })`.

- [ ] **Step 1: Write the failing test `tests/importer-api.test.js`.** It builds a synthetic backup folder + a tmp store, mounts `createServer` on port 0, and POSTs `srcDir` via global `fetch`.

```js
const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createServer } = require("../core/server");
const db = require("../core/db");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
function mkTmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// Synthetic backup folder.
const src = mkTmp("ia-apisrc-");
const dataJson = {
  _app: "interests-app", _version: 3, shards: 1,
  _counts: { imported: 1, saved: 0, likes: 0, images: 1 },
  keys: {
    ia_imported: JSON.stringify([{ id: "c1", url: "https://ex.com/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" }]),
    ia_saved: JSON.stringify([]),
    ia_settings: JSON.stringify({ dark: false })
  }
};
fs.writeFileSync(path.join(src, "data.json"), JSON.stringify(dataJson));
fs.writeFileSync(path.join(src, "img-0.json"), JSON.stringify({ c1: PNG }));

// Tmp store + server.
const storeDir = mkTmp("ia-apistore-");
fs.mkdirSync(path.join(storeDir, "images"), { recursive: true });
const database = db.openDb(storeDir);
const app = createServer({ db: database, storeDir: storeDir, getStorePath: () => storeDir, setStorePath: () => {} });
const server = http.createServer(app);

async function run() {
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const port = server.address().port;
  const base = "http://127.0.0.1:" + port;

  const ok = await fetch(base + "/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ srcDir: src })
  });
  const body = await ok.json();

  t("POST /api/import returns 200", () => { assert.strictEqual(ok.status, 200); });
  t("body reports 1 card, 0 saved, 1 image, empty missing", () => {
    assert.strictEqual(body.cards, 1);
    assert.strictEqual(body.saved, 0);
    assert.strictEqual(body.images, 1);
    assert.deepStrictEqual(body.missing, []);
  });
  t("rows landed: GET /api/cards returns the imported card", async () => {
    const r = await fetch(base + "/api/cards");
    const j = await r.json();
    assert.strictEqual(j.cards.length, 1);
    assert.strictEqual(j.cards[0].id, "c1");
  });

  // Bad srcDir (no data.json) -> 400.
  const badDir = mkTmp("ia-apibad-");
  const bad = await fetch(base + "/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ srcDir: badDir })
  });
  t("missing data.json -> HTTP 400 with error", async () => {
    assert.strictEqual(bad.status, 400);
    const bj = await bad.json();
    assert.strictEqual(typeof bj.error, "string");
  });

  await new Promise((res) => server.close(res));
  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}
run();
```

- [ ] **Step 2: Run the test — expect FAIL** (no `/api/import` route yet → the POST returns 404, so the 200 assertion fails; final line shows failures, exit 1).

```
node tests/importer-api.test.js
```

Expected: `POST /api/import returns 200` and the body asserts FAIL; non-zero exit.

- [ ] **Step 3: Add the route inside `createServer(ctx)` in `core/server.js`.** Place it alongside the other JSON routes (after `express.json()` body parsing is registered). Require the importer at the top of the file.

```js
const { importLegacyBackup } = require("./importer");
```

```js
  // One-time legacy backup import. READ-ONLY on srcDir.
  app.post("/api/import", (req, res) => {
    const srcDir = req.body && req.body.srcDir;
    if (!srcDir || typeof srcDir !== "string") {
      return res.status(400).json({ error: "srcDir required" });
    }
    try {
      const out = importLegacyBackup(srcDir, { db: ctx.db, storeDir: ctx.storeDir });
      res.json(out);
    } catch (e) {
      res.status(400).json({ error: String(e && e.message ? e.message : e) });
    }
  });
```

- [ ] **Step 4: Run the test — expect PASS.**

```
node tests/importer-api.test.js
```

Expected: every line prints `ok`, final line `4 passed, 0 failed`, exit 0.

- [ ] **Step 5: Run the full suite to confirm no regressions.**

```
node tests/run.js
```

Expected: all test files pass; overall exit 0.

- [ ] **Step 6: Commit.**

```
git add core/server.js tests/importer-api.test.js
git commit -m "Add POST /api/import endpoint wiring importLegacyBackup

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 4.4: Browser adapter `Store.runImport` + Settings trigger

**Files:**
- Modify: `web/storage.js` (add `Store.runImport(srcDir)`)
- Modify: `web/index.html` (Settings: add an "Import legacy backup…" button whose handler picks a folder via `preload` and calls `Store.runImport(path)`, then shows the result counts)

**Interfaces:**
- Consumes:
  - REST: `POST /api/import { srcDir } -> { cards, saved, images, missing }` from Task 4.3.
  - `preload.js` native folder picker exposed on the app window (e.g. `window.app.pickFolder() -> Promise<string|null>` — the OS dialog bridge added in the Electron-shell phase). If unavailable, the handler prompts for a path string so the wiring is still testable without Electron.
- Produces: `Store.runImport(srcDir) -> Promise<{ cards, saved, images, missing }>` on the global `Store` adapter; a Settings button `#btnImportLegacy` that triggers it and renders a one-line result (`"<cards> cards, <saved> saved, <images> images — <missing.length> missing"`).

- [ ] **Step 1: Add `runImport` to `web/storage.js`.** Place it with the other backup/store actions (`backupNow`, `listBackups`, `restore`, `storeLocation`, `moveStore`).

```js
  async runImport(srcDir) {
    const r = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ srcDir: srcDir })
    });
    if (!r.ok) {
      let msg = "Import failed";
      try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (e) {}
      throw new Error(msg);
    }
    return r.json();
  },
```

- [ ] **Step 2: Verify the syntax gate still passes** (`tests/syntax-check.js` parses every inline `<script>` in `index.html`; `web/storage.js` is its own file, but run the suite to confirm nothing broke). Expect PASS.

```
node tests/run.js
```

Expected: all test files pass; overall exit 0.

- [ ] **Step 3: Add the Settings button to `web/index.html`.** In the Settings/Data section markup (next to the existing backup controls), add the button.

```html
<button id="btnImportLegacy" class="btn">Import legacy backup…</button>
<span id="importLegacyResult" class="muted"></span>
```

- [ ] **Step 4: Add the button handler in `web/index.html`.** Wire it to pick a folder (native bridge if present, else a `prompt`) and call `Store.runImport`. Place this in the Settings init code where other buttons are bound.

```js
(function bindImportLegacy(){
  var btn = document.getElementById("btnImportLegacy");
  if(!btn) return;
  btn.addEventListener("click", async function(){
    var out = document.getElementById("importLegacyResult");
    var srcDir = null;
    try {
      if (window.app && typeof window.app.pickFolder === "function") {
        srcDir = await window.app.pickFolder();
      } else {
        srcDir = window.prompt("Path to legacy backup folder (contains data.json):");
      }
    } catch(e) { srcDir = null; }
    if(!srcDir){ return; }
    if(out){ out.textContent = "Importing…"; }
    try {
      var res = await Store.runImport(srcDir);
      if(out){
        out.textContent = res.cards + " cards, " + res.saved + " saved, " +
          res.images + " images — " + (res.missing ? res.missing.length : 0) + " missing";
      }
    } catch(e) {
      if(out){ out.textContent = "Import failed: " + (e && e.message ? e.message : e); }
    }
  });
})();
```

- [ ] **Step 5: Run the syntax gate / full suite — expect PASS** (the new inline `<script>` block must parse; this is the gate `tests/syntax-check.js` enforces).

```
node tests/run.js
```

Expected: `syntax-check` reports the script blocks parse with 0 errors; all test files pass; overall exit 0.

- [ ] **Step 6: Commit.**

```
git add web/storage.js web/index.html
git commit -m "Add Store.runImport and Settings import-legacy-backup trigger

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```


## Phase 5: Capture bridge over HTTP (service queue + extension switch)

### Task 5.1: Capture-queue endpoints (POST/GET /api/captures, drain semantics)

**Files:**
- Modify: `core/server.js` (the `createServer(ctx)` factory — add `POST /api/captures` and `GET /api/captures` route handlers)
- Create: `tests/service-captures.test.js`

**Interfaces:**
- Consumes (from Phase 1/2): `createServer(ctx)->express.App` where `ctx={db, storeDir, getStorePath, setStorePath}`; `core/db.js` exports `openDb(storeDir)->Database`, `getKV(db,key)->string|null`, `setKV(db,key,value)->void`.
- Consumes (Node built-ins / globals): `require('http').createServer`, global `fetch`, `require('assert')`, `require('fs')`, `require('os')`, `require('path')`.
- Produces: `POST /api/captures` (body `{capture}` → appends to kv `ia_capture_queue`, returns `{ok:true}`); `GET /api/captures` (returns `{captures:[...]}` AND clears kv `ia_capture_queue`). The queue is a JSON array stored under kv key `ia_capture_queue`; an absent/invalid key reads as `[]`.

- [ ] **Step 1: Write the failing test file `tests/service-captures.test.js`.** This test mounts the real Express app on an ephemeral port (port 0), uses global `fetch`, and covers the capture-queue contract: POST two captures, GET returns both in order, a second GET returns empty.

```js
const assert = require("assert");
const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { openDb } = require("../core/db");
const { createServer } = require("../core/server");

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.stack || e)); } }

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-cap-"));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}

// Mount createServer() on an ephemeral port; return {base, close, db, storeDir}.
function mount(storeDir) {
  const db = openDb(storeDir);
  const app = createServer({
    db, storeDir,
    getStorePath: () => storeDir,
    setStorePath: () => {},
  });
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: "http://127.0.0.1:" + port,
        db, storeDir,
        close: () => new Promise((r) => server.close(() => { try { db.close(); } catch (e) {} r(); })),
      });
    });
  });
}

(async () => {
  await t("POST two captures then GET returns both; second GET returns empty", async () => {
    const storeDir = tmpStore();
    const m = await mount(storeDir);
    try {
      const a = { url: "https://example.com/a", id: "card-a", screenshot: "data:image/jpeg;base64,AAAA", ts: 1 };
      const b = { url: "https://example.com/b", id: "card-b", screenshot: "data:image/jpeg;base64,BBBB", ts: 2 };

      let r = await fetch(m.base + "/api/captures", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capture: a }),
      });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(await r.json(), { ok: true });

      r = await fetch(m.base + "/api/captures", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capture: b }),
      });
      assert.deepStrictEqual(await r.json(), { ok: true });

      r = await fetch(m.base + "/api/captures");
      const got = await r.json();
      assert.strictEqual(got.captures.length, 2);
      assert.strictEqual(got.captures[0].url, "https://example.com/a");
      assert.strictEqual(got.captures[1].url, "https://example.com/b");

      // the drain cleared the queue — a second GET is empty
      r = await fetch(m.base + "/api/captures");
      assert.deepStrictEqual(await r.json(), { captures: [] });
    } finally { await m.close(); }
  });

  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run the test and confirm it FAILS.** The `/api/captures` routes do not exist yet, so GET returns Express's 404 HTML and `r.json()` throws (or `captures` is undefined).

```
node tests/service-captures.test.js
```
Expected: `FAIL POST two captures then GET returns both; second GET returns empty — ...` followed by `0 passed, 1 failed` and a non-zero exit.

- [ ] **Step 3: Add the capture-queue helpers + routes to `core/server.js`.** Locate the `createServer(ctx)` factory and the line where `ctx` is destructured / `app` and the db helpers are in scope (the other `/api/...` routes are registered there). Add these two routes alongside the existing storage routes. Use the exact `getKV`/`setKV` names from `core/db.js`.

```js
  // --- Capture queue (persisted in kv key ia_capture_queue) ---
  // The app drains exactly like the old localStorage `ia_captures`: GET returns
  // the queued captures AND clears them, so each capture is delivered once.
  function readCaptureQueue() {
    const raw = getKV(ctx.db, "ia_capture_queue");
    if (!raw) return [];
    try { const q = JSON.parse(raw); return Array.isArray(q) ? q : []; }
    catch (e) { return []; }
  }

  app.post("/api/captures", (req, res) => {
    const capture = req.body && req.body.capture;
    if (!capture || typeof capture !== "object") {
      return res.status(400).json({ ok: false, error: "missing capture" });
    }
    const q = readCaptureQueue();
    q.push(capture);
    setKV(ctx.db, "ia_capture_queue", JSON.stringify(q));
    res.json({ ok: true });
  });

  app.get("/api/captures", (req, res) => {
    const q = readCaptureQueue();
    if (q.length) setKV(ctx.db, "ia_capture_queue", JSON.stringify([]));
    res.json({ captures: q });
  });
```

If `getKV`/`setKV` are not already imported at the top of `core/server.js`, add them to the existing `require("./db")` destructure (e.g. `const { getKV, setKV } = require("./db");`). If `express.json()` body parsing is not already mounted (it should be from Phase 1's `kv`/`cards` PUT routes), ensure `app.use(express.json({ limit: "60mb" }))` is present before these routes — captures carry base64 screenshots, so the limit must be generous.

- [ ] **Step 4: Run the test and confirm it PASSES.**

```
node tests/service-captures.test.js
```
Expected: `ok  POST two captures then GET returns both; second GET returns empty` and `1 passed, 0 failed`, exit 0.

- [ ] **Step 5: Commit.**

```
git add core/server.js tests/service-captures.test.js
git commit -m "Add /api/captures queue endpoints (append + drain via ia_capture_queue kv)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5.2: Capture-request and batch state/progress endpoints

**Files:**
- Modify: `core/server.js` (the `createServer(ctx)` factory — add `capture-request`, `batch-state`, `batch-progress` GET/POST handlers)
- Modify: `tests/service-captures.test.js` (add capture-request round-trip test)

**Interfaces:**
- Consumes: `getKV(ctx.db, key)->string|null`, `setKV(ctx.db, key, value)->void` from `core/db.js`; the `mount(storeDir)` helper already defined in `tests/service-captures.test.js`.
- Produces:
  - `GET /api/capture-request -> {request: <obj>|null}` (reads kv `ia_capture_request`); `POST /api/capture-request {request} -> {ok:true}` (writes kv `ia_capture_request`; a `null`/absent `request` clears it).
  - `GET /api/batch-state -> {state: <obj>|null}` (kv `ia_batch_state`); `POST /api/batch-state {state} -> {ok:true}`.
  - `GET /api/batch-progress -> {progress: <obj>|null}` (kv `ia_batch_progress`); `POST /api/batch-progress {progress} -> {ok:true}`.

- [ ] **Step 1: Add a failing capture-request round-trip test to `tests/service-captures.test.js`.** Insert this second `await t(...)` block immediately after the first `await t(...)` block (before the `console.log(pass + ...)` line).

```js
  await t("capture-request POST then GET returns it; POST null clears it", async () => {
    const storeDir = tmpStore();
    const m = await mount(storeDir);
    try {
      // empty store -> null
      let r = await fetch(m.base + "/api/capture-request");
      assert.deepStrictEqual(await r.json(), { request: null });

      const reqObj = { url: "https://example.com/p", id: "card-p", delay: 3000, render: false };
      r = await fetch(m.base + "/api/capture-request", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: reqObj }),
      });
      assert.deepStrictEqual(await r.json(), { ok: true });

      r = await fetch(m.base + "/api/capture-request");
      const got = await r.json();
      assert.strictEqual(got.request.url, "https://example.com/p");
      assert.strictEqual(got.request.id, "card-p");

      // POST null clears it
      r = await fetch(m.base + "/api/capture-request", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request: null }),
      });
      assert.deepStrictEqual(await r.json(), { ok: true });
      r = await fetch(m.base + "/api/capture-request");
      assert.deepStrictEqual(await r.json(), { request: null });
    } finally { await m.close(); }
  });

  await t("batch-state and batch-progress round-trip", async () => {
    const storeDir = tmpStore();
    const m = await mount(storeDir);
    try {
      let r = await fetch(m.base + "/api/batch-state");
      assert.deepStrictEqual(await r.json(), { state: null });
      r = await fetch(m.base + "/api/batch-progress");
      assert.deepStrictEqual(await r.json(), { progress: null });

      const state = { items: [{ url: "u1", id: "i1" }], next: 0, total: 1, concurrency: 2 };
      r = await fetch(m.base + "/api/batch-state", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
      });
      assert.deepStrictEqual(await r.json(), { ok: true });
      r = await fetch(m.base + "/api/batch-state");
      assert.deepStrictEqual((await r.json()).state.total, 1);

      const progress = { done: 1, total: 1, active: false, ts: 123 };
      r = await fetch(m.base + "/api/batch-progress", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ progress }),
      });
      assert.deepStrictEqual(await r.json(), { ok: true });
      r = await fetch(m.base + "/api/batch-progress");
      assert.deepStrictEqual((await r.json()).progress.done, 1);
    } finally { await m.close(); }
  });
```

- [ ] **Step 2: Run the test and confirm the new cases FAIL.** The capture-request / batch routes don't exist, so the GETs 404 and `r.json()` mismatches.

```
node tests/service-captures.test.js
```
Expected: the first test still `ok`, but `FAIL capture-request POST then GET returns it; POST null clears it` and `FAIL batch-state and batch-progress round-trip`, ending `1 passed, 2 failed`, non-zero exit.

- [ ] **Step 3: Add the capture-request and batch routes to `core/server.js`.** Add immediately after the `/api/captures` routes from Task 5.1. Each GET parses the stored JSON (returning `null` on absent/invalid); each POST stringifies and stores (a falsy payload clears the key).

```js
  // --- Single capture request (kv ia_capture_request) ---
  function readJsonKV(key) {
    const raw = getKV(ctx.db, key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  app.get("/api/capture-request", (req, res) => {
    res.json({ request: readJsonKV("ia_capture_request") });
  });
  app.post("/api/capture-request", (req, res) => {
    const request = req.body && req.body.request;
    if (request == null) setKV(ctx.db, "ia_capture_request", "");
    else setKV(ctx.db, "ia_capture_request", JSON.stringify(request));
    res.json({ ok: true });
  });

  // --- Batch driver state (kv ia_batch_state) ---
  app.get("/api/batch-state", (req, res) => {
    res.json({ state: readJsonKV("ia_batch_state") });
  });
  app.post("/api/batch-state", (req, res) => {
    const state = req.body && req.body.state;
    if (state == null) setKV(ctx.db, "ia_batch_state", "");
    else setKV(ctx.db, "ia_batch_state", JSON.stringify(state));
    res.json({ ok: true });
  });

  // --- Batch progress (kv ia_batch_progress) ---
  app.get("/api/batch-progress", (req, res) => {
    res.json({ progress: readJsonKV("ia_batch_progress") });
  });
  app.post("/api/batch-progress", (req, res) => {
    const progress = req.body && req.body.progress;
    if (progress == null) setKV(ctx.db, "ia_batch_progress", "");
    else setKV(ctx.db, "ia_batch_progress", JSON.stringify(progress));
    res.json({ ok: true });
  });
```

Note: `setKV(db, key, "")` writes an empty string, which `readJsonKV` treats as absent (`!raw` → `null`) — so a cleared key correctly reads back as `null`.

- [ ] **Step 4: Run the test and confirm all cases PASS.**

```
node tests/service-captures.test.js
```
Expected: three `ok` lines and `3 passed, 0 failed`, exit 0.

- [ ] **Step 5: Commit.**

```
git add core/server.js tests/service-captures.test.js
git commit -m "Add capture-request + batch-state/progress endpoints (kv-backed)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5.3: Queue persistence across a new createServer() on the same store

**Files:**
- Modify: `tests/service-captures.test.js` (add a persistence test that closes the server, reopens a fresh `createServer()` on the same store dir, and asserts the queue survived)

**Interfaces:**
- Consumes: the `mount(storeDir)`/`tmpStore()` helpers already in `tests/service-captures.test.js`; `POST /api/captures` and `GET /api/captures` from Task 5.1 (queue persisted in kv `ia_capture_queue`, which lives in `interests.db` on disk).
- Produces: a regression guard proving the queue is durable (on-disk SQLite kv, not in-memory) — a capture POSTed to one server instance is drained by a later instance opened on the same store directory.

- [ ] **Step 1: Add the failing persistence test to `tests/service-captures.test.js`.** Insert this `await t(...)` block after the batch round-trip block (before the final `console.log`). It mounts a server, POSTs a capture, fully closes it (server + db), then mounts a brand-new `createServer()` on the SAME `storeDir` and drains.

```js
  await t("queue persists across a new createServer() on the same store", async () => {
    const storeDir = tmpStore();

    // first server instance: enqueue one capture, then close everything
    const m1 = await mount(storeDir);
    const cap = { url: "https://example.com/persist", id: "card-persist", screenshot: "data:image/jpeg;base64,CCCC", ts: 9 };
    let r = await fetch(m1.base + "/api/captures", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capture: cap }),
    });
    assert.deepStrictEqual(await r.json(), { ok: true });
    await m1.close();   // closes the http server AND the sqlite db (flushes to disk)

    // a fresh createServer() / openDb() on the same store sees the queued capture
    const m2 = await mount(storeDir);
    try {
      r = await fetch(m2.base + "/api/captures");
      const got = await r.json();
      assert.strictEqual(got.captures.length, 1);
      assert.strictEqual(got.captures[0].url, "https://example.com/persist");
      assert.strictEqual(got.captures[0].id, "card-persist");
      // drained — the second instance's queue is now empty
      r = await fetch(m2.base + "/api/captures");
      assert.deepStrictEqual(await r.json(), { captures: [] });
    } finally { await m2.close(); }
  });
```

- [ ] **Step 2: Run the test and confirm the new case PASSES (or diagnose if it fails).** Because Task 5.1 stores the queue in the on-disk SQLite `kv` table (WAL mode), re-opening the same store reads it back — this should pass immediately, proving durability. Run it to confirm.

```
node tests/service-captures.test.js
```
Expected: four `ok` lines including `ok  queue persists across a new createServer() on the same store`, and `4 passed, 0 failed`, exit 0.

If it FAILS with `captures.length === 0`, the queue was held in memory rather than persisted — fix Task 5.1's `readCaptureQueue`/`POST` to read and write through `getKV`/`setKV` (the on-disk kv table) rather than a module-level variable, then re-run.

- [ ] **Step 3: Commit.**

```
git add tests/service-captures.test.js
git commit -m "Test: capture queue persists across a fresh createServer() on the same store

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5.4: Extension HTTP bridge module with port probing + queue fallback (`extension/bridge.js`)

**Files:**
- Modify: `extension/bridge.js` (replace the whole localStorage-tab bridge body with an HTTP bridge: probe `[3456..3465]` via `GET /api/ping`, then POST/GET against the found port; keep a `chrome.storage.local` queue fallback)

**Interfaces:**
- Consumes (Core service, from earlier tasks/phases): `GET /api/ping -> {app:"interests", version}`; `POST /api/captures {capture} -> {ok}`; `GET /api/capture-request -> {request|null}`; `GET /api/batch-state -> {state|null}`; `POST /api/batch-progress {progress} -> {ok}`; `POST /api/batch-state {state} -> {ok}`.
- Consumes (extension runtime): `chrome.runtime.sendMessage({action:"captureRequest", data})`, `chrome.runtime.sendMessage({action:"getQueue"}, cb)` → `{queue}`, `chrome.runtime.sendMessage({action:"clearQueue"})`, `chrome.runtime.sendMessage({action:"captureOneTab", data:{url,id,delay,render}}, cb)`, `chrome.runtime.sendMessage({action:"cleanupBatch"})`, and `chrome.storage.local` get/set on key `ia_capture_queue`.
- Produces (global, for `background.js` reuse): `window.IA_BRIDGE = { findPort, postCapture, getJson }` where `findPort()->Promise<number|null>` (cached), `postCapture(capture)->Promise<boolean>` (POSTs to `/api/captures`; on failure stashes into `chrome.storage.local` `ia_capture_queue`), `getJson(path)->Promise<object|null>`.

- [ ] **Step 1: Write a minimal failing Node test `tests/bridge-port.test.js` for the pure port-probe helper.** The bridge runs in a browser content-script context (no `chrome` in Node), so we test only the framework-free `probePorts` helper by requiring it through a tiny export shim. First write the test, expecting `probePorts` to return the first port whose ping resolves to `{app:"interests"}`.

```js
const assert = require("assert");
const http = require("http");
const { probePorts } = require("../extension/bridge-probe");

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.stack || e)); } }

// stand up a fake /api/ping on a chosen port within the probe range
function pingServer(port) {
  return new Promise((resolve, reject) => {
    const s = http.createServer((req, res) => {
      if (req.url === "/api/ping") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ app: "interests", version: "test" })); }
      else { res.statusCode = 404; res.end(); }
    });
    s.on("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}

(async () => {
  await t("probePorts finds the first responding interests port", async () => {
    // find a free port inside [3456..3465] by trying to bind 3460
    let srv;
    try { srv = await pingServer(3460); } catch (e) { console.log("  skip (3460 busy)"); pass++; return; }
    try {
      const port = await probePorts([3456, 3457, 3458, 3459, 3460, 3461], { fetchImpl: (await import("node-fetch").catch(() => ({ default: fetch }))).default });
      assert.strictEqual(port, 3460);
    } finally { srv.close(); }
  });

  await t("probePorts returns null when nothing responds", async () => {
    const port = await probePorts([3466, 3467], { fetchImpl: fetch });
    assert.strictEqual(port, null);
  });

  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run the test and confirm it FAILS.** `extension/bridge-probe.js` does not exist yet.

```
node tests/bridge-port.test.js
```
Expected: `Cannot find module '../extension/bridge-probe'` → process throws / `0 passed, 1 failed`, non-zero exit.

- [ ] **Step 3: Create the pure, dependency-free probe helper `extension/bridge-probe.js`.** It accepts an injected `fetchImpl` (so Node tests pass `fetch` / browser passes the global), and is also `require`-able as a CommonJS module without touching `chrome`.

```js
// Pure port-probe helper shared by bridge.js (browser) and tests (Node).
// Tries each port's GET /api/ping; resolves to the first that answers
// {app:"interests"}, or null if none do. No `chrome`/DOM references.
async function probePorts(ports, opts) {
  const f = (opts && opts.fetchImpl) || (typeof fetch !== "undefined" ? fetch : null);
  if (!f) return null;
  for (let i = 0; i < ports.length; i++) {
    const port = ports[i];
    try {
      const ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
      const tm = ctl ? setTimeout(() => ctl.abort(), 600) : null;
      let r;
      try { r = await f("http://127.0.0.1:" + port + "/api/ping", ctl ? { signal: ctl.signal } : undefined); }
      finally { if (tm) clearTimeout(tm); }
      if (!r || !r.ok) continue;
      const j = await r.json();
      if (j && j.app === "interests") return port;
    } catch (e) { /* port not listening / not us — try next */ }
  }
  return null;
}

const PORT_RANGE = [3456, 3457, 3458, 3459, 3460, 3461, 3462, 3463, 3464, 3465];

if (typeof module !== "undefined" && module.exports) {
  module.exports = { probePorts, PORT_RANGE };
}
```

- [ ] **Step 4: Run the test and confirm it PASSES.**

```
node tests/bridge-port.test.js
```
Expected: `ok  probePorts finds the first responding interests port`, `ok  probePorts returns null when nothing responds`, `2 passed, 0 failed`, exit 0.

- [ ] **Step 5: Rewrite `extension/bridge.js` to deliver/poll over HTTP using the probe helper, keeping the `chrome.storage.local` queue fallback.** Replace the ENTIRE file contents with the HTTP bridge below. It loads `bridge-probe.js`'s `probePorts`/`PORT_RANGE` (the manifest must list `bridge-probe.js` before `bridge.js` — done in the next step), caches the found port, flushes the offline queue on reconnect, and drives the batch by polling `/api/batch-state` and POSTing `/api/batch-progress`.

```js
(function () {
  // Port-probe helpers come from bridge-probe.js (loaded before this file).
  var PORT_RANGE = (typeof self !== "undefined" && self.IA_PORT_RANGE) || [3456,3457,3458,3459,3460,3461,3462,3463,3464,3465];
  var probePorts = (typeof self !== "undefined" && self.IA_probePorts) || function () { return Promise.resolve(null); };

  var alive = true;
  var requestInterval, pullInterval;
  var cachedPort = null;

  function log(msg) { console.log("[Interests Bridge]", msg); }

  function die(reason) {
    if (!alive) return;
    alive = false;
    clearInterval(requestInterval);
    clearInterval(pullInterval);
    log("Stopped: " + reason + " — reload this page to reconnect");
  }

  function isDisconnected() {
    try {
      if (!chrome.runtime || !chrome.runtime.id) { die("extension unloaded"); return true; }
      return false;
    } catch (e) { die(e.message); return true; }
  }

  // Resolve (and cache) the app's port. Re-probes if a cached port goes silent.
  async function findPort() {
    if (cachedPort != null) {
      try {
        const r = await fetch("http://127.0.0.1:" + cachedPort + "/api/ping");
        if (r.ok) { const j = await r.json(); if (j && j.app === "interests") return cachedPort; }
      } catch (e) {}
      cachedPort = null;   // stale — fall through to a fresh probe
    }
    const p = await probePorts(PORT_RANGE, { fetchImpl: fetch });
    cachedPort = p;
    return p;
  }

  async function getJson(path) {
    const port = await findPort();
    if (port == null) return null;
    try {
      const r = await fetch("http://127.0.0.1:" + port + path);
      if (!r.ok) return null;
      return await r.json();
    } catch (e) { cachedPort = null; return null; }
  }

  async function postJson(path, body) {
    const port = await findPort();
    if (port == null) return false;
    try {
      const r = await fetch("http://127.0.0.1:" + port + path, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      return !!(r && r.ok);
    } catch (e) { cachedPort = null; return false; }
  }

  // Deliver one capture over HTTP; on failure, stash it in chrome.storage.local
  // so it's flushed when the app is next reachable (the offline fallback).
  async function postCapture(capture) {
    const ok = await postJson("/api/captures", { capture: capture });
    if (!ok) {
      try {
        const stored = await chrome.storage.local.get("ia_capture_queue");
        let q = stored.ia_capture_queue || [];
        if (!Array.isArray(q)) q = [];
        q.push(capture);
        if (q.length > 200) q = q.slice(-200);
        await chrome.storage.local.set({ ia_capture_queue: q });
      } catch (e) {}
    }
    return ok;
  }

  // expose for background.js (it imports this page-context helper indirectly via
  // its own copy; here we publish for any same-context caller / tests)
  try { self.IA_BRIDGE = { findPort: findPort, getJson: getJson, postJson: postJson, postCapture: postCapture }; } catch (e) {}

  // ---- poll the app for a single capture request ----
  async function checkForRequest() {
    if (isDisconnected()) return;
    try {
      const j = await getJson("/api/capture-request");
      if (j && j.request && j.request.url) {
        await postJson("/api/capture-request", { request: null });   // claim it (clear server-side)
        const req = j.request;
        log("Forwarding capture request: " + req.url);
        chrome.runtime.sendMessage({ action: "captureRequest", data: req }, function () {
          if (chrome.runtime.lastError) log("sendMessage error: " + chrome.runtime.lastError.message);
        });
      }
      await driveBatch();
    } catch (e) {
      if (/invalidated|disconnected/i.test(e.message || "")) die(e.message);
      else log("checkForRequest error: " + (e.message || e));
    }
  }

  // ---- flush the background SW's offline queue into the app over HTTP ----
  async function pullCaptures() {
    if (isDisconnected()) return;
    const port = await findPort();
    if (port == null) return;   // app not reachable — hold the queue
    try {
      chrome.runtime.sendMessage({ action: "getQueue" }, async function (resp) {
        if (chrome.runtime.lastError) {
          if (/invalidated|disconnected/i.test(chrome.runtime.lastError.message)) die(chrome.runtime.lastError.message);
          return;
        }
        if (!resp || !resp.queue || !resp.queue.length) return;
        log("Flushing " + resp.queue.length + " queued capture(s) over HTTP");
        let allOk = true;
        for (let i = 0; i < resp.queue.length; i++) {
          const ok = await postJson("/api/captures", { capture: resp.queue[i] });
          if (!ok) { allOk = false; break; }
        }
        if (allOk) chrome.runtime.sendMessage({ action: "clearQueue" }, function () { if (chrome.runtime.lastError) {} });
      });
    } catch (e) {
      if (/invalidated|disconnected/i.test(e.message || "")) die(e.message);
    }
  }

  // ---- batch driver (loop lives here, in the stable page context) ----
  // Reads ia_batch_state from the app via /api/batch-state; reports progress via
  // /api/batch-progress; serializes captures through the background worker.
  var B = null, inFlight = 0;
  async function writeProg(done, total, active) {
    await postJson("/api/batch-progress", { done: done, total: total, active: active, ts: Date.now() });
  }
  async function saveState() {
    if (!B) return;
    await postJson("/api/batch-state", { state: { items: B.items, next: B.next, done: B.done, total: B.total, delay: B.delay, concurrency: B.conc, render: B.render, active: true } });
  }
  async function endBatch() {
    var done = B ? B.done : 0, total = B ? B.total : 0;
    B = null; inFlight = 0;
    await writeProg(done, total, false);
    await postJson("/api/batch-state", { state: null });
    try { chrome.runtime.sendMessage({ action: "cleanupBatch" }, function () {}); } catch (e) {}
    log("Batch finished " + done + "/" + total);
  }
  async function driveBatch() {
    if (isDisconnected()) return;
    if (!B) {
      const j = await getJson("/api/batch-state");
      const st = j && j.state;
      if (!st || !st.items || !st.items.length) return;
      var startAt = (typeof st.next === "number") ? st.next : (st.done || 0);
      if (startAt >= st.items.length) { await postJson("/api/batch-state", { state: null }); return; }
      B = { items: st.items, next: startAt, done: st.done || 0, total: st.items.length, delay: st.delay || 0, conc: Math.max(1, Math.min(10, st.concurrency || 1)), render: !!st.render };
      log("Batch start: " + B.total + " items, concurrency " + B.conc);
    }
    pump();
  }
  function pump() {
    if (!B) return;
    if (B.next >= B.items.length && inFlight === 0) { endBatch(); return; }
    while (B && inFlight < B.conc && B.next < B.items.length) {
      var item = B.items[B.next++];
      saveState();
      inFlight++;
      dispatch(item);
    }
  }
  function dispatch(item) {
    chrome.runtime.sendMessage({ action: "captureOneTab", data: { url: item.url, id: item.id, delay: B ? B.delay : 0, render: B ? B.render : false } }, function (resp) {
      if (chrome.runtime.lastError && /invalidated|disconnected/i.test(chrome.runtime.lastError.message)) { die(chrome.runtime.lastError.message); B = null; inFlight = 0; return; }
      inFlight--;
      if (B) { B.done++; saveState(); writeProg(B.done, B.total, true); }
      pump();
    });
  }

  log("HTTP bridge loaded on " + location.href);
  requestInterval = setInterval(checkForRequest, 800);
  pullInterval = setInterval(pullCaptures, 2500);
  checkForRequest();
  setTimeout(pullCaptures, 1000);
})();
```

- [ ] **Step 6: Publish the probe helper into the content-script global so `bridge.js` can read it, and register it in the manifest.** Append this export bridge to the END of `extension/bridge-probe.js` so that, when loaded as a content script (no `module`), it attaches to `self`:

```js
// When loaded as a browser content script, expose to the page-context global so
// bridge.js can pick it up (content scripts share one isolated-world `self`).
if (typeof self !== "undefined") {
  self.IA_probePorts = probePorts;
  self.IA_PORT_RANGE = PORT_RANGE;
}
```

Then add `bridge-probe.js` BEFORE `bridge.js` in the localhost content-script entry of `extension/manifest.json`:

```json
    {
      "matches": ["http://localhost:*/*", "http://127.0.0.1:*/*"],
      "js": ["bridge-probe.js", "bridge.js"],
      "run_at": "document_idle"
    },
```

- [ ] **Step 7: Re-run the probe test (still passes) and verify the rewritten bridge is syntactically valid via `node --check`.**

```
node tests/bridge-port.test.js
node --check extension/bridge.js
node --check extension/bridge-probe.js
```
Expected: `2 passed, 0 failed` from the test; `node --check` prints nothing and exits 0 for both files.

- [ ] **Step 8: Commit.**

```
git add extension/bridge.js extension/bridge-probe.js extension/manifest.json tests/bridge-port.test.js
git commit -m "Extension bridge: switch delivery/polling to HTTP with port probing

Probe [3456..3465] via /api/ping, deliver via POST /api/captures, poll
/api/capture-request + /api/batch-state, report /api/batch-progress; keep
chrome.storage.local offline queue and flush on reconnect.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5.5: Switch `background.js` delivery to HTTP, keep the storage.local fallback

**Files:**
- Modify: `extension/background.js` (replace `deliverToApp` and `deliverDead` localhost-tab writes with HTTP POST to the discovered port; add a `findAppPort` probe; flush the offline `ia_capture_queue` on reconnect; keep the `chrome.storage.local` fallback when unreachable)

**Interfaces:**
- Consumes (Core service): `GET /api/ping -> {app:"interests", version}`; `POST /api/captures {capture} -> {ok}`.
- Consumes (extension runtime): `chrome.storage.local` get/set on `ia_capture_queue`; existing helpers in `background.js` (`log`, `normalizeUrl`, `MAX_QUEUE`).
- Produces: `findAppPort()->Promise<number|null>` (cached, probes `[3456..3465]` via `/api/ping`); `deliverToApp(capture)->Promise<boolean>` now POSTs `{capture}` to `/api/captures` and returns whether delivery succeeded; `flushQueue()->Promise<void>` drains `chrome.storage.local` `ia_capture_queue` to the app when reachable. Capture-object shape is UNCHANGED.

- [ ] **Step 1: Add the port-probe + queue-flush helpers near the top of `background.js`.** Insert this block immediately after the `normalizeUrl` function (around line 24). The service worker has `<all_urls>` host permission, so `fetch` to `http://127.0.0.1:<port>` is allowed.

```js
// ---- HTTP delivery to the Interests app (replaces writing into a localhost tab) ----
const IA_PORT_RANGE = [3456, 3457, 3458, 3459, 3460, 3461, 3462, 3463, 3464, 3465];
let iaCachedPort = null;

async function pingPort(port) {
  try {
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 600);
    let r;
    try { r = await fetch("http://127.0.0.1:" + port + "/api/ping", { signal: ctl.signal }); }
    finally { clearTimeout(tm); }
    if (!r || !r.ok) return false;
    const j = await r.json();
    return !!(j && j.app === "interests");
  } catch (e) { return false; }
}

// Find (and cache) the app's port. Revalidates the cached port; re-probes the
// whole range if it has gone silent. Returns null when the app is unreachable.
async function findAppPort() {
  if (iaCachedPort != null && (await pingPort(iaCachedPort))) return iaCachedPort;
  iaCachedPort = null;
  for (const p of IA_PORT_RANGE) {
    if (await pingPort(p)) { iaCachedPort = p; return p; }
  }
  return null;
}

// Push every queued capture (taken while the app was closed) once it's reachable.
async function flushQueue() {
  const port = await findAppPort();
  if (port == null) return;
  const stored = await chrome.storage.local.get("ia_capture_queue");
  let q = stored.ia_capture_queue || [];
  if (!Array.isArray(q) || !q.length) return;
  const remaining = [];
  for (const cap of q) {
    let ok = false;
    try {
      const r = await fetch("http://127.0.0.1:" + port + "/api/captures", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capture: cap }),
      });
      ok = !!(r && r.ok);
    } catch (e) { ok = false; }
    if (!ok) remaining.push(cap);
  }
  await chrome.storage.local.set({ ia_capture_queue: remaining });
  if (q.length !== remaining.length) log("Flushed " + (q.length - remaining.length) + " queued capture(s) to the app");
}
```

- [ ] **Step 2: Replace the body of `deliverToApp` with an HTTP POST + storage.local fallback.** Replace the entire existing `deliverToApp` function (lines ~58-85, the one that loops `chrome.tabs.query` and `chrome.scripting.executeScript` to write `ia_captures`) with this. It first opportunistically flushes any backlog, then POSTs this capture; on failure it stashes into `ia_capture_queue`.

```js
// Deliver a capture to the app over HTTP (POST /api/captures). On failure (app
// closed/unreachable) stash it in chrome.storage.local so it's flushed on
// reconnect. Returns true if the app received it directly.
async function deliverToApp(capture) {
  const port = await findAppPort();
  if (port != null) {
    try {
      await flushQueue();   // drain any backlog first so order is roughly preserved
      const r = await fetch("http://127.0.0.1:" + port + "/api/captures", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capture }),
      });
      if (r && r.ok) { log("Delivered capture to app on port " + port); return true; }
    } catch (e) { log("HTTP delivery failed: " + e.message); iaCachedPort = null; }
  }
  // app unreachable — queue it (dedupe by URL, cap the size)
  try {
    const stored = await chrome.storage.local.get("ia_capture_queue");
    let q = stored.ia_capture_queue || [];
    if (!Array.isArray(q)) q = [];
    if (capture && capture.url) q = q.filter((c) => normalizeUrl(c.url) !== normalizeUrl(capture.url));
    q.push(capture);
    if (q.length > MAX_QUEUE) q = q.slice(-MAX_QUEUE);
    await chrome.storage.local.set({ ia_capture_queue: q });
    log("App not reachable — queued capture (" + q.length + " pending)");
  } catch (e) {}
  return false;
}
```

- [ ] **Step 3: Replace the body of `deliverDead` to deliver over HTTP with the same fallback.** Replace the entire existing `deliverDead` function (lines ~525-546, the one that loops tabs and writes `ia_captures`, then sets `pendingCapture`). The "dead" notice is just another capture object, so route it through `deliverToApp` (which already has the queue fallback).

```js
// "Dead post" notices are ordinary capture objects (cap.dead) — deliver them the
// same way, with the same HTTP + offline-queue fallback.
async function deliverDead(dead) {
  return await deliverToApp(dead);
}
```

- [ ] **Step 4: Remove the now-duplicated inline-queue stashing in `captureTab` and `clipCurrentPage`, since `deliverToApp` now owns the fallback.** In `captureTab` (the block after `const delivered = await deliverToApp(capture);`, lines ~384-394) and in `clipCurrentPage` (the `if (!delivered) { ... ia_capture_queue ... }` block, lines ~268-276), DELETE the `if (!delivered) { ... chrome.storage.local.set({ ia_capture_queue }) ... }` blocks — `deliverToApp` already queues on failure, so a second stash would double-enqueue. Keep the surrounding `setBadge`/`setStatus`/`notify` lines that read `delivered`. The `captureTab` edit removes:

```js
    // Fallback: if the app isn't open, stash for the bridge to pick up later.
    if (!delivered) {
      const stored = await chrome.storage.local.get("ia_capture_queue");
      let queue = stored.ia_capture_queue || [];
      queue = queue.filter((c) => normalizeUrl(c.url) !== normalizeUrl(capture.url));
      queue.push(capture);
      if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
      await chrome.storage.local.set({ ia_capture_queue: queue });
      log("App not open — stashed capture (" + queue.length + " in queue)");
    }
```

and the `clipCurrentPage` edit removes:

```js
  if (!delivered) {
    // app tab isn't open — stash for the bridge to sync when it next loads
    const stored = await chrome.storage.local.get("ia_capture_queue");
    let queue = stored.ia_capture_queue || [];
    queue.push(payload);
    if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
    await chrome.storage.local.set({ ia_capture_queue: queue });
  }
```

- [ ] **Step 5: Trigger a reconnect flush on startup/install so a backlog drains without waiting for the next capture.** Add these listeners next to the existing `chrome.runtime.onStartup.addListener(ensureContextMenu);` line (around line 297):

```js
chrome.runtime.onStartup.addListener(() => { flushQueue().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { flushQueue().catch(() => {}); });
```

- [ ] **Step 6: Validate `background.js` parses and the existing test suite still runs.** `background.js` references `chrome.*`, so it cannot be `require`d in Node — use `node --check` for a syntax gate, and run the HTTP capture test from Tasks 5.1-5.3 to confirm nothing in `core/server.js` regressed.

```
node --check extension/background.js
node tests/service-captures.test.js
```
Expected: `node --check` prints nothing, exit 0; the service test prints `4 passed, 0 failed`, exit 0.

- [ ] **Step 7: Commit.**

```
git add extension/background.js
git commit -m "Extension background: deliver captures over HTTP with offline-queue fallback

deliverToApp/deliverDead POST {capture} to /api/captures on the probed port
([3456..3465] via /api/ping); chrome.storage.local ia_capture_queue holds
captures while the app is closed and flushes on reconnect/startup. Removed the
duplicate inline stash blocks now owned by deliverToApp.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5.6: Register the new tests in `tests/run.js` and verify the full Phase 5 suite

**Files:**
- Modify: `tests/run.js` (ensure it discovers and runs `tests/service-captures.test.js` and `tests/bridge-port.test.js`; if `tests/run.js` does not yet exist from an earlier phase, create it to run `syntax-check.js` then every `tests/*.test.js`)
- Modify: `package.json` (`scripts.test = "node tests/run.js"` — confirm present; add if absent)

**Interfaces:**
- Consumes: `tests/syntax-check.js` (inline-`<script>` parse gate on `web/index.html`), every `tests/*.test.js` (each prints `<p> passed, <f> failed` and `process.exit(f?1:0)`).
- Produces: a single `npm test` entry point that runs the syntax gate first, then every `*.test.js` (including `durability.test.js`, `service-captures.test.js`, `bridge-port.test.js`), and exits non-zero if any fails.

- [ ] **Step 1: Check whether `tests/run.js` already exists and what it runs.** A prior phase may have created it.

```
ls tests/run.js && cat tests/run.js || echo "run.js absent"
```
Expected: either it prints the existing runner, or `run.js absent`.

- [ ] **Step 2: If `tests/run.js` is absent, create it; if present, confirm it auto-discovers `tests/*.test.js` (no edit needed if it already globs the directory).** Create the file ONLY if Step 1 reported it absent:

```js
// Runs the syntax gate first, then every tests/*.test.js as a separate Node
// process, and exits non-zero if any of them fail.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const dir = __dirname;
let failed = 0;

function run(file) {
  process.stdout.write("\n== " + file + " ==\n");
  try { execFileSync(process.execPath, [path.join(dir, file)], { stdio: "inherit" }); }
  catch (e) { failed++; }
}

run("syntax-check.js");
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".test.js")).sort()) run(f);

process.stdout.write("\n" + (failed ? (failed + " test file(s) FAILED") : "all test files passed") + "\n");
process.exit(failed ? 1 : 0);
```

If `tests/run.js` already exists and already iterates `tests/*.test.js`, no change is needed — the two new files are picked up automatically. If it hardcodes a list of test files, add `"service-captures.test.js"` and `"bridge-port.test.js"` to that list.

- [ ] **Step 3: Confirm `package.json` wires `npm test` to the runner.** Read `package.json`; if `scripts.test` is missing or not `node tests/run.js`, set it:

```json
  "scripts": {
    "test": "node tests/run.js"
  }
```
(Merge into the existing `scripts` object rather than replacing it — preserve any `start`/`build`/`rebuild` scripts from earlier phases.)

- [ ] **Step 4: Run the full suite and confirm every test file passes, including the existing ones.**

```
npm test
```
Expected: each `== <file> ==` section runs; `syntax-check.js`, `durability.test.js` (`13 passed, 0 failed` or similar), `service-captures.test.js` (`4 passed, 0 failed`), and `bridge-port.test.js` (`2 passed, 0 failed`) all pass; final line `all test files passed`, exit 0.

- [ ] **Step 5: Commit.**

```
git add tests/run.js package.json
git commit -m "Wire service-captures + bridge-port tests into the test runner

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```


## Phase 6: Backup/restore + data-location move

### Task 6.1: Port pure backup helpers (`pickBackupsToDelete`, `backupCountsMatch`) into `core/backup.js`

**Files:**
- Create: `core/backup.js` (functions `pickBackupsToDelete`, `backupCountsMatch`; `module.exports`)
- Create: `tests/backup.test.js` (pure-helper section)

**Interfaces:**
- Consumes: nothing from earlier phases (these two are PURE, self-contained).
- Produces:
  - `pickBackupsToDelete(names: string[]|undefined, keep: number) -> string[]` — returns the dated-backup names to delete (all but the newest `keep`), matching ONLY `interests-backup-YYYY-MM-DD` folders or legacy `interests-backup-YYYY-MM-DD.json` files. Snapshots / `saves.json` / `before-restore` copies are never selected.
  - `backupCountsMatch(a: {imported,saved,images}|null, b: {imported,saved,images}|null) -> boolean` — true iff `imported|0`, `saved|0`, `images|0` all agree; false if either operand is missing.

- [ ] **Step 1: Write the failing test file** — create `tests/backup.test.js` with the pure-helper assertions (mirrors the existing `durability.test.js` cases so the ported logic is provably identical):

```js
// tests/backup.test.js — pure helpers + incremental selection + verify-before-rotate
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const backup = require("../core/backup.js");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); }
}

/* ---- pickBackupsToDelete (PURE) ---- */
t("keeps newest 3, deletes the rest (by date)", () => {
  const names = [
    "interests-backup-2026-06-18.json",
    "interests-backup-2026-06-21.json",
    "interests-backup-2026-06-19.json",
    "interests-backup-2026-06-20.json",
    "interests-backup-2026-06-17.json",
  ];
  const del = backup.pickBackupsToDelete(names, 3).sort();
  assert.deepStrictEqual(del, ["interests-backup-2026-06-17.json", "interests-backup-2026-06-18.json"]);
});
t("fewer than keep → delete nothing", () => {
  assert.deepStrictEqual(backup.pickBackupsToDelete(["interests-backup-2026-06-21.json"], 3), []);
});
t("ignores non-matching filenames", () => {
  const names = ["saves.json", "interests-snapshot-latest.json", "interests-backup-before-restore-123.json", "interests-backup-2026-06-21.json"];
  assert.deepStrictEqual(backup.pickBackupsToDelete(names, 3), []);
});
t("matches backup FOLDERS (no .json) and mixes with legacy files", () => {
  const names = [
    "interests-backup-2026-06-22",
    "interests-backup-2026-06-21",
    "interests-backup-2026-06-20.json",
    "interests-backup-2026-06-19",
    "interests-snapshot-latest.json",
    "interests-backup-before-restore-2026-06-22",
  ];
  const del = backup.pickBackupsToDelete(names, 2).sort();
  assert.deepStrictEqual(del, ["interests-backup-2026-06-19", "interests-backup-2026-06-20.json"]);
});
t("empty / undefined input → []", () => {
  assert.deepStrictEqual(backup.pickBackupsToDelete([], 3), []);
  assert.deepStrictEqual(backup.pickBackupsToDelete(undefined, 3), []);
});

/* ---- backupCountsMatch (PURE) ---- */
t("counts equal → true", () => {
  assert.strictEqual(backup.backupCountsMatch({ imported: 5500, saved: 18, images: 4301 }, { imported: 5500, saved: 18, images: 4301 }), true);
});
t("any count differs → false", () => {
  assert.strictEqual(backup.backupCountsMatch({ imported: 5500, saved: 18, images: 4301 }, { imported: 5500, saved: 18, images: 4300 }), false);
});
t("missing operand → false", () => {
  assert.strictEqual(backup.backupCountsMatch(null, { imported: 1, saved: 1, images: 1 }), false);
  assert.strictEqual(backup.backupCountsMatch({ imported: 1, saved: 1, images: 1 }, undefined), false);
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run the test, expect FAIL** — `core/backup.js` does not exist yet:

```
node tests/backup.test.js
```

Expected: FAIL — `Error: Cannot find module '../core/backup.js'` (non-zero exit).

- [ ] **Step 3: Create `core/backup.js` with the two ported pure functions** — verbatim semantics from the source `index.html` (`pickBackupsToDelete`, `backupCountsMatch`):

```js
// core/backup.js — backup/restore engine for the Core service.
// PURE helpers first (pickBackupsToDelete, backupCountsMatch) — ported verbatim
// from the legacy web app and covered by tests/backup.test.js.
"use strict";

// Given backup names, return the ones to delete (all but the newest `keep` by the
// embedded date). Matches a backup FOLDER (new) or a legacy single-file .json ONLY,
// so snapshots / saves.json / before-restore copies are never selected.
function pickBackupsToDelete(names, keep) {
  const re = /^interests-backup-(\d{4}-\d{2}-\d{2})(\.json)?$/;
  const dated = (names || [])
    .map(function (n) { const m = re.exec(n); return m ? { name: n, date: m[1] } : null; })
    .filter(Boolean)
    .sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
  return dated.slice(Math.max(0, keep)).map(function (d) { return d.name; });
}

// True when two counts objects agree on imported/saved/images. Used to verify a
// freshly-written backup before older ones are rotated away.
function backupCountsMatch(a, b) {
  if (!a || !b) return false;
  return (a.imported | 0) === (b.imported | 0)
    && (a.saved | 0) === (b.saved | 0)
    && (a.images | 0) === (b.images | 0);
}

module.exports = { pickBackupsToDelete, backupCountsMatch };
```

- [ ] **Step 4: Run the test, expect PASS**:

```
node tests/backup.test.js
```

Expected: `8 passed, 0 failed` (exit 0).

- [ ] **Step 5: Commit**:

```
git add core/backup.js tests/backup.test.js
git commit -m "Port pure backup helpers (pickBackupsToDelete, backupCountsMatch) into core/backup.js

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6.2: Backup directory resolution + incremental changed-image selection helper

**Files:**
- Modify: `core/backup.js` (add `dropboxBackupDir`, `changedImageIds`)
- Modify: `tests/backup.test.js` (add `changedImageIds` cases)

**Interfaces:**
- Consumes:
  - `loadConfig() -> object` from `core/config.js` (reads optional `config.backupDir` override).
  - `listImageIds(storeDir) -> string[]` from `core/images.js` (filenames in `images/` stripped of `.jpg`).
- Produces:
  - `dropboxBackupDir() -> string` — returns `config.backupDir` if set, else `<userprofile>/Dropbox/Interests App/backups`. Uses `process.env.USERPROFILE` (Windows).
  - `changedImageIds(storeDir: string, destImagesDir: string) -> string[]` — PURE-ish I/O helper: returns the image ids whose `<id>.jpg` is missing from `destImagesDir`, OR present but with a different file size than the source. Drives the incremental copy in `runBackup`. If `destImagesDir` does not exist, returns ALL ids in `storeDir`.

- [ ] **Step 1: Add failing tests for `changedImageIds`** — append before the final `console.log` line in `tests/backup.test.js`:

```js
/* ---- changedImageIds (incremental selection) ---- */
function mkTmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function writeJpg(dir, id, bytes) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + ".jpg"), Buffer.alloc(bytes, 1));
}

t("changedImageIds: dest missing → all source ids", () => {
  const store = mkTmp("ia-store-");
  const imgs = path.join(store, "images");
  writeJpg(imgs, "a", 10); writeJpg(imgs, "b", 20);
  const dest = path.join(mkTmp("ia-dest-"), "images"); // does not exist yet
  const got = backup.changedImageIds(store, dest).sort();
  assert.deepStrictEqual(got, ["a", "b"]);
});
t("changedImageIds: only new + size-changed ids selected", () => {
  const store = mkTmp("ia-store-");
  const imgs = path.join(store, "images");
  writeJpg(imgs, "a", 10);   // unchanged in dest
  writeJpg(imgs, "b", 20);   // size-changed in dest
  writeJpg(imgs, "c", 30);   // new (absent in dest)
  const destRoot = mkTmp("ia-dest-");
  const dest = path.join(destRoot, "images");
  writeJpg(dest, "a", 10);   // identical size → skip
  writeJpg(dest, "b", 5);    // different size → copy
  const got = backup.changedImageIds(store, dest).sort();
  assert.deepStrictEqual(got, ["b", "c"]);
});
t("changedImageIds: nothing changed → []", () => {
  const store = mkTmp("ia-store-");
  const imgs = path.join(store, "images");
  writeJpg(imgs, "a", 10);
  const destRoot = mkTmp("ia-dest-");
  const dest = path.join(destRoot, "images");
  writeJpg(dest, "a", 10);
  assert.deepStrictEqual(backup.changedImageIds(store, dest), []);
});
```

- [ ] **Step 2: Run the test, expect FAIL** — `changedImageIds` is not exported yet:

```
node tests/backup.test.js
```

Expected: FAIL — `TypeError: backup.changedImageIds is not a function` (exit 1).

- [ ] **Step 3: Implement `dropboxBackupDir` + `changedImageIds`** — edit `core/backup.js`. Add the requires and the new functions, and extend the export. Replace the top of the file (the require/`"use strict"` region) and the `module.exports` line:

Replace the header:

```js
"use strict";
```

with:

```js
"use strict";
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("./config.js");
const { listImageIds, imagesDir } = require("./images.js");

// <userprofile>/Dropbox/Interests App/backups, overridable via config.backupDir.
function dropboxBackupDir() {
  const cfg = loadConfig() || {};
  if (cfg.backupDir) return cfg.backupDir;
  const home = process.env.USERPROFILE || process.env.HOME || ".";
  return path.join(home, "Dropbox", "Interests App", "backups");
}

// Image ids whose <id>.jpg is missing from destImagesDir or differs in size.
// If destImagesDir does not exist, every source id is "changed". Drives the
// incremental image copy in runBackup so 600MB+ libraries back up fast.
function changedImageIds(storeDir, destImagesDir) {
  const ids = listImageIds(storeDir);
  const srcDir = imagesDir(storeDir);
  let destExists = false;
  try { destExists = fs.statSync(destImagesDir).isDirectory(); } catch (e) { destExists = false; }
  if (!destExists) return ids.slice();
  const out = [];
  for (const id of ids) {
    const srcFile = path.join(srcDir, id + ".jpg");
    const dstFile = path.join(destImagesDir, id + ".jpg");
    let srcSize = -1, dstSize = -2;
    try { srcSize = fs.statSync(srcFile).size; } catch (e) { srcSize = -1; }
    try { dstSize = fs.statSync(dstFile).size; } catch (e) { dstSize = -2; }
    if (srcSize !== dstSize) out.push(id);
  }
  return out;
}
```

Then replace:

```js
module.exports = { pickBackupsToDelete, backupCountsMatch };
```

with:

```js
module.exports = { pickBackupsToDelete, backupCountsMatch, dropboxBackupDir, changedImageIds };
```

- [ ] **Step 4: Run the test, expect PASS**:

```
node tests/backup.test.js
```

Expected: `11 passed, 0 failed` (exit 0).

- [ ] **Step 5: Commit**:

```
git add core/backup.js tests/backup.test.js
git commit -m "Add dropboxBackupDir + incremental changedImageIds helper to core/backup.js

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6.3: `runBackup`, `listBackups`, `verifyBackup` (dated folder, incremental copy, count verify)

**Files:**
- Modify: `core/backup.js` (add `runBackup`, `listBackups`, `verifyBackup`)
- Modify: `tests/backup.test.js` (add round-trip + verify cases)

**Interfaces:**
- Consumes:
  - `counts(db) -> {cards, saved}` from `core/db.js`.
  - `imageCount(storeDir) -> number`, `imagesDir(storeDir) -> string`, `listImageIds(storeDir) -> string[]` from `core/images.js`.
  - `dropboxBackupDir() -> string`, `changedImageIds(storeDir, destImagesDir) -> string[]`, `backupCountsMatch(a,b) -> boolean` from this module.
- Produces:
  - `runBackup(db, storeDir) -> {name, counts}` — creates `dropboxBackupDir()/interests-backup-YYYY-MM-DD/`, copies `interests.db` (from `storeDir/interests.db`) + new/changed images via `changedImageIds`, writes a `meta.json` `{_counts:{imported,saved,images}, ts}` LAST (its presence signals completeness), returns `{name, counts:{imported,saved,images}}`. `imported = counts(db).cards`, `saved = counts(db).saved`, `images = imageCount(storeDir)`.
  - `listBackups() -> [{name, date, counts}]` — scans `dropboxBackupDir()` for `interests-backup-YYYY-MM-DD` folders, newest first; `counts` read from each folder's `meta.json` (or `null` if unreadable).
  - `verifyBackup(name, expectedCounts) -> boolean` — true iff `dropboxBackupDir()/name/interests.db` exists, the folder's `images/` file count equals `expectedCounts.images`, and `meta.json._counts` matches `expectedCounts` via `backupCountsMatch`.

- [ ] **Step 1: Add failing round-trip tests** — append before the final `console.log` in `tests/backup.test.js`. These build a tiny real store with `core/db.js` + `core/images.js`, point the backup dir at a tmp folder via a `config.backupDir` override, run a backup, and verify:

```js
/* ---- runBackup / listBackups / verifyBackup (integration over tmp dirs) ---- */
const { openDb, upsertCard, upsertSaved } = require("../core/db.js");
const images = require("../core/images.js");
const config = require("../core/config.js");

const TINY_JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwAH/9k=";

function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-bk-store-"));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}
function withBackupDir(fn) {
  // point dropboxBackupDir() at a fresh tmp dir via a config override, restore after
  const bdir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-bk-dest-"));
  const orig = config.loadConfig();
  config.saveConfig(Object.assign({}, orig, { backupDir: bdir }));
  try { return fn(bdir); }
  finally { config.saveConfig(orig || {}); }
}

t("runBackup copies db + images and verifyBackup confirms", () => {
  withBackupDir(function () {
    const store = newStore();
    const db = openDb(store);
    upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
    upsertSaved(db, { id: "s1", url: "https://x/2", category: "Tips", clipped: 1, image: "idb:s1" });
    images.putImg(store, "c1", TINY_JPG);
    images.putImg(store, "s1", TINY_JPG);

    const res = backup.runBackup(db, store);
    assert.ok(/^interests-backup-\d{4}-\d{2}-\d{2}$/.test(res.name), "dated folder name");
    assert.deepStrictEqual(res.counts, { imported: 1, saved: 1, images: 2 });

    const bdir = backup.dropboxBackupDir();
    assert.ok(fs.existsSync(path.join(bdir, res.name, "interests.db")), "db copied");
    assert.strictEqual(fs.readdirSync(path.join(bdir, res.name, "images")).filter(function (n) { return n.endsWith(".jpg"); }).length, 2, "2 images copied");

    assert.strictEqual(backup.verifyBackup(res.name, res.counts), true);
    assert.strictEqual(backup.verifyBackup(res.name, { imported: 1, saved: 1, images: 999 }), false);
    db.close();
  });
});

t("listBackups lists dated folders newest-first with counts", () => {
  withBackupDir(function (bdir) {
    // hand-create two dated folders with meta.json
    for (const d of ["2026-06-20", "2026-06-22"]) {
      const f = path.join(bdir, "interests-backup-" + d);
      fs.mkdirSync(path.join(f, "images"), { recursive: true });
      fs.writeFileSync(path.join(f, "interests.db"), "x");
      fs.writeFileSync(path.join(f, "meta.json"), JSON.stringify({ _counts: { imported: 2, saved: 0, images: 0 }, ts: 1 }));
    }
    const list = backup.listBackups();
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].name, "interests-backup-2026-06-22", "newest first");
    assert.strictEqual(list[1].name, "interests-backup-2026-06-20");
    assert.deepStrictEqual(list[0].counts, { imported: 2, saved: 0, images: 0 });
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL** — `runBackup`/`listBackups`/`verifyBackup` not implemented:

```
node tests/backup.test.js
```

Expected: FAIL — `TypeError: backup.runBackup is not a function` (exit 1).

- [ ] **Step 3: Implement the three functions** — edit `core/backup.js`. Update the require line to also import `counts`, then add the functions and extend the export.

Replace:

```js
const { listImageIds, imagesDir } = require("./images.js");
```

with:

```js
const { listImageIds, imagesDir, imageCount } = require("./images.js");
const { counts } = require("./db.js");
```

Add these functions (before the `module.exports` line):

```js
function dateStamp() { return new Date().toISOString().slice(0, 10); }

function copyFileSync(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

// Create dropboxBackupDir()/interests-backup-YYYY-MM-DD/, copy interests.db + new/
// changed images, write meta.json LAST (presence signals a complete write).
function runBackup(db, storeDir) {
  const c = counts(db);
  const cnt = { imported: c.cards | 0, saved: c.saved | 0, images: imageCount(storeDir) | 0 };
  const name = "interests-backup-" + dateStamp();
  const destRoot = path.join(dropboxBackupDir(), name);
  const destImages = path.join(destRoot, "images");
  fs.mkdirSync(destImages, { recursive: true });

  // db copy (overwrites a prior same-day backup so it can't go stale)
  copyFileSync(path.join(storeDir, "interests.db"), path.join(destRoot, "interests.db"));

  // incremental image copy
  const srcImages = imagesDir(storeDir);
  for (const id of changedImageIds(storeDir, destImages)) {
    copyFileSync(path.join(srcImages, id + ".jpg"), path.join(destImages, id + ".jpg"));
  }

  // meta.json LAST
  fs.writeFileSync(path.join(destRoot, "meta.json"), JSON.stringify({ _counts: cnt, ts: Date.now() }));
  return { name, counts: cnt };
}

function readMeta(folder) {
  try { return JSON.parse(fs.readFileSync(path.join(folder, "meta.json"), "utf8")); }
  catch (e) { return null; }
}

// Scan dropboxBackupDir() for dated backup folders, newest first.
function listBackups() {
  const root = dropboxBackupDir();
  let names = [];
  try { names = fs.readdirSync(root); } catch (e) { return []; }
  const re = /^interests-backup-(\d{4}-\d{2}-\d{2})$/;
  return names
    .map(function (n) {
      const m = re.exec(n);
      if (!m) return null;
      let isDir = false;
      try { isDir = fs.statSync(path.join(root, n)).isDirectory(); } catch (e) { isDir = false; }
      if (!isDir) return null;
      const meta = readMeta(path.join(root, n));
      return { name: n, date: m[1], counts: meta ? meta._counts : null };
    })
    .filter(Boolean)
    .sort(function (a, b) { return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
}

// True iff the named backup has interests.db, an images/ file count equal to
// expectedCounts.images, and meta._counts matching expectedCounts.
function verifyBackup(name, expectedCounts) {
  const folder = path.join(dropboxBackupDir(), name);
  try {
    if (!fs.statSync(path.join(folder, "interests.db")).isFile()) return false;
  } catch (e) { return false; }
  let imgFiles = 0;
  try {
    imgFiles = fs.readdirSync(path.join(folder, "images")).filter(function (n) { return n.endsWith(".jpg"); }).length;
  } catch (e) { imgFiles = 0; }
  if (imgFiles !== (expectedCounts.images | 0)) return false;
  const meta = readMeta(folder);
  return !!meta && backupCountsMatch(meta._counts, expectedCounts);
}
```

Replace the export line:

```js
module.exports = { pickBackupsToDelete, backupCountsMatch, dropboxBackupDir, changedImageIds };
```

with:

```js
module.exports = { pickBackupsToDelete, backupCountsMatch, dropboxBackupDir, changedImageIds, runBackup, listBackups, verifyBackup };
```

- [ ] **Step 4: Run the test, expect PASS** (run with plain Node ABI — `better-sqlite3` is built for Node here; packaging rebuilds for Electron ABI later via electron-rebuild):

```
node tests/backup.test.js
```

Expected: `13 passed, 0 failed` (exit 0).

- [ ] **Step 5: Commit**:

```
git add core/backup.js tests/backup.test.js
git commit -m "Add runBackup, listBackups, verifyBackup to core/backup.js

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6.4: `rotate` (verify-before-delete) — never delete a good backup if the new one is unverified

**Files:**
- Modify: `core/backup.js` (add `rotate`)
- Modify: `tests/backup.test.js` (add verify-before-rotate cases)

**Interfaces:**
- Consumes:
  - `dropboxBackupDir() -> string`, `listBackups() -> [{name,date,counts}]`, `verifyBackup(name, expectedCounts) -> boolean`, `pickBackupsToDelete(names, keep) -> string[]` from this module.
- Produces:
  - `rotate(keep=3) -> void` — lists dated backups newest-first; for each candidate the `pickBackupsToDelete` rule would delete, ONLY remove it (recursive folder delete) if its OWN `meta.json` verifies (`verifyBackup(name, meta._counts)` true) AND at least one NEWER backup also verifies against its own meta. Never deletes a backup when no newer verified backup exists, so an incomplete newest backup can never cause a good older one to be removed.

- [ ] **Step 1: Add failing tests** — append before the final `console.log` in `tests/backup.test.js`:

```js
/* ---- rotate (verify-before-delete) ---- */
function mkBackupFolder(bdir, date, opts) {
  // opts: {imgFiles, metaImages, db: bool} — build a backup folder we control
  const folder = path.join(bdir, "interests-backup-" + date);
  fs.mkdirSync(path.join(folder, "images"), { recursive: true });
  for (let i = 0; i < (opts.imgFiles || 0); i++) fs.writeFileSync(path.join(folder, "images", "img" + i + ".jpg"), Buffer.alloc(4, 1));
  if (opts.db !== false) fs.writeFileSync(path.join(folder, "interests.db"), "x");
  fs.writeFileSync(path.join(folder, "meta.json"), JSON.stringify({ _counts: { imported: 1, saved: 0, images: opts.metaImages != null ? opts.metaImages : (opts.imgFiles || 0) }, ts: 1 }));
  return folder;
}

t("rotate keeps newest `keep`, deletes verified older ones", () => {
  withBackupDir(function (bdir) {
    for (const d of ["2026-06-18", "2026-06-19", "2026-06-20", "2026-06-21"]) mkBackupFolder(bdir, d, { imgFiles: 1 });
    backup.rotate(2);
    const left = fs.readdirSync(bdir).filter(function (n) { return n.startsWith("interests-backup-"); }).sort();
    assert.deepStrictEqual(left, ["interests-backup-2026-06-20", "interests-backup-2026-06-21"]);
  });
});

t("rotate does NOT delete an older good backup when the newest is unverified", () => {
  withBackupDir(function (bdir) {
    // newest is BROKEN: meta claims 5 images but folder has 0 → verifyBackup false
    mkBackupFolder(bdir, "2026-06-18", { imgFiles: 1 });           // good, older
    mkBackupFolder(bdir, "2026-06-19", { imgFiles: 1 });           // good, older
    mkBackupFolder(bdir, "2026-06-20", { imgFiles: 0, metaImages: 5 }); // BROKEN newest
    backup.rotate(2);
    const left = fs.readdirSync(bdir).filter(function (n) { return n.startsWith("interests-backup-"); }).sort();
    // keep=2 would normally delete 06-18, but the newest is unverified → nothing deleted
    assert.deepStrictEqual(left, ["interests-backup-2026-06-18", "interests-backup-2026-06-19", "interests-backup-2026-06-20"]);
  });
});

t("rotate keeps an older backup that itself fails verification (never delete a good one for a bad one)", () => {
  withBackupDir(function (bdir) {
    mkBackupFolder(bdir, "2026-06-18", { imgFiles: 0, metaImages: 9 }); // BROKEN older — must NOT be deleted
    mkBackupFolder(bdir, "2026-06-19", { imgFiles: 1 });               // good
    mkBackupFolder(bdir, "2026-06-20", { imgFiles: 1 });               // good newest
    backup.rotate(2);
    const left = fs.readdirSync(bdir).filter(function (n) { return n.startsWith("interests-backup-"); }).sort();
    // 06-18 is a rotation candidate but it doesn't verify → leave it (a bad backup is
    // not a safe thing to delete; only delete a backup that is provably complete)
    assert.deepStrictEqual(left, ["interests-backup-2026-06-18", "interests-backup-2026-06-19", "interests-backup-2026-06-20"]);
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL** — `rotate` not implemented:

```
node tests/backup.test.js
```

Expected: FAIL — `TypeError: backup.rotate is not a function` (exit 1).

- [ ] **Step 3: Implement `rotate`** — edit `core/backup.js`. Add the function before `module.exports`:

```js
// Keep the newest `keep` dated backups. A candidate is deleted ONLY when it itself
// verifies (so we never delete an incomplete backup we can't trust) AND at least one
// NEWER backup also verifies (so an incomplete newest never causes a good older one
// to be dropped). The sharded-backup lesson: never delete a good backup for a bad one.
function rotate(keep) {
  keep = (keep == null) ? 3 : keep;
  const list = listBackups();                 // newest-first, each {name,date,counts}
  if (!list.length) return;
  const verified = list.map(function (b) {
    return b.counts ? verifyBackup(b.name, b.counts) : false;
  });
  const candidates = pickBackupsToDelete(list.map(function (b) { return b.name; }), keep);
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (candidates.indexOf(b.name) < 0) continue;   // within the keep window
    if (!verified[i]) continue;                      // don't delete an unverified backup
    let newerVerified = false;
    for (let j = 0; j < i; j++) { if (verified[j]) { newerVerified = true; break; } } // j<i = newer
    if (!newerVerified) continue;                    // no trustworthy newer copy → keep this
    try { fs.rmSync(path.join(dropboxBackupDir(), b.name), { recursive: true, force: true }); } catch (e) {}
  }
}
```

Replace the export line:

```js
module.exports = { pickBackupsToDelete, backupCountsMatch, dropboxBackupDir, changedImageIds, runBackup, listBackups, verifyBackup };
```

with:

```js
module.exports = { pickBackupsToDelete, backupCountsMatch, dropboxBackupDir, changedImageIds, runBackup, listBackups, verifyBackup, rotate };
```

- [ ] **Step 4: Run the test, expect PASS**:

```
node tests/backup.test.js
```

Expected: `16 passed, 0 failed` (exit 0).

- [ ] **Step 5: Commit**:

```
git add core/backup.js tests/backup.test.js
git commit -m "Add verify-before-delete rotate to core/backup.js

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6.5: `restore` (safety-snapshot the current store, then swap db + images back)

**Files:**
- Modify: `core/backup.js` (add `restore`)
- Modify: `tests/backup.test.js` (add restore round-trip case)

**Interfaces:**
- Consumes:
  - `dropboxBackupDir() -> string`, `verifyBackup(name, expectedCounts) -> boolean` from this module.
  - `ctx` object passed by the caller: `{ db, storeDir, getStorePath, setStorePath, reopen }` where `ctx.storeDir` is the current live store path, `ctx.db` is the open `better-sqlite3` Database, and `ctx.reopen()` re-opens the DB from `ctx.storeDir` after files are swapped (returns the new Database; server then rebinds `ctx.db`). The contract's `core/server.js` ctx is `{db, storeDir, getStorePath, setStorePath}`; this task additionally relies on a `reopen` closure the server provides.
- Produces:
  - `restore(name, ctx) -> {ok}` — (1) take a safety snapshot of the CURRENT store by copying `ctx.storeDir/interests.db` + `images/` into `dropboxBackupDir()/interests-backup-before-restore-<ts>/` (NOT a dated name, so it is never auto-rotated); (2) close `ctx.db`; (3) copy `<backup>/interests.db` + `<backup>/images/*` over the live store (replacing the live db, overlaying images); (4) call `ctx.reopen()` and set `ctx.db` to the result; returns `{ok:true}`. Returns `{ok:false}` without touching the live store if the backup folder is missing its `interests.db`.

- [ ] **Step 1: Add a failing restore test** — append before the final `console.log` in `tests/backup.test.js`:

```js
/* ---- restore (safety snapshot then swap) ---- */
t("restore snapshots current store, swaps backup db+images in, keeps live store intact on missing backup", () => {
  withBackupDir(function (bdir) {
    // live store with ONE card + image
    const store = newStore();
    let db = openDb(store);
    upsertCard(db, { id: "live", url: "https://x/live", platform: "fb", cat: "Saved", ts: 1, img: "idb:live" });
    images.putImg(store, "live", TINY_JPG);

    // a backup folder representing a DIFFERENT state (two cards, two images)
    const bkStore = newStore();
    let bdb = openDb(bkStore);
    upsertCard(bdb, { id: "a", url: "https://x/a", platform: "fb", cat: "Saved", ts: 1, img: "idb:a" });
    upsertCard(bdb, { id: "b", url: "https://x/b", platform: "fb", cat: "Saved", ts: 2, img: "idb:b" });
    images.putImg(bkStore, "a", TINY_JPG);
    images.putImg(bkStore, "b", TINY_JPG);
    bdb.close();
    const res = backup.runBackup(openDb(bkStore), bkStore); // writes interests-backup-<today>
    const backupName = res.name;

    // ctx with a reopen closure
    const ctx = {
      db, storeDir: store,
      getStorePath: function () { return store; },
      setStorePath: function () {},
      reopen: function () { return openDb(store); }
    };

    // missing-backup guard: live store untouched
    assert.deepStrictEqual(backup.restore("interests-backup-2099-01-01", ctx), { ok: false });
    assert.strictEqual(images.imageCount(store), 1, "live images untouched on bad restore");

    // real restore
    const out = backup.restore(backupName, ctx);
    assert.strictEqual(out.ok, true);
    // live db now has the backup's two cards
    assert.strictEqual(counts(ctx.db).cards, 2);
    assert.strictEqual(images.imageCount(store), 2, "backup images overlaid");
    // safety snapshot exists and is NOT a rotatable dated name
    const snaps = fs.readdirSync(bdir).filter(function (n) { return n.indexOf("interests-backup-before-restore-") === 0; });
    assert.strictEqual(snaps.length, 1, "one pre-restore safety snapshot");
    assert.strictEqual(backup.pickBackupsToDelete([snaps[0]], 0).length, 0, "snapshot never rotated");
    ctx.db.close();
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL** — `restore` not implemented:

```
node tests/backup.test.js
```

Expected: FAIL — `TypeError: backup.restore is not a function` (exit 1).

- [ ] **Step 3: Implement `restore`** — edit `core/backup.js`. Add a recursive image-overlay helper and the `restore` function before `module.exports`:

```js
// Copy every *.jpg from srcImages over dstImages (overlay, never deletes extras).
function overlayImages(srcImages, dstImages) {
  let names = [];
  try { names = fs.readdirSync(srcImages); } catch (e) { return; }
  fs.mkdirSync(dstImages, { recursive: true });
  for (const n of names) {
    if (!n.endsWith(".jpg")) continue;
    try { fs.copyFileSync(path.join(srcImages, n), path.join(dstImages, n)); } catch (e) {}
  }
}

// Restore a named backup: safety-snapshot the CURRENT store first (so a mistaken
// restore is recoverable), then swap the backup's db + images into the live store
// and reopen. Old/live data is never destroyed without a snapshot first.
function restore(name, ctx) {
  const backupFolder = path.join(dropboxBackupDir(), name);
  let hasDb = false;
  try { hasDb = fs.statSync(path.join(backupFolder, "interests.db")).isFile(); } catch (e) { hasDb = false; }
  if (!hasDb) return { ok: false };

  // 1) safety snapshot of the live store (non-dated name → never auto-rotated)
  const snapName = "interests-backup-before-restore-" + Date.now();
  const snapFolder = path.join(dropboxBackupDir(), snapName);
  fs.mkdirSync(path.join(snapFolder, "images"), { recursive: true });
  try { fs.copyFileSync(path.join(ctx.storeDir, "interests.db"), path.join(snapFolder, "interests.db")); } catch (e) {}
  overlayImages(path.join(ctx.storeDir, "images"), path.join(snapFolder, "images"));

  // 2) close the live db so the file can be replaced (Windows holds an exclusive handle)
  try { ctx.db.close(); } catch (e) {}
  // also drop WAL/SHM sidecars so the restored db isn't shadowed by stale WAL pages
  for (const ext of ["-wal", "-shm"]) { try { fs.rmSync(path.join(ctx.storeDir, "interests.db" + ext), { force: true }); } catch (e) {} }

  // 3) swap backup db + images into the live store
  fs.copyFileSync(path.join(backupFolder, "interests.db"), path.join(ctx.storeDir, "interests.db"));
  overlayImages(path.join(backupFolder, "images"), path.join(ctx.storeDir, "images"));

  // 4) reopen
  ctx.db = ctx.reopen();
  return { ok: true };
}
```

Replace the export line:

```js
module.exports = { pickBackupsToDelete, backupCountsMatch, dropboxBackupDir, changedImageIds, runBackup, listBackups, verifyBackup, rotate };
```

with:

```js
module.exports = { pickBackupsToDelete, backupCountsMatch, dropboxBackupDir, changedImageIds, runBackup, listBackups, verifyBackup, rotate, restore };
```

- [ ] **Step 4: Run the test, expect PASS**:

```
node tests/backup.test.js
```

Expected: `17 passed, 0 failed` (exit 0).

- [ ] **Step 5: Commit**:

```
git add core/backup.js tests/backup.test.js
git commit -m "Add restore (safety snapshot then swap) to core/backup.js

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6.6: Backup/restore/health REST endpoints in `core/server.js`

**Files:**
- Modify: `core/server.js` (`createServer(ctx)` — add `/api/backup`, `/api/backups`, `/api/restore`, `/api/health`)
- Create: `tests/server-backup-int.test.js`

**Interfaces:**
- Consumes:
  - `createServer(ctx) -> express.App` from `core/server.js` (pure factory, no listen), where `ctx = {db, storeDir, getStorePath, setStorePath, reopen}`.
  - From `core/backup.js`: `runBackup(db, storeDir) -> {name, counts}`, `listBackups() -> [{name,date,counts}]`, `restore(name, ctx) -> {ok}`, `rotate(keep) -> void`, `verifyBackup(name, expectedCounts) -> boolean`, `dropboxBackupDir() -> string`.
  - From `core/db.js`: `counts(db) -> {cards, saved}`. From `core/images.js`: `imageCount(storeDir) -> number`.
- Produces (HTTP, JSON):
  - `POST /api/backup -> {ok:true, name, counts}` — runs `runBackup`, then (only if the new backup `verifyBackup`s) `rotate(3)`.
  - `GET /api/backups -> {backups: [{name,date,counts}]}`.
  - `POST /api/restore {name} -> {ok}` (passes the server's `ctx`; rebinds `ctx.db`).
  - `GET /api/health -> {storePath, counts:{cards,saved,images}, lastBackup}` where `lastBackup` = newest backup's `{name, counts}` or `null`.

- [ ] **Step 1: Write the failing HTTP integration test** — create `tests/server-backup-int.test.js`. It mounts `createServer(ctx)` on port 0, points the backup dir at a tmp folder via `config.backupDir`, and exercises the four endpoints with `global fetch`:

```js
// tests/server-backup-int.test.js — backup/restore/health endpoints over HTTP
const assert = require("assert");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");

const { createServer } = require("../core/server.js");
const { openDb, upsertCard, counts } = require("../core/db.js");
const images = require("../core/images.js");
const config = require("../core/config.js");

const TINY_JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwAH/9k=";

let pass = 0, fail = 0;
function t(name) { return name; }
async function run(name, fn) {
  try { await fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); }
}

function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-srvbk-store-"));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}
function listen(app) {
  return new Promise(function (res) {
    const srv = http.createServer(app).listen(0, "127.0.0.1", function () {
      res({ srv, base: "http://127.0.0.1:" + srv.address().port });
    });
  });
}

(async function () {
  const bdir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-srvbk-dest-"));
  const orig = config.loadConfig();
  config.saveConfig(Object.assign({}, orig, { backupDir: bdir }));
  try {
    const store = newStore();
    let db = openDb(store);
    upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
    images.putImg(store, "c1", TINY_JPG);

    const ctx = {
      db, storeDir: store,
      getStorePath: function () { return store; },
      setStorePath: function () {},
      reopen: function () { return openDb(store); }
    };
    const app = createServer(ctx);
    const { srv, base } = await listen(app);

    await run(t("GET /api/health reports store path + counts"), async () => {
      const h = await (await fetch(base + "/api/health")).json();
      assert.strictEqual(h.storePath, store);
      assert.deepStrictEqual(h.counts, { cards: 1, saved: 0, images: 1 });
      assert.strictEqual(h.lastBackup, null);
    });

    let backupName;
    await run(t("POST /api/backup creates a verified dated backup"), async () => {
      const r = await (await fetch(base + "/api/backup", { method: "POST" })).json();
      assert.strictEqual(r.ok, true);
      assert.ok(/^interests-backup-\d{4}-\d{2}-\d{2}$/.test(r.name));
      assert.deepStrictEqual(r.counts, { imported: 1, saved: 0, images: 1 });
      backupName = r.name;
      assert.ok(fs.existsSync(path.join(bdir, r.name, "interests.db")));
    });

    await run(t("GET /api/backups lists the new backup"), async () => {
      const r = await (await fetch(base + "/api/backups")).json();
      assert.ok(Array.isArray(r.backups));
      assert.strictEqual(r.backups[0].name, backupName);
    });

    await run(t("GET /api/health now shows lastBackup"), async () => {
      const h = await (await fetch(base + "/api/health")).json();
      assert.ok(h.lastBackup && h.lastBackup.name === backupName);
    });

    await run(t("POST /api/restore round-trips and rebinds ctx.db"), async () => {
      // mutate live to 2 cards, then restore the 1-card backup
      upsertCard(ctx.db, { id: "c2", url: "https://x/2", platform: "fb", cat: "Saved", ts: 2, img: "" });
      assert.strictEqual(counts(ctx.db).cards, 2);
      const r = await (await fetch(base + "/api/restore", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: backupName })
      })).json();
      assert.strictEqual(r.ok, true);
      assert.strictEqual(counts(ctx.db).cards, 1, "ctx.db rebound to restored 1-card store");
    });

    srv.close();
    try { ctx.db.close(); } catch (e) {}
  } finally {
    config.saveConfig(orig || {});
  }
  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
```

- [ ] **Step 2: Run the test, expect FAIL** — the backup endpoints are not mounted yet:

```
node tests/server-backup-int.test.js
```

Expected: FAIL — `/api/backup` 404 → JSON parse / assertion error (exit 1).

- [ ] **Step 3: Mount the endpoints in `createServer`** — edit `core/server.js`. Add the requires near the top of the module (with the other core requires):

```js
const backup = require("./backup.js");
```

Then, inside `createServer(ctx)` (after the other routes are registered on `app`, before `return app;`), add:

```js
  // ---- backup / restore / health ----
  app.post("/api/backup", (req, res) => {
    try {
      const out = backup.runBackup(ctx.db, ctx.storeDir);
      if (backup.verifyBackup(out.name, out.counts)) backup.rotate(3);
      res.json({ ok: true, name: out.name, counts: out.counts });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message || e) });
    }
  });

  app.get("/api/backups", (req, res) => {
    res.json({ backups: backup.listBackups() });
  });

  app.post("/api/restore", (req, res) => {
    const name = req.body && req.body.name;
    if (!name) return res.status(400).json({ ok: false, error: "name required" });
    try {
      const out = backup.restore(name, ctx);   // restore rebinds ctx.db on success
      res.json(out);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e && e.message || e) });
    }
  });

  app.get("/api/health", (req, res) => {
    const c = counts(ctx.db);
    const list = backup.listBackups();
    const lastBackup = list.length ? { name: list[0].name, counts: list[0].counts } : null;
    res.json({
      storePath: ctx.storeDir,
      counts: { cards: c.cards | 0, saved: c.saved | 0, images: imageCount(ctx.storeDir) | 0 },
      lastBackup
    });
  });
```

If `counts` and `imageCount` are not already imported in `core/server.js`, add them to the existing core requires (adjust to match the file's existing destructuring style):

```js
const { counts } = require("./db.js");
const { imageCount } = require("./images.js");
```

- [ ] **Step 4: Run the test, expect PASS**:

```
node tests/server-backup-int.test.js
```

Expected: `5 passed, 0 failed` (exit 0).

- [ ] **Step 5: Commit**:

```
git add core/server.js tests/server-backup-int.test.js
git commit -m "Mount /api/backup, /api/backups, /api/restore, /api/health endpoints

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6.7: `core/config.js` setStorePath + store-move helper (`moveStore`) — copy, verify, repoint, keep source until verified

**Files:**
- Modify: `core/backup.js` (add `moveStore`)
- Create: `tests/storemove-int.test.js`

**Interfaces:**
- Consumes:
  - From `core/config.js`: `setStorePath(p) -> void` (persists `config.storePath = p`), `getStorePath() -> string` (ensures dir + dir/images exist).
  - From `core/db.js`: `counts(db) -> {cards, saved}`. From `core/images.js`: `imageCount(storeDir) -> number`, `imagesDir(storeDir) -> string`, `listImageIds(storeDir) -> string[]`.
  - From this module: `backupCountsMatch(a,b) -> boolean`.
  - `ctx = {db, storeDir, getStorePath, setStorePath, reopen}` — `ctx.reopen()` re-opens the DB from `ctx.storeDir` after it is repointed.
- Produces:
  - `moveStore(target, ctx) -> {ok, path}` — (1) compute current `{imported,saved,images}` from `ctx.db` + `ctx.storeDir`; (2) copy `ctx.storeDir/interests.db` + every `images/*.jpg` into `target` (creating `target` + `target/images`); (3) verify: target db opens and its `{cards,saved}` + `imageCount(target)` match the source counts via `backupCountsMatch`; (4) ONLY if verified: close `ctx.db`, `setStorePath(target)`, set `ctx.storeDir = target`, `ctx.db = ctx.reopen()` — and leave the OLD store files intact on disk; (5) return `{ok:true, path:target}`. On any verify failure: do NOT repoint, leave both copies, return `{ok:false, path:ctx.storeDir}`.

- [ ] **Step 1: Write the failing move integration test** — create `tests/storemove-int.test.js`:

```js
// tests/storemove-int.test.js — move a tmp store to a new tmp dir; assert target has
// db+images, pointer updated, and the SOURCE is still intact (kept until verified).
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const backup = require("../core/backup.js");
const { openDb, upsertCard, upsertSaved, counts } = require("../core/db.js");
const images = require("../core/images.js");
const config = require("../core/config.js");

const TINY_JPG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwAH/9k=";

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); }
}
function newStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-mv-src-"));
  fs.mkdirSync(path.join(dir, "images"), { recursive: true });
  return dir;
}

t("moveStore copies db+images to target, repoints pointer, leaves source intact", () => {
  const orig = config.loadConfig();
  try {
    const store = newStore();
    let db = openDb(store);
    upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
    upsertCard(db, { id: "c2", url: "https://x/2", platform: "fb", cat: "Saved", ts: 2, img: "idb:c2" });
    upsertSaved(db, { id: "s1", url: "https://x/s", category: "Tips", clipped: 1, image: "idb:s1" });
    images.putImg(store, "c1", TINY_JPG);
    images.putImg(store, "c2", TINY_JPG);
    images.putImg(store, "s1", TINY_JPG);
    config.setStorePath(store);

    const target = fs.mkdtempSync(path.join(os.tmpdir(), "ia-mv-dst-"));
    const ctx = {
      db, storeDir: store,
      getStorePath: function () { return store; },
      setStorePath: config.setStorePath,
      reopen: function () { return openDb(ctx.storeDir); }
    };

    const res = backup.moveStore(target, ctx);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.path, target);

    // target has db + all 3 images
    assert.ok(fs.existsSync(path.join(target, "interests.db")), "target db present");
    assert.strictEqual(images.imageCount(target), 3, "target images present");
    assert.strictEqual(counts(ctx.db).cards, 2, "ctx.db reopened from target");

    // pointer updated
    assert.strictEqual(config.getStorePath(), target, "config pointer repointed");
    assert.strictEqual(ctx.storeDir, target, "ctx.storeDir repointed");

    // SOURCE still intact (kept until verified — and we keep it after, too)
    assert.ok(fs.existsSync(path.join(store, "interests.db")), "source db still present");
    assert.strictEqual(images.imageCount(store), 3, "source images still present");
    ctx.db.close();
  } finally {
    config.saveConfig(orig || {});
  }
});

t("moveStore on a bad target does NOT repoint and keeps both copies", () => {
  const orig = config.loadConfig();
  try {
    const store = newStore();
    let db = openDb(store);
    upsertCard(db, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
    images.putImg(store, "c1", TINY_JPG);
    config.setStorePath(store);

    // target points at a path under a file (mkdir will fail) → verify cannot pass
    const blocker = fs.mkdtempSync(path.join(os.tmpdir(), "ia-mv-blk-"));
    const filePath = path.join(blocker, "afile");
    fs.writeFileSync(filePath, "x");
    const target = path.join(filePath, "store"); // child of a file → unwritable

    const ctx = {
      db, storeDir: store,
      getStorePath: function () { return store; },
      setStorePath: config.setStorePath,
      reopen: function () { return openDb(ctx.storeDir); }
    };
    const res = backup.moveStore(target, ctx);
    assert.strictEqual(res.ok, false, "bad target → not ok");
    assert.strictEqual(ctx.storeDir, store, "ctx.storeDir unchanged");
    assert.strictEqual(config.getStorePath(), store, "pointer unchanged");
    assert.strictEqual(images.imageCount(store), 1, "source intact");
    ctx.db.close();
  } finally {
    config.saveConfig(orig || {});
  }
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run the test, expect FAIL** — `moveStore` not implemented:

```
node tests/storemove-int.test.js
```

Expected: FAIL — `TypeError: backup.moveStore is not a function` (exit 1).

- [ ] **Step 3: Implement `moveStore`** — edit `core/backup.js`. It reuses the `openDb`/`counts`/`imageCount`/`listImageIds`/`imagesDir` it already consumes; add `openDb` and the config setter to the requires.

Update the db require:

```js
const { counts } = require("./db.js");
```

to:

```js
const { counts, openDb } = require("./db.js");
const { setStorePath } = require("./config.js");
```

(Keep the existing `loadConfig` require line as-is.)

Add the function before `module.exports`:

```js
// Move the live store to `target`: copy db + images, VERIFY counts at the target,
// and only then repoint the %APPDATA% pointer + reopen. The old copy is left intact
// until (and after) verification, so an interrupted/failed move never loses data.
function moveStore(target, ctx) {
  const c = counts(ctx.db);
  const srcCounts = { imported: c.cards | 0, saved: c.saved | 0, images: imageCount(ctx.storeDir) | 0 };

  // 1) copy db + images into target
  let tdb = null;
  try {
    fs.mkdirSync(path.join(target, "images"), { recursive: true });
    fs.copyFileSync(path.join(ctx.storeDir, "interests.db"), path.join(target, "interests.db"));
    const srcImages = imagesDir(ctx.storeDir);
    for (const id of listImageIds(ctx.storeDir)) {
      fs.copyFileSync(path.join(srcImages, id + ".jpg"), path.join(target, "images", id + ".jpg"));
    }
    // 2) verify at the target by opening its db + counting its images
    tdb = openDb(target);
    const tc = counts(tdb);
    const targetCounts = { imported: tc.cards | 0, saved: tc.saved | 0, images: imageCount(target) | 0 };
    tdb.close(); tdb = null;
    if (!backupCountsMatch(srcCounts, targetCounts)) return { ok: false, path: ctx.storeDir };
  } catch (e) {
    if (tdb) { try { tdb.close(); } catch (e2) {} }
    return { ok: false, path: ctx.storeDir };
  }

  // 3) verified → repoint + reopen; OLD store files are left on disk
  try { ctx.db.close(); } catch (e) {}
  setStorePath(target);
  ctx.storeDir = target;
  ctx.db = ctx.reopen();
  return { ok: true, path: target };
}
```

Replace the export line:

```js
module.exports = { pickBackupsToDelete, backupCountsMatch, dropboxBackupDir, changedImageIds, runBackup, listBackups, verifyBackup, rotate, restore };
```

with:

```js
module.exports = { pickBackupsToDelete, backupCountsMatch, dropboxBackupDir, changedImageIds, runBackup, listBackups, verifyBackup, rotate, restore, moveStore };
```

- [ ] **Step 4: Run the test, expect PASS**:

```
node tests/storemove-int.test.js
```

Expected: `2 passed, 0 failed` (exit 0).

- [ ] **Step 5: Commit**:

```
git add core/backup.js tests/storemove-int.test.js
git commit -m "Add moveStore (copy/verify/repoint, keep source until verified) to core/backup.js

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6.8: Store-location REST endpoints (`/api/store-location`, `/api/store-location/move`)

**Files:**
- Modify: `core/server.js` (`createServer(ctx)` — add `GET /api/store-location`, `POST /api/store-location/move`)
- Modify: `tests/server-backup-int.test.js` (add store-location cases)

**Interfaces:**
- Consumes:
  - `createServer(ctx) -> express.App`, `ctx = {db, storeDir, getStorePath, setStorePath, reopen}`.
  - From `core/backup.js`: `moveStore(target, ctx) -> {ok, path}`.
  - From `core/db.js`: `counts(db) -> {cards, saved}`. From `core/images.js`: `imageCount(storeDir) -> number`.
- Produces (HTTP, JSON):
  - `GET /api/store-location -> {path, counts:{cards,saved,images}}` — `path = ctx.storeDir`.
  - `POST /api/store-location/move {target} -> {ok, path}` — calls `moveStore(target, ctx)` (which copies/verifies/repoints and rebinds `ctx.db`/`ctx.storeDir`). After a successful move, the endpoint reads `ctx.storeDir` for the returned `path`.

- [ ] **Step 1: Add failing endpoint tests** — in `tests/server-backup-int.test.js`, insert these two `await run(...)` blocks just before the `srv.close();` line:

```js
    await run(t("GET /api/store-location reports path + counts"), async () => {
      const r = await (await fetch(base + "/api/store-location")).json();
      assert.strictEqual(r.path, ctx.storeDir);
      assert.ok(r.counts && typeof r.counts.images === "number");
    });

    await run(t("POST /api/store-location/move relocates the store"), async () => {
      const target = fs.mkdtempSync(path.join(os.tmpdir(), "ia-srvbk-mv-"));
      const r = await (await fetch(base + "/api/store-location/move", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ target })
      })).json();
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.path, target);
      assert.strictEqual(ctx.storeDir, target, "ctx repointed");
      assert.ok(fs.existsSync(path.join(target, "interests.db")), "db at target");
    });
```

- [ ] **Step 2: Run the test, expect FAIL** — store-location routes are not mounted:

```
node tests/server-backup-int.test.js
```

Expected: FAIL — `/api/store-location` 404 → assertion error on the two new cases (exit 1).

- [ ] **Step 3: Mount the routes** — edit `core/server.js`. Inside `createServer(ctx)`, after the `/api/health` route added in Task 6.6 and before `return app;`, add:

```js
  // ---- data location ----
  app.get("/api/store-location", (req, res) => {
    const c = counts(ctx.db);
    res.json({
      path: ctx.storeDir,
      counts: { cards: c.cards | 0, saved: c.saved | 0, images: imageCount(ctx.storeDir) | 0 }
    });
  });

  app.post("/api/store-location/move", (req, res) => {
    const target = req.body && req.body.target;
    if (!target) return res.status(400).json({ ok: false, error: "target required" });
    try {
      const out = backup.moveStore(target, ctx);   // repoints ctx.db/ctx.storeDir on success
      res.json({ ok: out.ok, path: ctx.storeDir });
    } catch (e) {
      res.status(500).json({ ok: false, path: ctx.storeDir, error: String(e && e.message || e) });
    }
  });
```

(`backup`, `counts`, and `imageCount` were already required in Task 6.6 — no new requires.)

- [ ] **Step 4: Run the test, expect PASS**:

```
node tests/server-backup-int.test.js
```

Expected: `7 passed, 0 failed` (exit 0).

- [ ] **Step 5: Commit**:

```
git add core/server.js tests/server-backup-int.test.js
git commit -m "Mount /api/store-location and /api/store-location/move endpoints

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6.9: Browser adapter `Store` backup/restore/store-move/health methods + register new tests in the runner

**Files:**
- Modify: `web/storage.js` (add `backupNow`, `listBackups`, `restore`, `storeLocation`, `moveStore`, `health` to the global `Store`)
- Modify: `tests/storage-adapter.test.js` (add request/response-mapping cases for the new methods)

**Interfaces:**
- Consumes: the REST endpoints from Tasks 6.6/6.8 — `POST /api/backup`, `GET /api/backups`, `POST /api/restore`, `GET /api/health`, `GET /api/store-location`, `POST /api/store-location/move`.
- Produces (on the global async `Store`):
  - `Store.backupNow() -> Promise<{ok,name,counts}>` (POST `/api/backup`).
  - `Store.listBackups() -> Promise<Array<{name,date,counts}>>` (GET `/api/backups`, returns the `backups` array).
  - `Store.restore(name) -> Promise<{ok}>` (POST `/api/restore` `{name}`).
  - `Store.storeLocation() -> Promise<{path,counts}>` (GET `/api/store-location`).
  - `Store.moveStore(target) -> Promise<{ok,path}>` (POST `/api/store-location/move` `{target}`).
  - `Store.health() -> Promise<{storePath,counts,lastBackup}>` (GET `/api/health`).

- [ ] **Step 1: Add failing adapter tests** — append these cases to `tests/storage-adapter.test.js`. They stub `global.fetch` to capture the URL/method/body the adapter builds and to feed a canned response, asserting the request shape and the response mapping. (This file and its `loadStore()` harness were created in Phase 3; reuse its existing fetch-stub helper. If the file does not exist, create it with the harness shown below.)

```js
/* ---- backup/restore/store-location adapter methods ---- */
// Minimal harness: load web/storage.js with a stubbed fetch and a localhost origin.
// (Reuse the Phase-3 loader if present; this self-contained version works standalone.)
function loadStoreWithFetch(fetchImpl) {
  const fs = require("fs"); const path = require("path"); const vm = require("vm");
  const code = fs.readFileSync(path.join(__dirname, "..", "web", "storage.js"), "utf8");
  const sandbox = { window: {}, fetch: fetchImpl, console };
  sandbox.window.location = { origin: "http://localhost:3456" };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.Store || sandbox.Store;
}

(async function () {
  let calls = [];
  function stub(respFor) {
    return async function (url, opts) {
      calls.push({ url, opts });
      const body = respFor(url, opts);
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    };
  }

  await run("Store.backupNow POSTs /api/backup and returns the result", async () => {
    calls = [];
    const Store = loadStoreWithFetch(stub(() => ({ ok: true, name: "interests-backup-2026-06-26", counts: { imported: 5, saved: 1, images: 4 } })));
    const r = await Store.backupNow();
    assert.ok(calls[0].url.endsWith("/api/backup"));
    assert.strictEqual((calls[0].opts && calls[0].opts.method) || "GET", "POST");
    assert.strictEqual(r.name, "interests-backup-2026-06-26");
  });

  await run("Store.listBackups GETs /api/backups and unwraps .backups", async () => {
    calls = [];
    const Store = loadStoreWithFetch(stub(() => ({ backups: [{ name: "interests-backup-2026-06-26", date: "2026-06-26", counts: {} }] })));
    const list = await Store.listBackups();
    assert.ok(calls[0].url.endsWith("/api/backups"));
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].name, "interests-backup-2026-06-26");
  });

  await run("Store.restore POSTs /api/restore with {name}", async () => {
    calls = [];
    const Store = loadStoreWithFetch(stub(() => ({ ok: true })));
    const r = await Store.restore("interests-backup-2026-06-26");
    assert.ok(calls[0].url.endsWith("/api/restore"));
    assert.strictEqual(calls[0].opts.method, "POST");
    assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { name: "interests-backup-2026-06-26" });
    assert.strictEqual(r.ok, true);
  });

  await run("Store.storeLocation GETs /api/store-location", async () => {
    calls = [];
    const Store = loadStoreWithFetch(stub(() => ({ path: "C:\\data", counts: { cards: 5, saved: 1, images: 4 } })));
    const r = await Store.storeLocation();
    assert.ok(calls[0].url.endsWith("/api/store-location"));
    assert.strictEqual(r.path, "C:\\data");
  });

  await run("Store.moveStore POSTs /api/store-location/move with {target}", async () => {
    calls = [];
    const Store = loadStoreWithFetch(stub(() => ({ ok: true, path: "D:\\newdata" })));
    const r = await Store.moveStore("D:\\newdata");
    assert.ok(calls[0].url.endsWith("/api/store-location/move"));
    assert.strictEqual(calls[0].opts.method, "POST");
    assert.deepStrictEqual(JSON.parse(calls[0].opts.body), { target: "D:\\newdata" });
    assert.strictEqual(r.path, "D:\\newdata");
  });

  await run("Store.health GETs /api/health", async () => {
    calls = [];
    const Store = loadStoreWithFetch(stub(() => ({ storePath: "C:\\data", counts: { cards: 5, saved: 1, images: 4 }, lastBackup: null })));
    const r = await Store.health();
    assert.ok(calls[0].url.endsWith("/api/health"));
    assert.strictEqual(r.storePath, "C:\\data");
  });

  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
```

If `tests/storage-adapter.test.js` does not yet exist, prepend this header before the block above so the file is self-contained:

```js
// tests/storage-adapter.test.js — request/URL building + response mapping for Store
const assert = require("assert");
let pass = 0, fail = 0;
async function run(name, fn) {
  try { await fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); }
}
```

- [ ] **Step 2: Run the test, expect FAIL** — the new `Store.*` methods don't exist:

```
node tests/storage-adapter.test.js
```

Expected: FAIL — `TypeError: Store.backupNow is not a function` (or similar) (exit 1).

- [ ] **Step 3: Add the methods to `web/storage.js`** — edit `web/storage.js`. Locate the object literal that defines `Store` (the global the file exposes) and add these methods. Use the file's existing base-URL/`apiFetch` helper if one exists; otherwise these self-contained bodies use `fetch` against the page origin:

```js
  // ---- backup / restore / store-location / health ----
  async backupNow() {
    const r = await fetch("/api/backup", { method: "POST" });
    return r.json();
  },
  async listBackups() {
    const r = await fetch("/api/backups");
    const j = await r.json();
    return (j && j.backups) || [];
  },
  async restore(name) {
    const r = await fetch("/api/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name })
    });
    return r.json();
  },
  async storeLocation() {
    const r = await fetch("/api/store-location");
    return r.json();
  },
  async moveStore(target) {
    const r = await fetch("/api/store-location/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: target })
    });
    return r.json();
  },
  async health() {
    const r = await fetch("/api/health");
    return r.json();
  },
```

- [ ] **Step 4: Run the test, expect PASS**:

```
node tests/storage-adapter.test.js
```

Expected: all cases pass (`6 passed, 0 failed` for the new methods; more if the file already had Phase-3 cases) (exit 0).

- [ ] **Step 5: Ensure the new test files run in `tests/run.js`** — the runner already globs `tests/*.test.js` (per the contract), so `backup.test.js`, `server-backup-int.test.js`, `storemove-int.test.js`, and `storage-adapter.test.js` are picked up automatically. Run the full suite to confirm nothing regressed (importantly, the legacy `tests/durability.test.js` and `tests/syntax-check.js` must still pass):

```
npm test
```

Expected: `tests/syntax-check.js` passes, `tests/durability.test.js` passes (13 cases incl. `pickBackupsToDelete`/`backupCountsMatch`), and all Phase 6 test files pass; overall exit 0.

- [ ] **Step 6: Commit**:

```
git add web/storage.js tests/storage-adapter.test.js
git commit -m "Add Store backup/restore/store-location/health adapter methods

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6.10: Wire Settings UI in `web/index.html` to `Store` (backup/restore list + Move data location)

**Files:**
- Modify: `web/index.html` (`backupNow`, `restoreLatest`, `restoreFromDir`, `restoreFromList`, `renderBackupList`, `connectFolder`; add a Move-data-location handler)

**Interfaces:**
- Consumes (global async `Store` from `web/storage.js`):
  - `Store.backupNow() -> Promise<{ok,name,counts}>`
  - `Store.listBackups() -> Promise<Array<{name,date,counts}>>`
  - `Store.restore(name) -> Promise<{ok}>`
  - `Store.storeLocation() -> Promise<{path,counts}>`
  - `Store.moveStore(target) -> Promise<{ok,path}>`
- Produces: UI handlers calling those methods. The File System Access API (`showDirectoryPicker`/`dirHandle`) path for backups is removed from these handlers; the destination folder for a move is supplied by the OS dialog via `preload.js` (e.g. `window.appNative.pickFolder()` if exposed) or a text input fallback.

- [ ] **Step 1: Add a failing syntax/wiring assertion** — extend `tests/syntax-check.js` is the inline-script parse gate; add a small dedicated assertion file `tests/settings-wiring.test.js` that reads `web/index.html` and asserts the Settings handlers now reference `Store.*` and no longer reference the removed `showDirectoryPicker`/`writeFullBackupDir` for backup. Create `tests/settings-wiring.test.js`:

```js
// tests/settings-wiring.test.js — Settings backup/restore/move handlers use Store.*
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

t("backupNow calls Store.backupNow()", () => {
  assert.ok(/Store\.backupNow\s*\(/.test(html), "Store.backupNow() not referenced");
});
t("renderBackupList calls Store.listBackups()", () => {
  assert.ok(/Store\.listBackups\s*\(/.test(html), "Store.listBackups() not referenced");
});
t("restore handler calls Store.restore(", () => {
  assert.ok(/Store\.restore\s*\(/.test(html), "Store.restore() not referenced");
});
t("Move data location calls Store.moveStore(", () => {
  assert.ok(/Store\.moveStore\s*\(/.test(html), "Store.moveStore() not referenced");
});
t("File System Access showDirectoryPicker removed from index.html", () => {
  assert.ok(!/showDirectoryPicker/.test(html), "showDirectoryPicker still present");
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run the test, expect FAIL** — the handlers still use the old folder/FS-Access path:

```
node tests/settings-wiring.test.js
```

Expected: FAIL — at least the `showDirectoryPicker removed` and `Store.moveStore` assertions fail (exit 1).

- [ ] **Step 3: Repoint `backupNow`** — edit `web/index.html`. Replace the body of `backupNow` (and the `doBackup`/`maybeAutoBackup` callers that wrote to a folder) so backup goes through the service. Replace:

```js
async function backupNow(){ return doBackup(true); }   // manual: button + Ctrl+Shift+B (bypasses the interval; shows progress)
```

with:

```js
async function backupNow(){
  showBusyOverlay && showBusyOverlay("Backing up to your Dropbox folder…");
  try{
    const r = await Store.backupNow();
    hideBusyOverlay && hideBusyOverlay();
    if(r && r.ok){
      markBackupDone(r.counts, true, "service", r.name);
      toast("Backup saved + verified ("+r.counts.imported+" imported, "+r.counts.images+" images)", 6000);
      if(typeof renderBackupList === "function") renderBackupList();
      return true;
    }
    toast("⚠ Backup failed — your older backups were kept.", 8000);
    return false;
  }catch(e){
    hideBusyOverlay && hideBusyOverlay();
    toast("⚠ Backup failed — "+(e && e.message)+". Older backups kept.", 8000);
    return false;
  }
}
```

- [ ] **Step 4: Repoint `maybeAutoBackup`** — replace:

```js
async function maybeAutoBackup(){
  const days = +S.autoBackup; if(!days) return;
  let last = 0; try{ last = +localStorage.getItem("ia_lastbackup") || 0; }catch(e){}
  if(Date.now() - last < days*86400000) return;
  await doBackup();
}
```

with:

```js
async function maybeAutoBackup(){
  const days = +S.autoBackup; if(!days) return;
  let last = 0; try{ last = +(await Store.kvGet("ia_lastbackup")) || 0; }catch(e){}
  if(Date.now() - last < days*86400000) return;
  try{
    const r = await Store.backupNow();
    if(r && r.ok) markBackupDone(r.counts, true, "service", r.name);
  }catch(e){ console.warn("auto-backup failed", e); }
}
```

- [ ] **Step 5: Repoint `renderBackupList` + restore handlers** — replace the body of `renderBackupList` so it lists service backups and wires each row to `Store.restore`. Replace:

```js
async function renderBackupList(){
```

through the end of that function with:

```js
async function renderBackupList(){
  const el = document.getElementById("backupList");
  if(!el) return;
  let list = [];
  try{ list = await Store.listBackups(); }catch(e){ list = []; }
  if(!list.length){ el.innerHTML = '<div class="hint">No backups yet.</div>'; return; }
  el.innerHTML = "";
  for(const b of list){
    const row = document.createElement("div"); row.className = "backupRow";
    const c = b.counts || {};
    row.innerHTML = '<span>'+b.name+'</span> <span class="hint">'+
      ((c.imported!=null? c.imported+" imported, ":"")+(c.images!=null? c.images+" images":""))+'</span>';
    const btn = document.createElement("button"); btn.textContent = "Restore";
    btn.onclick = function(){ restoreFromList(b.name); };
    row.appendChild(btn); el.appendChild(row);
  }
}
async function restoreFromList(name){
  if(!confirm("Restore "+name+"? A safety snapshot of your current data is taken first.")) return;
  showBusyOverlay && showBusyOverlay("Restoring "+name+"…");
  try{
    const r = await Store.restore(name);
    hideBusyOverlay && hideBusyOverlay();
    if(r && r.ok){ toast("Restored "+name+". Reloading…", 4000); setTimeout(function(){ location.reload(); }, 800); }
    else toast("⚠ Restore failed.", 8000);
  }catch(e){ hideBusyOverlay && hideBusyOverlay(); toast("⚠ Restore failed — "+(e && e.message), 8000); }
}
async function restoreLatest(){
  let list = []; try{ list = await Store.listBackups(); }catch(e){}
  if(!list.length){ toast("No backups to restore.", 5000); return; }
  return restoreFromList(list[0].name);
}
```

- [ ] **Step 6: Replace the folder-connect / FS-Access entry point with a Move-data-location handler** — replace the `connectFolder`/`restoreFromDir` machinery that called `showDirectoryPicker`. Replace the `connectFolder` function body with a store-move handler (and delete the `restoreFromDir`/`restoreFolder` FS-Access bodies, folding their UI into `restoreFromList`):

```js
// Settings → Data location. Shows the current store path and moves it on request.
async function renderStoreLocation(){
  const el = document.getElementById("storeLocation");
  if(!el) return;
  try{
    const loc = await Store.storeLocation();
    el.textContent = loc.path + "  ("+ (loc.counts && loc.counts.cards||0) +" cards, "+ (loc.counts && loc.counts.images||0) +" images)";
  }catch(e){ el.textContent = "(unknown)"; }
}
async function moveDataLocation(){
  let target = "";
  if(window.appNative && window.appNative.pickFolder){ target = await window.appNative.pickFolder(); }
  else { target = prompt("New data folder (full path):", ""); }
  if(!target) return;
  showBusyOverlay && showBusyOverlay("Moving your data to "+target+"…");
  try{
    const r = await Store.moveStore(target);
    hideBusyOverlay && hideBusyOverlay();
    if(r && r.ok){ toast("Data moved to "+r.path+". The old copy was kept.", 7000); renderStoreLocation(); }
    else toast("⚠ Move failed — your data was NOT moved (still safe at the old location).", 9000);
  }catch(e){ hideBusyOverlay && hideBusyOverlay(); toast("⚠ Move failed — "+(e && e.message)+". Data unchanged.", 9000); }
}
```

Then search `web/index.html` for any remaining call sites of the removed functions (`doBackup`, `writeFullBackupDir`, `verifyBackupDir`, `rotateBackups`, `connectFolder`, `restoreFromDir`, `restoreFolder`, `folderReady`, `dirHandle`, `showDirectoryPicker`) and either delete them or repoint them to the new handlers, so no reference to `showDirectoryPicker` remains. Wire the Settings "Move…" button's `onclick` to `moveDataLocation` and the data-location label to `renderStoreLocation` (call `renderStoreLocation()` where the Settings panel is shown).

- [ ] **Step 7: Run the wiring test + full suite, expect PASS**:

```
node tests/settings-wiring.test.js
npm test
```

Expected: `settings-wiring.test.js` → `5 passed, 0 failed`; `npm test` → syntax gate passes (the inline `<script>` in `web/index.html` still parses), `durability.test.js` passes, and all Phase 6 tests pass; overall exit 0.

- [ ] **Step 8: Commit**:

```
git add web/index.html tests/settings-wiring.test.js
git commit -m "Wire Settings backup/restore list + Move-data-location to Store; remove File System Access API

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```


## Phase 7: Packaging & formalized setup wizard

### Task 7.1: Add electron-builder NSIS build config to package.json

Adds the full `build` block to `package.json` that drives the assisted wizard (`oneClick:false`, choose-dir, per-user, shortcuts) and excludes the live `data/` library from the asar/app payload. This is the smallest independently testable unit: a `build-config.test.js` that `require()`s `package.json` and asserts the exact config shape. No installer is produced here — only the declarative config the packager reads.

**Files:**
- Modify: `package.json` (add top-level `build` object; ensure `electron-builder` devDependency and `dist` script exist)
- Create: `tests/build-config.test.js`

**Interfaces:**
- Consumes: existing `package.json` produced in Phase 1 (fields `name`, `version`, `main`, `scripts.test = "node tests/run.js"`). The Phase 1 Electron app entry is `main.js`; the live store default is `<install>/data/` per `core/config.js#defaultStoreDir()` (`path.join(path.dirname(app.getPath('exe')),'data')` when packaged).
- Produces: `package.json` `build` object with `appId`, `productName`, `directories.buildResources = "build"`, `files` array that EXCLUDES `data/`, `win.target = "nsis"`, `nsis.{oneClick:false, perMachine:false, allowToChangeInstallationDirectory:true, createDesktopShortcut:true, createStartMenuShortcut:true, artifactName, include:"build/installer.nsh"}`. Later tasks (7.2 installer.nsh, 7.3 icons) attach files referenced by `nsis.include` and `build/icon.ico`.

- [ ] **Step 1: Read current package.json to capture exact existing fields.**
  Run this to confirm `name`, `version`, `main`, and that `scripts.test` is already wired (do not guess — read it):
  ```
  node -e "const p=require('./package.json'); console.log(JSON.stringify({name:p.name,version:p.version,main:p.main,test:p.scripts&&p.scripts.test,hasBuild:!!p.build,eb:(p.devDependencies||{})['electron-builder']}))"
  ```
  Expected output names the existing `name`/`version`/`main` and shows `"hasBuild":false`. Note the exact `name` and `version` values for use below.

- [ ] **Step 2: Write the failing build-config test.**
  Create `tests/build-config.test.js` with the COMPLETE assertions the contract requires (oneClick false, allowToChangeInstallationDirectory true, perMachine false, include points to `build/installer.nsh`, asar/files excludes the `data` folder):
  ```js
  // tests/build-config.test.js
  // Asserts the electron-builder NSIS config in package.json matches the design contract.
  const assert = require("assert");
  const path = require("path");
  const pkg = require(path.join(__dirname, "..", "package.json"));

  let pass = 0, fail = 0;
  function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

  t("build block exists", () => {
    assert.ok(pkg.build && typeof pkg.build === "object", "package.json.build missing");
  });
  t("appId and productName set", () => {
    assert.ok(pkg.build.appId, "build.appId missing");
    assert.ok(pkg.build.productName, "build.productName missing");
  });
  t("buildResources points at build/", () => {
    assert.strictEqual(pkg.build.directories && pkg.build.directories.buildResources, "build");
  });
  t("nsis.oneClick === false (assisted wizard)", () => {
    assert.strictEqual(pkg.build.nsis.oneClick, false);
  });
  t("nsis.allowToChangeInstallationDirectory === true", () => {
    assert.strictEqual(pkg.build.nsis.allowToChangeInstallationDirectory, true);
  });
  t("nsis.perMachine === false (per-user install)", () => {
    assert.strictEqual(pkg.build.nsis.perMachine, false);
  });
  t("nsis creates desktop + start-menu shortcuts", () => {
    assert.strictEqual(pkg.build.nsis.createDesktopShortcut, true);
    assert.strictEqual(pkg.build.nsis.createStartMenuShortcut, true);
  });
  t("nsis.artifactName defined", () => {
    assert.ok(pkg.build.nsis.artifactName, "build.nsis.artifactName missing");
  });
  t("nsis.include points to build/installer.nsh", () => {
    assert.strictEqual(pkg.build.nsis.include, "build/installer.nsh");
  });
  t("win target is nsis", () => {
    const tg = pkg.build.win && pkg.build.win.target;
    const ok = tg === "nsis" || (Array.isArray(tg) && tg.includes("nsis")) ||
      (Array.isArray(tg) && tg.some(x => x && x.target === "nsis"));
    assert.ok(ok, "build.win.target must include nsis");
  });
  t("packaging excludes the data folder (asar payload)", () => {
    assert.ok(Array.isArray(pkg.build.files), "build.files must be an array");
    const excludesData = pkg.build.files.some(f =>
      typeof f === "string" && /^!data(\/|$|\/\*)/.test(f.replace(/\\/g, "/")));
    assert.ok(excludesData, "build.files must contain an exclusion like '!data/**/*'");
  });

  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
  ```

- [ ] **Step 3: Run the test and confirm it FAILS.**
  ```
  node tests/build-config.test.js
  ```
  Expected: FAIL on "build block exists" (and cascading failures), final line shows non-zero failed count, exit code 1, because `package.json` has no `build` object yet.

- [ ] **Step 4: Add the build block to package.json.**
  Insert this `build` object as a top-level key in `package.json` (place it after `"scripts"`). Use the existing `name`/`version` you noted in Step 1; the values below are literal and complete:
  ```json
  "build": {
    "appId": "com.dbarrante.interestsapp",
    "productName": "Interests App",
    "directories": {
      "buildResources": "build",
      "output": "dist"
    },
    "files": [
      "main.js",
      "preload.js",
      "core/**/*",
      "web/**/*",
      "extension/**/*",
      "node_modules/**/*",
      "package.json",
      "!data/**/*",
      "!dist/**/*",
      "!tests/**/*",
      "!docs/**/*"
    ],
    "asar": true,
    "win": {
      "target": "nsis",
      "icon": "build/icon.ico"
    },
    "nsis": {
      "oneClick": false,
      "perMachine": false,
      "allowToChangeInstallationDirectory": true,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true,
      "artifactName": "Interests-App-Setup-${version}.${ext}",
      "include": "build/installer.nsh",
      "deleteAppDataOnUninstall": false
    }
  }
  ```

- [ ] **Step 5: Ensure the packaging tooling + dist script are present.**
  Add `electron-builder` to `devDependencies` and a `dist` script if absent. Run:
  ```
  node -e "const fs=require('fs'),p=require('./package.json');p.devDependencies=p.devDependencies||{};if(!p.devDependencies['electron-builder'])p.devDependencies['electron-builder']='^24.13.3';p.scripts=p.scripts||{};if(!p.scripts.dist)p.scripts.dist='electron-builder --win nsis';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');console.log('devDeps eb:',p.devDependencies['electron-builder'],'| dist:',p.scripts.dist)"
  ```
  Expected output prints the `electron-builder` version and `dist: electron-builder --win nsis`. (Native `better-sqlite3` is rebuilt for the Electron ABI by the Phase 1 `electron-rebuild`/postinstall step before this `dist` runs; packaging picks up the Electron-ABI binary.)

- [ ] **Step 6: Run the test and confirm it PASSES.**
  ```
  node tests/build-config.test.js
  ```
  Expected: every line prints `ok`, final line shows `12 passed, 0 failed`, exit code 0.

- [ ] **Step 7: Confirm the full suite still passes (build-config picked up by run.js).**
  ```
  node tests/run.js
  ```
  Expected: syntax-check, durability, and all `*.test.js` (including `build-config.test.js`) pass; final aggregate shows 0 failed, exit code 0.

- [ ] **Step 8: Commit.**
  ```
  git add package.json tests/build-config.test.js
  git commit -m "Add electron-builder NSIS build config + build-config test

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 7.2: Custom NSIS include — preserve data/ on update, prompt on uninstall

Creates `build/installer.nsh`, the custom NSIS include referenced by `package.json` `build.nsis.include`. It macro-excludes the `data/` subfolder from removal during an update and adds an uninstaller `MessageBox` asking "Also delete your saved library?" defaulting to **No**. This protects the live library (`<install>/data/`) across reinstalls — the core data-safety guarantee of the packaging phase.

**Files:**
- Create: `build/installer.nsh`
- Modify: `tests/build-config.test.js` (extend with assertions that `build/installer.nsh` exists and contains the required macros/prompt)

**Interfaces:**
- Consumes: `package.json` `build.nsis.include === "build/installer.nsh"` (asserted in Task 7.1). The live store path is `$INSTDIR\data` per `core/config.js#defaultStoreDir()`; the persistent pointer at `%APPDATA%\Interests App\config.json` (`core/config.js#configPath()`) is NOT under `$INSTDIR` and is therefore never removed by the installer.
- Produces: `build/installer.nsh` defining `customRemoveFiles` (excludes `$INSTDIR\data` on update) and `customUnInstall` (MessageBox MB_YESNO|MB_DEFBUTTON2 → `RMDir /r "$INSTDIR\data"` only on Yes). electron-builder invokes these named macros automatically.

- [ ] **Step 1: Extend build-config.test.js with failing installer.nsh assertions.**
  Append these checks to `tests/build-config.test.js`, immediately BEFORE the final `console.log(pass + ...)` line:
  ```js
  const fs = require("fs");
  const nshPath = path.join(__dirname, "..", "build", "installer.nsh");
  t("build/installer.nsh exists", () => {
    assert.ok(fs.existsSync(nshPath), "build/installer.nsh missing");
  });
  t("installer.nsh keeps data/ on update via customRemoveFiles", () => {
    const nsh = fs.readFileSync(nshPath, "utf8");
    assert.ok(/!macro\s+customRemoveFiles/i.test(nsh), "customRemoveFiles macro missing");
    assert.ok(/\$INSTDIR\\data/i.test(nsh), "must reference $INSTDIR\\data");
    assert.ok(/isUpdated/i.test(nsh), "must branch on the update flag (isUpdated)");
  });
  t("installer.nsh uninstaller prompts before deleting the library (default No)", () => {
    const nsh = fs.readFileSync(nshPath, "utf8");
    assert.ok(/!macro\s+customUnInstall/i.test(nsh), "customUnInstall macro missing");
    assert.ok(/MB_YESNO/i.test(nsh), "uninstall MessageBox must be MB_YESNO");
    assert.ok(/MB_DEFBUTTON2/i.test(nsh), "default button must be No (MB_DEFBUTTON2)");
    assert.ok(/Also delete your saved library/i.test(nsh), "uninstall prompt text missing");
    assert.ok(/RMDir\s+\/r\s+"\$INSTDIR\\data"/i.test(nsh), "library delete (RMDir /r data) missing");
  });
  ```

- [ ] **Step 2: Run the test and confirm the new checks FAIL.**
  ```
  node tests/build-config.test.js
  ```
  Expected: the three new `installer.nsh` checks FAIL ("build/installer.nsh missing"), final line shows 3 failed, exit code 1. (The Task 7.1 checks still pass.)

- [ ] **Step 3: Create build/installer.nsh.**
  Write `build/installer.nsh` with the COMPLETE macros. `customRemoveFiles` runs in place of electron-builder's default file removal: on an update (`${isUpdated}`) it skips the `data` folder so the library survives; on a fresh install path it removes app files but still leaves `data` to `customUnInstall`:
  ```nsh
  ; build/installer.nsh — Interests App custom NSIS include.
  ; Goals:
  ;   1) Preserve the live library ($INSTDIR\data) across UPDATES.
  ;   2) On full uninstall, ask before deleting the saved library (default No).

  ; Replaces electron-builder's default app-file removal so we can spare $INSTDIR\data.
  !macro customRemoveFiles
    ${if} ${isUpdated}
      ; Updating in place: remove app files but KEEP the user's data folder.
      RMDir /r "$INSTDIR\resources"
      RMDir /r "$INSTDIR\locales"
      Delete "$INSTDIR\*.dll"
      Delete "$INSTDIR\*.exe"
      Delete "$INSTDIR\*.pak"
      Delete "$INSTDIR\*.bin"
      Delete "$INSTDIR\*.dat"
      Delete "$INSTDIR\*.json"
      Delete "$INSTDIR\LICENSE*"
      Delete "$INSTDIR\version"
      ; NOTE: deliberately do NOT touch "$INSTDIR\data".
    ${else}
      ; Fresh (re)install over an existing dir: clear everything EXCEPT data.
      RMDir /r "$INSTDIR\resources"
      RMDir /r "$INSTDIR\locales"
      Delete "$INSTDIR\*.dll"
      Delete "$INSTDIR\*.exe"
      Delete "$INSTDIR\*.pak"
      Delete "$INSTDIR\*.bin"
      Delete "$INSTDIR\*.dat"
      Delete "$INSTDIR\*.json"
      Delete "$INSTDIR\LICENSE*"
      Delete "$INSTDIR\version"
    ${endif}
  !macroend

  ; Runs during uninstall. Offer to delete the saved library; default is No (keep it).
  !macro customUnInstall
    ${ifNot} ${isUpdated}
      ${if} ${FileExists} "$INSTDIR\data\*.*"
        MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
          "Also delete your saved library?$\r$\n$\r$\nThis permanently removes your cards, saved clips, and images stored in:$\r$\n$INSTDIR\data$\r$\n$\r$\nChoose No to keep your library (recommended)." \
          /SD IDNO IDYES uninstLibraryYes IDNO uninstLibraryNo
        uninstLibraryYes:
          RMDir /r "$INSTDIR\data"
          Goto uninstLibraryDone
        uninstLibraryNo:
          ; Keep the library; leave $INSTDIR\data in place.
        uninstLibraryDone:
      ${endif}
    ${endif}
  !macroend
  ```

- [ ] **Step 4: Run the test and confirm it PASSES.**
  ```
  node tests/build-config.test.js
  ```
  Expected: all checks print `ok` (Task 7.1 checks + the 3 installer.nsh checks), final line shows `15 passed, 0 failed`, exit code 0.

- [ ] **Step 5: Run the full suite.**
  ```
  node tests/run.js
  ```
  Expected: every test file passes, aggregate 0 failed, exit code 0.

- [ ] **Step 6: Commit.**
  ```
  git add build/installer.nsh tests/build-config.test.js
  git commit -m "Add NSIS installer.nsh: preserve data/ on update, prompt on uninstall

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 7.3: Installer icons + icon wiring

Adds the application/installer icon asset (`build/icon.ico`) that electron-builder uses for the EXE, Start-menu/desktop shortcuts, and the NSIS wizard, and asserts `package.json` references it. This is a small, independently reviewable deliverable: the test confirms the icon file exists and the `build.win.icon`/`build.nsis` config points at it, so a later `electron-builder` run cannot fail on a missing icon.

**Files:**
- Create: `build/icon.ico` (binary, generated)
- Modify: `tests/build-config.test.js` (extend with icon-presence + reference assertions)

**Interfaces:**
- Consumes: `package.json` `build.win.icon` (set to `build/icon.ico` in Task 7.1) and `build.directories.buildResources === "build"`.
- Produces: `build/icon.ico` (multi-size Windows ICO, includes a 256x256 frame so NSIS accepts it). No code interface; consumed only by the packager.

- [ ] **Step 1: Extend build-config.test.js with failing icon assertions.**
  Append these checks to `tests/build-config.test.js`, immediately BEFORE the final `console.log(pass + ...)` line (the `fs` and `path` requires already exist from earlier tasks):
  ```js
  const icoPath = path.join(__dirname, "..", "build", "icon.ico");
  t("build/icon.ico exists", () => {
    assert.ok(fs.existsSync(icoPath), "build/icon.ico missing");
  });
  t("build/icon.ico is a valid ICO (header + non-trivial size)", () => {
    const buf = fs.readFileSync(icoPath);
    // ICO header: reserved=0x0000, type=0x0001 (icon)
    assert.strictEqual(buf.readUInt16LE(0), 0, "ICO reserved field must be 0");
    assert.strictEqual(buf.readUInt16LE(2), 1, "ICO type field must be 1 (icon)");
    assert.ok(buf.readUInt16LE(4) >= 1, "ICO must declare at least one image");
    assert.ok(buf.length > 1000, "ICO unexpectedly tiny");
  });
  t("package.json win.icon points at build/icon.ico", () => {
    assert.strictEqual(pkg.build.win.icon, "build/icon.ico");
  });
  ```

- [ ] **Step 2: Run the test and confirm the icon checks FAIL.**
  ```
  node tests/build-config.test.js
  ```
  Expected: the three new icon checks FAIL ("build/icon.ico missing"), final line shows 3 failed, exit code 1.

- [ ] **Step 3: Generate build/icon.ico programmatically.**
  Create the ICO with a one-off Node script so no external image tool is required. This writes a valid multi-frame ICO (16/32/48/256) built from solid-color BGRA bitmaps so NSIS and the EXE both accept it:
  ```
  node -e "
  const fs=require('fs');
  const sizes=[16,32,48,256];
  function frame(s){
    const bmpW=s, bmpH=s;
    const rowBytes=bmpW*4;
    const pixels=Buffer.alloc(rowBytes*bmpH);
    for(let y=0;y<bmpH;y++)for(let x=0;x<bmpW;x++){
      const o=y*rowBytes+x*4;
      pixels[o]=0x5b; pixels[o+1]=0x3a; pixels[o+2]=0x1f; pixels[o+3]=0xff; // BGRA brand-ish brown
    }
    const andMask=Buffer.alloc((Math.ceil(bmpW/32)*4)*bmpH,0);
    const hdr=Buffer.alloc(40);
    hdr.writeUInt32LE(40,0);
    hdr.writeInt32LE(bmpW,4);
    hdr.writeInt32LE(bmpH*2,8); // height doubled for XOR+AND
    hdr.writeUInt16LE(1,12);
    hdr.writeUInt16LE(32,14);
    hdr.writeUInt32LE(0,16);
    hdr.writeUInt32LE(pixels.length+andMask.length,20);
    return Buffer.concat([hdr,pixels,andMask]);
  }
  const frames=sizes.map(frame);
  const count=frames.length;
  const head=Buffer.alloc(6);
  head.writeUInt16LE(0,0); head.writeUInt16LE(1,2); head.writeUInt16LE(count,4);
  const dir=Buffer.alloc(16*count);
  let offset=6+16*count;
  for(let i=0;i<count;i++){
    const s=sizes[i], f=frames[i], d=i*16;
    dir.writeUInt8(s>=256?0:s,d);
    dir.writeUInt8(s>=256?0:s,d+1);
    dir.writeUInt8(0,d+2); dir.writeUInt8(0,d+3);
    dir.writeUInt16LE(1,d+4); dir.writeUInt16LE(32,d+6);
    dir.writeUInt32LE(f.length,d+8); dir.writeUInt32LE(offset,d+12);
    offset+=f.length;
  }
  fs.mkdirSync('build',{recursive:true});
  fs.writeFileSync('build/icon.ico',Buffer.concat([head,dir,...frames]));
  console.log('wrote build/icon.ico',fs.statSync('build/icon.ico').size,'bytes');
  "
  ```
  Expected output: `wrote build/icon.ico <N> bytes` where N is well above 1000.

- [ ] **Step 4: Run the test and confirm it PASSES.**
  ```
  node tests/build-config.test.js
  ```
  Expected: all checks print `ok` (Task 7.1 + 7.2 + 7.3 icon checks), final line shows `18 passed, 0 failed`, exit code 0.

- [ ] **Step 5: Run the full suite.**
  ```
  node tests/run.js
  ```
  Expected: every test file passes, aggregate 0 failed, exit code 0.

- [ ] **Step 6: Commit.**
  ```
  git add build/icon.ico tests/build-config.test.js
  git commit -m "Add installer/app icon (build/icon.ico) and wire into build config

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

---

### Task 7.4: docs/INSTALL.md smoke checklist

Adds the human smoke-test checklist the user runs after building/installing: install via wizard, choose a directory, launch, migrate a legacy backup, see the library, capture one post via the extension, back up, restore, and move the store. A tiny `docs/install-doc.test.js` asserts the doc exists and covers each required step so the checklist can't silently drop a step.

**Files:**
- Create: `docs/INSTALL.md`
- Create: `tests/install-doc.test.js`

**Interfaces:**
- Consumes: behavior from earlier phases referenced by the checklist — extension HTTP delivery `POST /api/captures` and port probe `GET /api/ping` (Phase 5); migration `POST /api/import {srcDir}` (Phase 4); `POST /api/backup`, `GET /api/backups`, `POST /api/restore {name}` (Phase 6); `GET /api/store-location` + `POST /api/store-location/move {target}` (Phase 6); store pointer at `%APPDATA%\Interests App\config.json` (`core/config.js`).
- Produces: `docs/INSTALL.md` (documentation only; no runtime interface).

- [ ] **Step 1: Write the failing doc test.**
  Create `tests/install-doc.test.js` asserting `docs/INSTALL.md` exists and mentions each required smoke step:
  ```js
  // tests/install-doc.test.js
  // Asserts docs/INSTALL.md covers every required smoke-checklist step.
  const assert = require("assert");
  const fs = require("fs");
  const path = require("path");

  let pass = 0, fail = 0;
  function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

  const docPath = path.join(__dirname, "..", "docs", "INSTALL.md");
  t("docs/INSTALL.md exists", () => {
    assert.ok(fs.existsSync(docPath), "docs/INSTALL.md missing");
  });
  const doc = fs.existsSync(docPath) ? fs.readFileSync(docPath, "utf8") : "";
  const lc = doc.toLowerCase();
  const required = [
    ["install step", /install/i],
    ["choose-directory wizard step", /choose.*(folder|directory|install)/i],
    ["launch step", /launch|start menu|open the app/i],
    ["migrate step", /migrate|import/i],
    ["see library step", /library|cards/i],
    ["capture via extension step", /capture/i],
    ["extension mention", /extension/i],
    ["backup step", /back ?up/i],
    ["restore step", /restore/i],
    ["move store step", /move.*(store|data|location)|data location/i],
    ["SmartScreen note", /smartscreen|unknown publisher/i],
  ];
  required.forEach(([label, re]) => {
    t("checklist covers: " + label, () => {
      assert.ok(re.test(doc), "INSTALL.md is missing the " + label);
    });
  });
  t("is a non-trivial checklist (has checkbox items)", () => {
    assert.ok((doc.match(/- \[ \]/g) || []).length >= 8, "expected at least 8 checklist items");
  });

  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
  ```

- [ ] **Step 2: Run the test and confirm it FAILS.**
  ```
  node tests/install-doc.test.js
  ```
  Expected: FAIL on "docs/INSTALL.md exists" and the coverage checks, final line shows non-zero failed, exit code 1.

- [ ] **Step 3: Create docs/INSTALL.md.**
  Write the COMPLETE checklist:
  ```markdown
  # Interests App — Install & Smoke Checklist

  This is the manual round-trip to run after building the installer (`npm run dist`)
  and before sharing it. It proves the packaged app installs, finds its data, accepts
  a capture from the extension, and survives backup/restore and a store move.

  The build artifact is `dist/Interests-App-Setup-<version>.exe`.

  ## Install (assisted wizard)

  - [ ] Run `dist/Interests-App-Setup-<version>.exe`. Windows SmartScreen may show
        **"Windows protected your PC / unknown publisher"** (expected — v1 is unsigned).
        Click **More info → Run anyway**.
  - [ ] At the wizard, **choose the install folder** (the default is
        `%LOCALAPPDATA%\Programs\Interests App\`). Confirm the **Change…** option is
        available — per-user install, no admin prompt.
  - [ ] Leave **Create desktop shortcut** and **Create Start-menu shortcut** checked.
        Finish the wizard with **Launch** enabled.

  ## Launch & data location

  - [ ] The app **launches** as its own window (not a browser tab). The Start-menu
        entry **Interests App** also opens it.
  - [ ] In **Settings → Data location**, confirm the store path is
        `<install>\data\` and that `%APPDATA%\Interests App\config.json` records it.

  ## Migrate the legacy library

  - [ ] Run the one-time **Import / Migrate** against an existing Dropbox legacy backup
        folder (`interests-backup-<date>\` containing `data.json` + `img-*.json`).
  - [ ] Confirm the verification report (e.g. "5,500 cards, 18 saved, 4,303 images —
        all present"); note any card flagged with a missing image.

  ## See the library

  - [ ] The main view renders **cards** with their images, and the **Saved** view shows
        saved clips. Spot-check a few thumbnails load (served from `/api/img/<id>`).

  ## Capture one post via the extension

  - [ ] In Chrome (logged into a social site), trigger a capture with the
        **capture extension**. The extension probes ports `3456..3465` (`/api/ping`)
        to find the app and **POSTs the capture** to it.
  - [ ] Confirm the new card appears in the app **without an app tab open in Chrome**.
        Close the app, capture again, reopen — the queued capture is delivered on
        reconnect.

  ## Back up

  - [ ] Click **Back up now**. Confirm a dated folder appears under
        `Dropbox\Interests App\backups\interests-backup-<date>\` containing
        `interests.db` and copied images. The verification reports matching counts.

  ## Restore

  - [ ] From the backup list, **Restore** the just-made backup. Confirm a safety
        snapshot of the current store is taken first, then counts match after restore.

  ## Move the data store

  - [ ] **Settings → Data location → Move…** to a new folder. Confirm the app copies
        `interests.db` + `images\`, **verifies counts**, repoints the `%APPDATA%`
        pointer, and reopens from the new path. The **old copy is left intact** until
        the move verifies.

  ## Update & uninstall safety (optional, recommended)

  - [ ] Install a newer build over the existing one — confirm the **library survives**
        (the `data\` folder is preserved on update).
  - [ ] Run the uninstaller — confirm it **prompts "Also delete your saved library?"**
        defaulting to **No**, and that choosing No leaves `<install>\data\` in place.
  ```

- [ ] **Step 4: Run the test and confirm it PASSES.**
  ```
  node tests/install-doc.test.js
  ```
  Expected: every check prints `ok`, final line shows `13 passed, 0 failed`, exit code 0.

- [ ] **Step 5: Run the full suite.**
  ```
  node tests/run.js
  ```
  Expected: every test file passes (syntax-check, durability, build-config, install-doc), aggregate 0 failed, exit code 0.

- [ ] **Step 6: Commit.**
  ```
  git add docs/INSTALL.md tests/install-doc.test.js
  git commit -m "Add INSTALL.md smoke checklist + coverage test

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```


## Phase 8: Final verification (test sweep + manual smoke)

## Phase 8: Final verification (test sweep + manual smoke)

This phase adds **no new feature code**. It is the final gate before the subagent-driven adversarial review and the user's verification pass. Every artifact referenced here is produced by Phases 1–7: `package.json` (with `scripts.test = "node tests/run.js"`, `scripts.rebuild` invoking `@electron/rebuild`, and the electron-builder NSIS config), the `core/` modules, `main.js`, `preload.js`, `web/index.html` + `web/storage.js`, the `tests/*.test.js` suite + `tests/run.js`, the `extension/` HTTP bridge, and `docs/INSTALL.md` (with the smoke checklist). This phase runs the automated gate, proves the installer builds, then drives the manual smoke checklist.

Because `tests/run.js` is the single entry point that runs `tests/syntax-check.js` first and then every `tests/*.test.js`, the whole automated suite is exercised through `npm test`. `@electron/rebuild` is required before packaging because `better-sqlite3` is a native module: the dev test run uses the plain Node ABI, but the packaged app loads it under the Electron ABI, so `electron-builder` must repackage a binary rebuilt for Electron.

### Task 8.1: Green automated test sweep

**Files:**
- Modify: `docs/VERIFICATION.md` (Create if absent) — append the dated "Automated sweep" result block produced by this task.

**Interfaces:**
- Consumes: `package.json` `scripts.test = "node tests/run.js"` (from Phase 1/2); `tests/run.js` which runs `node tests/syntax-check.js` then every `tests/*.test.js`, printing `<p> passed, <f> failed` per file and exiting non-zero on any failure (from Phase 2); the existing `tests/syntax-check.js` (inline-`<script>` parse gate on `web/index.html`) and `tests/durability.test.js` (pure-logic units) which MUST still pass.
- Produces: a recorded sweep result (no code symbols); no functions consumed by later tasks.

- [ ] **Step 1: Confirm the test entry point is wired.** Run the exact command and read `package.json`'s `scripts.test` value back. Expected: it prints `node tests/run.js`.
  ```bash
  node -e "process.stdout.write(require('./package.json').scripts.test)"
  ```
  Expected output (exact): `node tests/run.js`

- [ ] **Step 2: Enumerate the test files the runner will execute.** This is the manifest the sweep must cover. Run:
  ```bash
  node -e "const fs=require('fs');console.log(fs.readdirSync('tests').filter(f=>f.endsWith('.test.js')).sort().join('\n'))"
  ```
  Expected: the list includes (at minimum) `durability.test.js`, plus every test file added by Phases 2–6, e.g. `config.test.js`, `db.test.js`, `images.test.js`, `server.test.js`, `storage.test.js`, `importer.test.js`, `backup.test.js`. If any expected file is missing, STOP — a prior phase is incomplete; do not proceed to packaging.

- [ ] **Step 3: Run the full automated gate via the project's test script.** This runs the syntax gate then every `tests/*.test.js`:
  ```bash
  npm test
  ```
  Expected: the syntax check prints `N script block(s), 0 error(s)`, every `*.test.js` prints `<p> passed, 0 failed`, and the process exits `0`. If ANY file reports `failed` > 0 or the process exits non-zero, STOP and report the failing file + assertion verbatim — do NOT continue to packaging.

- [ ] **Step 4: Capture the exit code explicitly** (Windows/PowerShell-safe proof the suite is green). Run:
  ```bash
  npm test; echo "EXIT=$?"
  ```
  Expected final line (exact): `EXIT=0`

- [ ] **Step 5: Record the sweep result.** Create or append to `docs/VERIFICATION.md` with the dated outcome. Write this exact block (fill the two `<...>` placeholders with the real numbers printed in Steps 3–4 before committing — they are the only values that vary):
  ```markdown
  ## Automated sweep — 2026-06-26

  - Command: `npm test`
  - Syntax gate: `web/index.html` inline scripts parsed, 0 errors.
  - Suite: <N> test files, all `<p> passed, 0 failed`.
  - Exit code: 0.
  - Result: PASS — automated gate green; cleared to package.
  ```

- [ ] **Step 6: Commit the recorded sweep.**
  ```bash
  git add docs/VERIFICATION.md
  git commit -m "Phase 8: record green automated test sweep (npm test, exit 0)

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

### Task 8.2: Native rebuild + installer build proof

**Files:**
- Modify: `docs/VERIFICATION.md` (Build proof area) — append the "Installer build" result block produced by this task.

**Interfaces:**
- Consumes: `package.json` `scripts.rebuild` invoking `@electron/rebuild` (from Phase 1/7) which rebuilds `better-sqlite3` for the Electron ABI; the electron-builder NSIS config in `package.json`/`electron-builder.yml` (`oneClick:false`, `perMachine:false`, `allowToChangeInstallationDirectory:true`, `build/installer.nsh`) from Phase 7; `main.js` as the Electron entry that starts the Core service and loads `http://localhost:<port>/` (from Phase 1).
- Produces: a built, runnable NSIS installer under `dist/`; a recorded build-proof result (no code symbols).

- [ ] **Step 1: Confirm the rebuild + dist scripts exist.** Run:
  ```bash
  node -e "const s=require('./package.json').scripts;console.log('rebuild='+(s.rebuild||'MISSING'));console.log('dist='+(s.dist||'MISSING'))"
  ```
  Expected: `rebuild=` shows a command containing `electron-rebuild` (or `@electron/rebuild`); `dist=` shows a command invoking `electron-builder`. If either prints `MISSING`, STOP — Phase 7 packaging config is incomplete.

- [ ] **Step 2: Rebuild the native module for the Electron ABI.** `better-sqlite3` is native; the dev tests ran against the Node ABI, so it must be rebuilt for Electron before packaging. Run:
  ```bash
  npm run rebuild
  ```
  Expected: `@electron/rebuild` reports it rebuilt `better-sqlite3` (e.g. "✔ Rebuild Complete") and exits `0`. If it fails, report the toolchain error verbatim (commonly a missing Visual Studio C++ build toolchain on Windows) — do NOT continue to `dist`.

- [ ] **Step 3: Build the installer.** Run electron-builder to produce the NSIS installer:
  ```bash
  npm run dist
  ```
  Expected: electron-builder prints `building target=nsis` and writes an installer to `dist\`, exiting `0`. (electron-builder re-runs the native rebuild for the packaged Electron version internally; Step 2 also proves the rebuild path independently.)

- [ ] **Step 4: Confirm the installer artifact exists on disk.** Run:
  ```bash
  node -e "const fs=require('fs');const out=fs.existsSync('dist')?fs.readdirSync('dist').filter(f=>/Setup.*\.exe$|\.exe$/.test(f)):[];console.log(out.length?('FOUND: '+out.join(', ')):'NONE')"
  ```
  Expected: `FOUND: <Interests App Setup x.y.z.exe>` (the exact name comes from the electron-builder `productName`/`version`). If it prints `NONE`, STOP — the build did not emit an installer.

- [ ] **Step 5: Record the build proof.** Append to `docs/VERIFICATION.md` this exact block (fill the installer filename from Step 4 before committing):
  ```markdown
  ## Installer build — 2026-06-26

  - `npm run rebuild`: `better-sqlite3` rebuilt for the Electron ABI, exit 0.
  - `npm run dist`: electron-builder NSIS build, exit 0.
  - Artifact: `dist/<Interests App Setup x.y.z.exe>`.
  - Result: PASS — per-user assisted-wizard installer built; cleared for manual smoke.
  ```

- [ ] **Step 6: Commit the build proof.**
  ```bash
  git add docs/VERIFICATION.md
  git commit -m "Phase 8: record native rebuild + electron-builder installer build proof

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```

### Task 8.3: Manual smoke checklist (install → migrate → capture → backup → restore)

**Files:**
- Modify: `docs/VERIFICATION.md` (Manual smoke area) — append the completed smoke checklist with PASS/FAIL noted per step.
- Modify: `docs/INSTALL.md` (smoke-checklist section) — ONLY if a step here reveals the documented checklist is wrong/incomplete; otherwise leave it untouched.

**Interfaces:**
- Consumes: the built installer from Task 8.2 (`dist/<...>.exe`); the smoke checklist authored in `docs/INSTALL.md` (from Phase 7); the running app's endpoints `GET /api/ping -> {app:"interests", version}`, `GET /api/health -> {storePath, counts, lastBackup}`, `GET /api/store-location -> {path, counts}`, `POST /api/import {srcDir}`, `POST /api/backup`, `GET /api/backups`, `POST /api/restore {name}` (from Phases 2/4/6); the extension HTTP delivery that probes `[3456..3465]` via `GET /api/ping` and `POST /api/captures {capture}` (from Phase 5).
- Produces: a completed, dated manual-smoke record (no code symbols); this is the explicit handoff into the subagent-driven final adversarial review.

> This is a human-in-the-loop checklist run against the **installed** app (not the dev tree). Each box is an observable outcome; check it only after seeing the stated result. If any box fails, record the failure verbatim under that step and STOP — the phase does not complete until the failing item is fixed and the box passes.

- [ ] **Step 1: Install via the assisted wizard.** Double-click `dist\<Interests App Setup x.y.z.exe>`.
  - [ ] SmartScreen "unknown publisher" appears once → **More info → Run anyway** (no code-signing in v1, expected).
  - [ ] Wizard shows **Welcome → (optional license) → choose install directory → shortcuts → Finish** (`oneClick:false` assisted flow).
  - [ ] Install completes with **no admin/UAC elevation prompt** (per-user install to `%LOCALAPPDATA%\Programs\Interests App\`).
  - [ ] Desktop and Start-menu shortcuts for **"Interests App"** exist.

- [ ] **Step 2: First launch creates the store.** Launch **Interests App** from the Start menu.
  - [ ] A native **program window** opens (not a browser tab) showing the existing UI.
  - [ ] The live store was created at `<install>\data\` containing `interests.db` and an `images\` folder.
  - [ ] The store-location pointer exists at `%APPDATA%\Interests App\config.json` and its `storePath` points at the `data\` folder.

- [ ] **Step 3: Service is up and discoverable.** With the app running, in a terminal:
  ```bash
  curl http://localhost:3456/api/ping
  ```
  - [ ] Response is JSON `{"app":"interests","version":"<x.y.z>"}` (this is the same probe the extension uses across `[3456..3465]`).

- [ ] **Step 4: Migrate the legacy backup (one-time).** In the app, run the **Import / Migrate** action and point it at an existing legacy backup folder in Dropbox (`interests-backup-<date>\` = `data.json` + `img-*.json` shards). Equivalent direct check:
  ```bash
  curl -X POST http://localhost:3456/api/import -H "Content-Type: application/json" -d "{\"srcDir\":\"C:/Users/dkbar/Dropbox/Interests App/backups/interests-backup-<date>\"}"
  ```
  - [ ] The result reports `{cards, saved, images, missing}` with the **expected counts** (e.g. ~5,500 cards / 18 saved / ~4,303 images) and `missing` is empty (or each missing-image card id is listed).
  - [ ] The source backup folder is **untouched** (read-only migration — file timestamps unchanged).

- [ ] **Step 5: Library renders.**
  - [ ] The migrated cards render in the grid with their images visible (images load via `GET /api/img/<id>`, served from `images\<id>.jpg`).
  - [ ] Cards whose image file is genuinely absent show a **placeholder** (graceful degradation), not a broken render/crash.
  - [ ] `GET http://localhost:3456/api/health` reports `storePath`, `counts` matching the import, and `lastBackup` (may be null pre-backup).

- [ ] **Step 6: Capture one post via the extension.** In Chrome (logged into a social site) with the capture extension loaded, save one post using the existing capture action.
  - [ ] The extension probes the port via `GET /api/ping`, then delivers via `POST /api/captures` (no app tab needs to be open in Chrome).
  - [ ] The new card appears in the app (the app drained the queue via `GET /api/captures`), with its captured image visible.
  - [ ] Capturing with the app **closed**, then re-launching the app, delivers the queued capture on reconnect (`chrome.storage.local` fallback flush).

- [ ] **Step 7: Back up now.** In the app, click **Back up now**. Equivalent direct check:
  ```bash
  curl -X POST http://localhost:3456/api/backup
  ```
  - [ ] Response is `{"ok":true,"name":"interests-backup-<YYYY-MM-DD>","counts":{...}}`.
  - [ ] A dated folder `Dropbox\Interests App\backups\interests-backup-<YYYY-MM-DD>\` exists containing `interests.db` + the new/changed image files.
  - [ ] `GET http://localhost:3456/api/backups` lists the new backup with its `counts`.

- [ ] **Step 8: Restore round-trip.** Make a small visible change in the app (e.g. delete one card), then restore the backup from Step 7. Equivalent direct check:
  ```bash
  curl -X POST http://localhost:3456/api/restore -H "Content-Type: application/json" -d "{\"name\":\"interests-backup-<YYYY-MM-DD>\"}"
  ```
  - [ ] Response is `{"ok":true}`.
  - [ ] A **safety snapshot** of the pre-restore store was taken first (a `interests-backup-before-restore-<...>` entry exists), and no good prior backup was deleted.
  - [ ] After restore, the app shows the pre-change state (the deleted card is back); counts match the backup.

- [ ] **Step 9: Move the data store (Settings → Data location).** In Settings, use **Move…** to relocate the store to a new empty folder. Equivalent direct check:
  ```bash
  curl -X POST http://localhost:3456/api/store-location/move -H "Content-Type: application/json" -d "{\"target\":\"D:/Interests-Store-Test\"}"
  ```
  - [ ] Response is `{"ok":true,"path":"D:/Interests-Store-Test"}`; `GET /api/store-location` now reports the new path with matching `counts`.
  - [ ] The **old** store copy was left intact until the new location verified (interrupted-move safety); the `%APPDATA%\Interests App\config.json` pointer now records the new path.
  - [ ] The library still renders correctly from the new location.

- [ ] **Step 10: Record the manual smoke result.** Append to `docs/VERIFICATION.md` this exact block (mark each line PASS/FAIL from the boxes above before committing):
  ```markdown
  ## Manual smoke — 2026-06-26

  - Install (assisted wizard, per-user, no UAC): <PASS/FAIL>
  - First launch + store created at <install>\data\ + %APPDATA% pointer: <PASS/FAIL>
  - /api/ping discoverable: <PASS/FAIL>
  - Migrate legacy backup (counts verified, source read-only): <PASS/FAIL>
  - Library + images render, placeholders for missing: <PASS/FAIL>
  - Extension capture over HTTP (+ offline queue flush): <PASS/FAIL>
  - Back up now → dated Dropbox folder + listed: <PASS/FAIL>
  - Restore round-trip (safety snapshot first): <PASS/FAIL>
  - Move data store (old kept until verified, pointer updated): <PASS/FAIL>
  - Result: <PASS — handoff to final adversarial review / FAIL — see notes>
  ```

- [ ] **Step 11: Commit the completed smoke record and hand off.**
  ```bash
  git add docs/VERIFICATION.md docs/INSTALL.md
  git commit -m "Phase 8: complete manual smoke checklist; ready for final adversarial review

  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  ```
  - [ ] All three recorded blocks (Automated sweep, Installer build, Manual smoke) read **PASS**. This commit is the explicit handoff into the subagent-driven **final adversarial review** and the user's verification pass.
