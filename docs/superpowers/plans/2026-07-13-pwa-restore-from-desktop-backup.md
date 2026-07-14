# Restore a New PWA Install from the Desktop's Dropbox Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a brand-new PWA install a fast, one-way restore path from the desktop app's already-automatic Dropbox backups — no manual setup beyond the Dropbox App key (which can never be auto-filled; see Global Constraints), and meaningfully faster than the live peer-sync path for a first-time device pairing since it never has to re-publish anything back to Dropbox.

**Architecture:** `core/backup.js`'s existing `runBackup()` gains one more written file, a portable `snapshot.json`, alongside its existing `interests.db`/`images/`/`meta.json`. `pwa/dropbox-connect.js` publishes this PWA's own bootstrap config (Worker URL/token, NOT the App key) after every successful connect, and adopts another device's published config if this device doesn't already have one. A new `pwa/restore-from-backup.js` reads the newest backup's `snapshot.json` and images directly over the already-connected Dropbox session and writes them via the same `Store`/`idb` primitives already proven to work by the existing legacy-JSON importer.

**Tech Stack:** Node + `better-sqlite3`-style sync API (`core/`, existing test harness via `tests/run.js`); vanilla browser JS, no build step (`pwa/`, no test harness — matches every other `pwa/*.js` file in this project).

## Global Constraints

- **The Dropbox App key can never be auto-filled from `pwa-config.json`.** Reading any file from Dropbox — including that config file — requires an active OAuth connection, which requires the App key up front. Every new device still enters it manually once, exactly as already done for this iPhone. Do not build or imply an App-key auto-fill anywhere in this plan.
- `snapshot.json` intentionally includes the **unstripped** settings blob (API keys, Open PageRank key) — a deliberate reversal of `core/db.js`'s `settingsForSync()`, which must otherwise keep stripping those fields for the *existing* peer-sync path. Do not modify `settingsForSync()` or its callers; add new, separate logic instead.
- No changes to the existing `interests.db`/`images/`/`meta.json` backup format, `Store.restore`/`listBackups` (still correctly stubbed on the PWA build), or the live peer-sync path (`pwa/sync-pwa.js`'s `runSyncCycle`) — this is a new, additional path, not a replacement.
- No `index.html` HTML/inline-script edits — the new restore UI is injected at runtime (same pattern as `pwa/dropbox-connect.js`/`pwa/pwa-install.js`), adding only one new `<script>` tag.
- `core/backup.js` has real test coverage (`tests/backup.test.js`, run via `node tests/run.js`) that must keep passing unmodified — the new `snapshot.json` write is purely additive.
- No automated test harness exists for `pwa/*.js` browser code — verification there is manual/mechanical (`node --check`), matching every other `pwa/` phase in this project.
- Design spec: `docs/superpowers/specs/2026-07-13-pwa-restore-from-desktop-backup-design.md` — read it for full rationale; this plan implements it task-by-task, with one correction (the App-key auto-fill was found to be impossible during planning — see the spec's own author notes are superseded by this plan's Global Constraints on that point).

---

## File structure

- **Modify** `core/backup.js` — add `buildPortableSnapshot(db)` and write `snapshot.json` in `runBackup()`.
- **Modify** `tests/backup.test.js` — new test covering the `snapshot.json` write, unstripped settings included.
- **Modify** `pwa/dropbox-connect.js` — publish `pwa-config.json` (Worker URL/token only) after every successful connect; adopt another device's published Worker config if not already set locally.
- **Create** `pwa/restore-from-backup.js` — finds the newest desktop backup, downloads `snapshot.json` + images, writes them via `Store`/`idb`.
- **Modify** `pwa/index.html` — add one `<script src="restore-from-backup.js"></script>` tag, after `dropbox-connect.js`.

---

## Task 1: `core/backup.js` writes a portable `snapshot.json`

**Files:**
- Modify: `core/backup.js`
- Modify: `tests/backup.test.js`

**Interfaces:**
- Produces: `snapshot.json` in every backup folder, shape `{ cards: Card[], saved: SavedItem[], tombstones: {id,kind,deletedAt}[], settings: object|null }` — `settings` is the raw, unstripped `ia_settings` blob (includes `keys`, `oprKey`, `updateToken` if present). This is the file `pwa/restore-from-backup.js` (Task 3) will read.

- [ ] **Step 1: Write the failing test**

In `tests/backup.test.js`, change the existing db-helpers import line (near line 101):

```javascript
const { openDb, upsertCard, upsertSaved, counts } = require("../core/db.js");
```

to:

```javascript
const { openDb, upsertCard, upsertSaved, counts, setKV } = require("../core/db.js");
```

Then add this test immediately after the existing `"runBackup copies db + images and verifyBackup confirms"` test (after its closing `});` around line 142):

```javascript
t("runBackup writes a portable snapshot.json with unstripped settings", () => {
  withBackupDir(function () {
    const store = newStore();
    const dbHandle = openDb(store);
    upsertCard(dbHandle, { id: "c1", url: "https://x/1", platform: "fb", cat: "Saved", ts: 1, img: "idb:c1" });
    upsertSaved(dbHandle, { id: "s1", url: "https://x/2", category: "Tips", clipped: 1, image: "idb:s1" });
    setKV(dbHandle, "ia_settings", JSON.stringify({ about: "me", keys: { anthropic: "SECRET_KEY" }, oprKey: "OPR_SECRET" }));

    const res = backup.runBackup(dbHandle, store);
    const bdir = backup.dropboxBackupDir();
    const snapPath = path.join(bdir, res.name, "snapshot.json");
    assert.ok(fs.existsSync(snapPath), "snapshot.json written");

    const snap = JSON.parse(fs.readFileSync(snapPath, "utf8"));
    assert.strictEqual(snap.cards.length, 1);
    assert.strictEqual(snap.cards[0].id, "c1");
    assert.strictEqual(snap.saved.length, 1);
    assert.strictEqual(snap.saved[0].id, "s1");
    assert.deepStrictEqual(snap.tombstones, []);
    // Unstripped — unlike settingsForSync(), the API key must survive here.
    assert.strictEqual(snap.settings.keys.anthropic, "SECRET_KEY");
    assert.strictEqual(snap.settings.oprKey, "OPR_SECRET");
    dbHandle.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/backup.test.js`
Expected: FAIL on `assert.ok(fs.existsSync(snapPath), "snapshot.json written")` — the file doesn't exist yet.

- [ ] **Step 3: Implement `buildPortableSnapshot` and wire it into `runBackup`**

In `core/backup.js`, change the top-of-file require line (around line 8):

```javascript
const { counts, openDb } = require("./db.js");
```

to:

```javascript
const { counts, openDb, allCards, allSaved, allTombstones, getKV } = require("./db.js");
```

Then, immediately before `function runBackup(db, storeDir) {` (around line 93), add:

```javascript
// Portable JSON snapshot for a new PWA install to restore from directly — a
// one-way pull, no re-publish needed (unlike the live peer-sync path in
// pwa/sync-pwa.js). Deliberately does NOT go through settingsForSync()'s
// stripping — this snapshot intentionally includes the raw settings blob
// (API keys, Open PageRank key included) so a brand-new install needs no
// manual setup beyond the Dropbox App key itself (which can never be
// auto-filled this way — see pwa/restore-from-backup.js's own header
// comment). See docs/superpowers/specs/2026-07-13-pwa-restore-from-desktop-
// backup-design.md's "Security" section for the tradeoff this represents.
function buildPortableSnapshot(db) {
  let settings = null;
  try { settings = JSON.parse(getKV(db, "ia_settings") || "null"); } catch (e) { settings = null; }
  return {
    cards: allCards(db),
    saved: allSaved(db),
    tombstones: allTombstones(db),
    settings,
  };
}

```

Then, inside `runBackup`, change:

```javascript
  // incremental image copy
  const srcImages = imagesDir(storeDir);
  for (const id of changedImageIds(storeDir, destImages)) {
    copyFileSync(path.join(srcImages, id + ".jpg"), path.join(destImages, id + ".jpg"));
  }

  // meta.json LAST
  fs.writeFileSync(path.join(destRoot, "meta.json"), JSON.stringify({ _counts: cnt, ts: Date.now() }));
  return { name, counts: cnt };
```

to:

```javascript
  // incremental image copy
  const srcImages = imagesDir(storeDir);
  for (const id of changedImageIds(storeDir, destImages)) {
    copyFileSync(path.join(srcImages, id + ".jpg"), path.join(destImages, id + ".jpg"));
  }

  // Portable snapshot BEFORE meta.json — meta.json's presence is the backup's
  // completion marker (see readMeta/verifyBackup below), so everything else
  // must be written first.
  fs.writeFileSync(path.join(destRoot, "snapshot.json"), JSON.stringify(buildPortableSnapshot(db)));

  // meta.json LAST
  fs.writeFileSync(path.join(destRoot, "meta.json"), JSON.stringify({ _counts: cnt, ts: Date.now() }));
  return { name, counts: cnt };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/backup.test.js`
Expected: PASS — all tests in the file, including the new one.

- [ ] **Step 5: Run the full test suite to confirm nothing else broke**

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED`.

- [ ] **Step 6: Commit**

```bash
git add core/backup.js tests/backup.test.js
git commit -m "feat: write a portable snapshot.json in every desktop backup"
```

---

## Task 2: `pwa/dropbox-connect.js` publishes and adopts Worker config

**Files:**
- Modify: `pwa/dropbox-connect.js`

**Interfaces:**
- Produces: `/Interests App/pwa-config.json` in the user's Dropbox, shape `{ appKey, contentcheckUrl, contentcheckToken }` — written for forward-compatibility/documentation of what's connected, but per Global Constraints, `appKey` is never read back by any consumer (it can't be, without already being connected). `pwa/restore-from-backup.js` (Task 3) does not depend on this file.

- [ ] **Step 1: Add `publishPwaConfig` and `tryAdoptPwaConfig`**

In `pwa/dropbox-connect.js`, after the existing `redirectUri()` function (around line 20), add:

```javascript
  const PWA_CONFIG_PATH = "/Interests App/pwa-config.json";

  // Lets a future PWA install skip manual Cloudflare Worker setup. Does NOT
  // help with the Dropbox App key itself — that can never be bootstrapped
  // this way, since reading this very file requires already being connected,
  // which requires the App key first. appKey is included here only so a
  // human inspecting this file in Dropbox can see which device published it.
  async function publishPwaConfig(token) {
    const cfg = {
      appKey: currentAppKey(),
      contentcheckUrl: localStorage.getItem("ia_pwa_contentcheck_url") || "",
      contentcheckToken: localStorage.getItem("ia_pwa_contentcheck_token") || "",
    };
    try { await Dbx.dbxUpload(token, PWA_CONFIG_PATH, JSON.stringify(cfg)); }
    catch (e) { console.warn("dropbox-connect: publishing pwa-config.json failed:", e.message); }
  }

  // Adopts another device's published Worker config, but only ever fills in
  // fields this device doesn't already have — never overwrites a
  // deliberately different local setup.
  async function tryAdoptPwaConfig(token) {
    if (localStorage.getItem("ia_pwa_contentcheck_url")) return; // already configured — leave it alone
    try {
      const text = await Dbx.dbxDownload(token, PWA_CONFIG_PATH);
      const cfg = JSON.parse(text);
      if (cfg.contentcheckUrl) localStorage.setItem("ia_pwa_contentcheck_url", cfg.contentcheckUrl);
      if (cfg.contentcheckToken) localStorage.setItem("ia_pwa_contentcheck_token", cfg.contentcheckToken);
    } catch (e) { /* no pwa-config.json published yet, or unreadable — nothing to adopt */ }
  }
```

- [ ] **Step 2: Call both from `refreshStatus()`'s success path**

Find (around line 27-46):

```javascript
  async function refreshStatus() {
    const statusEl = $("dbxConnectStatus");
    const btn = $("dbxConnectBtn");
    if (!statusEl || !btn) return;

    if (!Dbx.isConnected()) {
      statusEl.textContent = "Not connected.";
      btn.textContent = "Connect to Dropbox";
      return;
    }

    btn.textContent = "Disconnect";
    try {
      const token = await Dbx.getAccessToken(currentAppKey());
      const account = await Dbx.getCurrentAccount(token);
      statusEl.textContent = "Connected as " + account.email;
    } catch (e) {
      statusEl.textContent = "Connected, but account check failed: " + e.message;
    }
  }
```

Change to:

```javascript
  async function refreshStatus() {
    const statusEl = $("dbxConnectStatus");
    const btn = $("dbxConnectBtn");
    if (!statusEl || !btn) return;

    if (!Dbx.isConnected()) {
      statusEl.textContent = "Not connected.";
      btn.textContent = "Connect to Dropbox";
      return;
    }

    btn.textContent = "Disconnect";
    try {
      const token = await Dbx.getAccessToken(currentAppKey());
      const account = await Dbx.getCurrentAccount(token);
      statusEl.textContent = "Connected as " + account.email;
      await tryAdoptPwaConfig(token);
      await publishPwaConfig(token);
    } catch (e) {
      statusEl.textContent = "Connected, but account check failed: " + e.message;
    }
  }
```

- [ ] **Step 3: Syntax-check**

Run: `node --check pwa/dropbox-connect.js`
Expected: no output (valid syntax).

- [ ] **Step 4: Manually verify in a browser**

1. `cd pwa && python -m http.server 8080`, open `http://localhost:8080/`, go to Settings, confirm still connected (or reconnect).
2. Open a Dropbox web browser or app and confirm `/Interests App/pwa-config.json` now exists, containing `appKey`, `contentcheckUrl`, `contentcheckToken` matching this browser's current localStorage values.
3. In a second, fresh browser profile (or after clearing site data), connect to Dropbox with the same App key, then check DevTools → Application → Local Storage: confirm `ia_pwa_contentcheck_url`/`ia_pwa_contentcheck_token` were auto-filled from the published config (assuming the first profile had them set).

- [ ] **Step 5: Commit**

```bash
git add pwa/dropbox-connect.js
git commit -m "feat(pwa): publish and adopt Cloudflare Worker config across devices"
```

---

## Task 3: `pwa/restore-from-backup.js` — restore from the desktop's backup

**Files:**
- Create: `pwa/restore-from-backup.js`
- Modify: `pwa/index.html` (add one script tag)

**Interfaces:**
- Consumes: `window.IADropbox` (`dbxListFolder`, `dbxDownload`, `dbxDownloadBinary`, `getAccessToken`, `isConnected`, `LS_KEYS`), `window.IA_IDB` (`put`, `putMany`), `window.Store` (`putCards`, `putSaved`, `kvSet`, `backupNow`), the global `toast()` function (defined in `index.html`'s inline script).
- Produces: nothing consumed by other tasks — this is the final task in this plan.

- [ ] **Step 1: Create `pwa/restore-from-backup.js`**

```javascript
"use strict";

// Restores a brand-new PWA install from the desktop app's regular, already-
// automatic Dropbox backups (core/backup.js's runBackup(), which now also
// writes a portable snapshot.json alongside the interests.db/images/meta.json
// it has always written). This is a ONE-WAY PULL — unlike the live peer-sync
// path (pwa/sync-pwa.js), it never re-publishes anything back to Dropbox,
// which is what makes it meaningfully faster for a first-time device setup:
// the live-sync path's slowness comes specifically from having to upload the
// device's whole library back to Dropbox before it's done, even on its very
// first run.
//
// Separate file, not folded into pwa/dropbox-connect.js, so each file keeps a
// single responsibility (that file owns the OAuth connect flow and publishing
// this device's own Worker config; this one owns restoring from an existing
// backup once connected). Injected into the Settings panel at runtime, same
// pattern as dropbox-connect.js/pwa-install.js, to preserve index.html's
// byte-for-byte-except-<script>-tags constraint.
//
// snapshot.json intentionally includes the RAW, unstripped settings blob
// (API keys included) — see docs/superpowers/specs/2026-07-13-pwa-restore-
// from-desktop-backup-design.md's "Security" section. The Dropbox App key
// itself can NEVER be bootstrapped from a backup or from another device's
// published config — reading any Dropbox file requires already being
// connected, which requires the App key first. Every device still enters it
// manually once; this file only ever runs after that's already true.

(function () {
  const Dbx = window.IADropbox;
  const idb = window.IA_IDB;
  const Store = window.Store;
  const BACKUPS_ROOT = "/Interests App/backups";

  function $(id) { return document.getElementById(id); }

  // Ported from pwa/sync-pwa.js's sniffImageType (not exported from that
  // file's IIFE) — always trust sniffed magic bytes over the .jpg extension.
  function sniffImageType(bytes) {
    const buf = new Uint8Array(bytes);
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
        buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return "image/png";
    if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
    if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
    return "image/jpeg";
  }

  // path/not_found means the backups folder doesn't exist yet (desktop has
  // never backed up) — the normal, silent "nothing to restore from" case.
  // Anything else is a real error and must not be swallowed the same way.
  async function findLatestBackup(accessToken) {
    let entries;
    try {
      entries = await Dbx.dbxListFolder(accessToken, BACKUPS_ROOT);
    } catch (e) {
      if (/path\/not_found/.test(e.message)) return null;
      throw e;
    }
    const names = entries
      .filter((e) => e[".tag"] === "folder" && /^interests-backup-\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map((e) => e.name);
    if (!names.length) return null;
    names.sort(); // YYYY-MM-DD sorts correctly as a plain string
    return names[names.length - 1];
  }

  const IMAGE_DOWNLOAD_CONCURRENCY = 4;

  async function restoreImages(accessToken, backupName, imageIds, onProgress) {
    let done = 0, failed = 0, nextIndex = 0;
    async function worker() {
      while (nextIndex < imageIds.length) {
        const id = imageIds[nextIndex++];
        try {
          const bytes = await Dbx.dbxDownloadBinary(accessToken, `${BACKUPS_ROOT}/${backupName}/images/${id}.jpg`);
          await idb.put("images", { id, blob: new Blob([bytes]), type: sniffImageType(bytes) });
        } catch (e) {
          failed++; // deferred — a future live sync can pick it up from a peer instead
        }
        done++;
        if (onProgress && done % 25 === 0) onProgress(done, imageIds.length);
      }
    }
    if (imageIds.length) {
      await Promise.all(Array.from({ length: Math.min(IMAGE_DOWNLOAD_CONCURRENCY, imageIds.length) }, worker));
      if (onProgress) onProgress(imageIds.length, imageIds.length);
    }
    return { done, failed };
  }

  function imageIdsIn(snapshot) {
    const ids = new Set();
    (snapshot.cards || []).forEach((c) => { if (typeof c.img === "string" && c.img.indexOf("idb:") === 0) ids.add(c.img.slice(4)); });
    (snapshot.saved || []).forEach((s) => { if (typeof s.image === "string" && s.image.indexOf("idb:") === 0) ids.add(s.image.slice(4)); });
    return [...ids];
  }

  async function restoreFromDropboxBackup(statusEl) {
    const appKey = localStorage.getItem(Dbx.LS_KEYS.appKey);
    if (!appKey || !Dbx.isConnected()) { toast("Connect to Dropbox first."); return; }

    const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };
    setStatus("Looking for a desktop backup…");
    let token, backupName;
    try {
      token = await Dbx.getAccessToken(appKey);
      backupName = await findLatestBackup(token);
    } catch (e) {
      setStatus("Couldn't reach Dropbox: " + e.message);
      return;
    }
    if (!backupName) {
      setStatus("No desktop backup found in Dropbox yet — back up from the desktop app first.");
      return;
    }

    let snapshot;
    try {
      const text = await Dbx.dbxDownload(token, `${BACKUPS_ROOT}/${backupName}/snapshot.json`);
      snapshot = JSON.parse(text);
    } catch (e) {
      setStatus("Found " + backupName + " but couldn't read its snapshot.json: " + e.message);
      return;
    }

    const cardCount = (snapshot.cards || []).length;
    const savedCount = (snapshot.saved || []).length;
    if (!confirm("Restore from " + backupName + "? (" + cardCount + " imported, " + savedCount + " saved)\n\n" +
                 "This REPLACES everything currently in the app. A safety backup of your current data is attempted first.")) {
      setStatus("Restore cancelled.");
      return;
    }

    // PWA's Store.backupNow() is a stub that always resolves {ok:false} — this
    // is a no-op on the PWA build today, unlike the desktop's real safety copy.
    try { await Store.backupNow(); } catch (e) {}

    setStatus("Writing cards, saved items & settings…");
    try {
      if (snapshot.cards) await Store.putCards(snapshot.cards, { confirm: true });
      if (snapshot.saved) await Store.putSaved(snapshot.saved, { confirm: true });
      if (snapshot.tombstones && snapshot.tombstones.length) {
        const rows = snapshot.tombstones.map((t) => ({ key: t.kind + ":" + t.id, id: t.id, kind: t.kind, deletedAt: t.deletedAt }));
        await idb.putMany("tombstones", rows);
      }
      if (snapshot.settings) {
        await Store.kvSet("ia_settings", snapshot.settings);
        await Store.kvSet("ia_settings_updatedAt", Date.now());
      }
    } catch (e) {
      setStatus("Restore was partial — a safety backup of your previous data was attempted first. (" + e.message + ")");
      return;
    }

    const imageIds = imageIdsIn(snapshot);
    setStatus("Downloading " + imageIds.length + " images…");
    const { done, failed } = await restoreImages(token, backupName, imageIds, (d, total) => {
      setStatus("Downloading images: " + d + " / " + total + "…");
    });

    setStatus("Restored " + cardCount + " imported + " + savedCount + " saved, " + done + " images" +
      (failed ? (" (" + failed + " image" + (failed === 1 ? "" : "s") + " deferred)") : "") + " — reloading…");
    setTimeout(() => location.reload(), 1200);
  }

  function injectWidget() {
    const anchor = $("syncToggle");
    if (!anchor || $("restoreBackupBox")) return;
    const sec = anchor.closest(".sec");
    if (!sec) return;

    const box = document.createElement("div");
    box.id = "restoreBackupBox";
    box.style.marginTop = "14px";
    box.style.paddingTop = "14px";
    box.style.borderTop = "1px solid var(--line)";
    box.innerHTML =
      '<button class="btn btn-ghost" id="restoreBackupBtn">Restore from Dropbox backup…</button>' +
      '<div class="hint" id="restoreBackupStatus" style="margin-top:6px">' +
        'Pulls your desktop app’s latest backup directly — faster than a first-time sync, ' +
        'and includes your AI provider keys so this device needs no manual key entry. ' +
        '<b>Contains your live API keys</b> — only use this on a device you trust.' +
      '</div>';

    sec.appendChild(box);
    $("restoreBackupBtn").addEventListener("click", () => restoreFromDropboxBackup($("restoreBackupStatus")));
  }

  function init() {
    if (!Dbx || !idb || !Store) return;
    injectWidget();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
```

- [ ] **Step 2: Add the script tag to `pwa/index.html`**

Find (the script block established by prior phases):

```html
<script src="pwa-install.js"></script>
<script src="idb.js"></script>
<script src="oauth.js"></script>
<script src="merge.js"></script>
<script src="sync-pwa.js"></script>
<script src="storage-pwa.js"></script>
<script src="dropbox-connect.js"></script>
<script src="ai.js"></script>
```

Change to:

```html
<script src="pwa-install.js"></script>
<script src="idb.js"></script>
<script src="oauth.js"></script>
<script src="merge.js"></script>
<script src="sync-pwa.js"></script>
<script src="storage-pwa.js"></script>
<script src="dropbox-connect.js"></script>
<script src="restore-from-backup.js"></script>
<script src="ai.js"></script>
```

- [ ] **Step 3: Syntax-check**

Run: `node --check pwa/restore-from-backup.js`
Expected: no output (valid syntax).

- [ ] **Step 4: Manually verify in a browser**

Requires a real desktop backup with `snapshot.json` (from Task 1) already sitting in Dropbox, and a PWA browser profile already connected to that same Dropbox account (App key entered manually, per Global Constraints).

1. `cd pwa && python -m http.server 8080`, open `http://localhost:8080/`, go to Settings.
2. Confirm a new "Restore from Dropbox backup…" button appears below the existing Dropbox-connect and sync UI, with the "contains your live API keys" warning visible.
3. Click it. Confirm the dialog shows the correct backup name and card/saved counts, and cancelling (Cancel in the browser confirm dialog) does nothing and shows "Restore cancelled."
4. Click it again and confirm. Watch the status line progress through "Writing cards…" → "Downloading images: N / total…" → the final "Restored … — reloading…" message, then confirm the page reloads and cards/saved items/images are now visible.
5. In Settings → AI Provider, confirm the correct provider key(s) are now populated (matches what the desktop app had configured), without having been entered manually on this device.
6. Test the no-backup case: against a Dropbox account with no `/Interests App/backups/` folder, confirm the button shows "No desktop backup found in Dropbox yet — back up from the desktop app first." rather than an error or a hang.

- [ ] **Step 5: Commit**

```bash
git add pwa/restore-from-backup.js pwa/index.html
git commit -m "feat(pwa): restore a new install directly from the desktop's Dropbox backup"
```

---

## Self-review notes

- **Spec coverage:** `snapshot.json` with unstripped settings → Task 1. Worker config publish/adopt (App key excluded, per the corrected Global Constraint) → Task 2. Restore UI + logic (find latest backup, download snapshot + images, write via existing Store/idb primitives, no re-publish) → Task 3. Security note surfaced in the UI itself ("Contains your live API keys…") → Task 3 Step 1's injected markup. No changes to `interests.db`/`images/`/`meta.json` format, `Store.restore`/`listBackups`, live peer-sync, or `index.html` HTML → confirmed, none of the three tasks touch any of those.
- **Placeholder scan:** none found — every step ships complete, runnable code/tests and concrete manual-verification instructions.
- **Type/name consistency:** `buildPortableSnapshot`'s output shape (`{cards, saved, tombstones, settings}`) is read identically by Task 3's `restoreFromDropboxBackup`/`imageIdsIn` (same field names: `cards[].img`, `saved[].image`, `tombstones[].{id,kind,deletedAt}`). `PWA_CONFIG_PATH`/localStorage key names (`ia_pwa_contentcheck_url`, `ia_pwa_contentcheck_token`) are identical between Task 2's publish/adopt and the pre-existing usage in `storage-pwa.js`'s `checkContent`. `sniffImageType` is intentionally duplicated (not shared) between `sync-pwa.js` and this plan's `restore-from-backup.js`, matching this codebase's existing precedent of small helpers duplicated per IIFE rather than introducing cross-module coupling for a 10-line pure function.
