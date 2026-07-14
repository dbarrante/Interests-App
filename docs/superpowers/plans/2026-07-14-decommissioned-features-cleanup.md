# Remove Decommissioned Buttons and Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove dead/orphaned UI (extension popup, PWA test harnesses), fix
4 PWA Settings buttons that show a false "success" toast for
desktop-only operations `pwa/storage-pwa.js` stubs out (removing one of
them outright instead of fixing it), and hide 4 Settings sections + 1
Stumble pill that are fully functional on desktop but silent no-ops on
the PWA build.

**Architecture:** Four independent tasks, each touching a different,
non-overlapping cluster of files. Tasks 3 and 4 both edit
`web/index.html` (shared byte-for-byte with `pwa/index.html` outside
`<script src=...>` tags — every edit in both tasks applies to both files
identically) but touch different functions/sections, so they don't
conflict with each other.

**Tech Stack:** Vanilla JS/HTML/CSS (`web/`, `pwa/`), Chrome Extension
Manifest V3 (`extension/`) — no build step, no framework.

## Global Constraints

- Every edit to `web/index.html` applies identically to `pwa/index.html`
  (they are byte-identical outside `<script src=...>` tags) — never edit
  only one.
- `web/restore-legacy.js`, `planLegacyRestore()`, `doRestoreCore()`,
  `applyRestore()`, and `Store.runImport()`'s underlying implementation in
  `core/` are NOT touched by this plan — confirmed load-bearing for the
  PWA's "Restore from Dropbox backup" feature and/or still desktop-active.
- `pwa/worker-config.html` is NOT touched — no in-app replacement exists.
- `extension/background.js`'s `clipSocialPost`, `getStatus`, and the three
  `bstumble*` message handlers are NOT touched — only `clipPage` and
  `removeCard`.
- The new `window.IA_IDB` PWA-detection check must read exactly
  `window.IA_IDB` (a global set only by `pwa/idb.js`, which only
  `pwa/index.html` loads) — confirmed via grep to not collide with any
  existing use in either file.
- Spec: `docs/superpowers/specs/2026-07-14-decommissioned-features-cleanup-design.md`

---

### Task 1: Delete the orphaned extension popup UI

**Files:**
- Delete: `extension/popup.html`
- Delete: `extension/popup.js`
- Modify: `extension/background.js` (the single `chrome.runtime.onMessage`
  listener, currently lines 1126-1212)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing consumed by other tasks (fully independent).

- [ ] **Step 1: Confirm nothing else references the popup files**

Run from the repo root:
```bash
grep -rn "popup\.html\|popup\.js" extension/ --include="*.json" --include="*.js"
```
Expected: no matches (or only matches inside comments describing the
*removed* popup, e.g. `background.js`'s existing comments at lines
419/493/1073/1124 that mention "the popup" in prose — those are fine to
leave, they don't reference the files by name).

- [ ] **Step 2: Delete the two files**

```bash
git rm extension/popup.html extension/popup.js
```

- [ ] **Step 3: Remove the `clipPage` and `removeCard` message handlers**

In `extension/background.js`, replace this entire block:
```js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "clipPage") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const res = await clipCurrentPage(tab);
        sendResponse(res);
      } catch (e) {
        await setStatus("Clip failed: " + e.message, false);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.action === "clipSocialPost" && msg.data) {
    (async () => {
      try {
        const tab = sender.tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        const d = msg.data;
        // YouTube: the deterministic public thumbnail beats a scraped tile image.
        if (/youtube\.com|youtu\.be/i.test(d.url || "")) { const _yt = ytVideoId(d.url); if (_yt) d.image = "https://i.ytimg.com/vi/" + _yt + "/hqdefault.jpg"; }
        // Build the card image, ordered by the config's strategy. All results
        // are durable data URLs (CDN URLs expire, so we never store them raw).
        //   "photo"  (Facebook): the post's own photo first — ignores the
        //            "Save To" dialog floating over the post; crop is fallback.
        //   "region" (default): crop the post rectangle first.
        const tryPhoto = function () { return d.image ? fetchAsDataUrl(d.image) : Promise.resolve(""); };
        const tryCrop = function () { return (d.rect && d.rect.w > 40 && d.rect.h > 40) ? cropScreenshot(tab, d.rect) : Promise.resolve(""); };
        let imgData = "";
        if (d.strategy === "photo") { imgData = await tryPhoto(); if (!imgData) imgData = await tryCrop(); }
        else { imgData = await tryCrop(); if (!imgData) imgData = await tryPhoto(); }
        const res = await clipCurrentPage(tab, {
          url: d.url || d.pageUrl,
          title: d.title,
          desc: (d.text || d.author || "").trim() || undefined,
          image: imgData,                 // post-area crop (or photo) as a data URL
          noShot: !!imgData,              // got an image, skip the full screenshot
          shotDelay: imgData ? 0 : 700,   // none: let the menu close, then screenshot
        });
        sendResponse(res);
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (msg.action === "removeCard") {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const url = (tab && tab.url) || "";
        // remove the card matching this page's URL, or fall back to the
        // last-opened ("active") card in the app. "Dead post" notices are
        // ordinary capture objects (cap.dead) — deliver them the same way,
        // with the same HTTP + offline-queue fallback (deliverToApp).
        await deliverToApp({ url, id: "", dead: true, removeActive: true, error: "removed by user", ts: Date.now() });
        await setStatus("Removed card from Interests + closing tab", true);
        sendResponse({ ok: true });
        if (tab && tab.id != null) await closeTabSafe(tab.id);   // close the page tab
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.action === "getStatus") {
    (async () => {
      const stored = await chrome.storage.local.get(["ia_capture_queue", "ia_last_status"]);
      sendResponse({
        queue: (stored.ia_capture_queue || []).length,
        status: stored.ia_last_status || null,
      });
    })();
    return true;
  }

  // 👎 (not-for-me) dismisses and advances; 👍 (like) records and STAYS so the user can read/Save it.
  if (msg.action === "bstumbleVote") { bstumbleSendVote(msg.vote).then(() => { if (msg.vote < 0) bstumbleGo(); }).catch(() => {}); return false; }
  if (msg.action === "bstumbleNext") { bstumbleGo().catch(() => {}); return false; }
  if (msg.action === "bstumbleSave") {
    (async () => {
      try { const s = await chrome.storage.session.get(BSTUMBLE_TAB_KEY); const tab = s[BSTUMBLE_TAB_KEY] != null ? await chrome.tabs.get(s[BSTUMBLE_TAB_KEY]) : null; if (tab) await clipCurrentPage(tab); } catch (e) {}
    })();
    return false;
  }
});
```
with (only the `clipPage` and `removeCard` branches removed — everything
else identical):
```js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "clipSocialPost" && msg.data) {
    (async () => {
      try {
        const tab = sender.tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        const d = msg.data;
        // YouTube: the deterministic public thumbnail beats a scraped tile image.
        if (/youtube\.com|youtu\.be/i.test(d.url || "")) { const _yt = ytVideoId(d.url); if (_yt) d.image = "https://i.ytimg.com/vi/" + _yt + "/hqdefault.jpg"; }
        // Build the card image, ordered by the config's strategy. All results
        // are durable data URLs (CDN URLs expire, so we never store them raw).
        //   "photo"  (Facebook): the post's own photo first — ignores the
        //            "Save To" dialog floating over the post; crop is fallback.
        //   "region" (default): crop the post rectangle first.
        const tryPhoto = function () { return d.image ? fetchAsDataUrl(d.image) : Promise.resolve(""); };
        const tryCrop = function () { return (d.rect && d.rect.w > 40 && d.rect.h > 40) ? cropScreenshot(tab, d.rect) : Promise.resolve(""); };
        let imgData = "";
        if (d.strategy === "photo") { imgData = await tryPhoto(); if (!imgData) imgData = await tryCrop(); }
        else { imgData = await tryCrop(); if (!imgData) imgData = await tryPhoto(); }
        const res = await clipCurrentPage(tab, {
          url: d.url || d.pageUrl,
          title: d.title,
          desc: (d.text || d.author || "").trim() || undefined,
          image: imgData,                 // post-area crop (or photo) as a data URL
          noShot: !!imgData,              // got an image, skip the full screenshot
          shotDelay: imgData ? 0 : 700,   // none: let the menu close, then screenshot
        });
        sendResponse(res);
      } catch (e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (msg.action === "getStatus") {
    (async () => {
      const stored = await chrome.storage.local.get(["ia_capture_queue", "ia_last_status"]);
      sendResponse({
        queue: (stored.ia_capture_queue || []).length,
        status: stored.ia_last_status || null,
      });
    })();
    return true;
  }

  // 👎 (not-for-me) dismisses and advances; 👍 (like) records and STAYS so the user can read/Save it.
  if (msg.action === "bstumbleVote") { bstumbleSendVote(msg.vote).then(() => { if (msg.vote < 0) bstumbleGo(); }).catch(() => {}); return false; }
  if (msg.action === "bstumbleNext") { bstumbleGo().catch(() => {}); return false; }
  if (msg.action === "bstumbleSave") {
    (async () => {
      try { const s = await chrome.storage.session.get(BSTUMBLE_TAB_KEY); const tab = s[BSTUMBLE_TAB_KEY] != null ? await chrome.tabs.get(s[BSTUMBLE_TAB_KEY]) : null; if (tab) await clipCurrentPage(tab); } catch (e) {}
    })();
    return false;
  }
});
```

- [ ] **Step 4: Confirm the extension still loads and its live paths work**

There's no automated test harness for the extension. Manually: load the
unpacked extension folder in `chrome://extensions` (Developer mode →
"Load unpacked" → select the `extension/` folder), confirm it loads with
no console errors mentioning `popup.html`/`popup.js`/`clipPage`/`removeCard`.
On any of the matched social sites, confirm the right-click "Save to
Interests" context-menu action still works (it calls `clipCurrentPage`
directly, not through the removed message handlers).

- [ ] **Step 5: Commit**

```bash
cd "D:\Dropbox\Documents\Claude\Projects\Interests App"
git add extension/background.js
git commit -m "$(cat <<'EOF'
chore(ext): remove orphaned popup UI

extension/popup.html/popup.js were unreachable (manifest's action
block has no default_popup, nothing calls chrome.action.setPopup).
Replaced by the Stumble overlay + right-click context menu. Removes
the clipPage/removeCard message handlers that existed only to serve
the popup's buttons.
EOF
)"
```

---

### Task 2: Delete redundant PWA test harnesses

**Files:**
- Delete: `pwa/dbx-test.html`
- Delete: `pwa/sync-test.html`
- Delete: `pwa/store-test.html`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing consumed by other tasks (fully independent).

- [ ] **Step 1: Confirm the real in-app replacement exists**

```bash
grep -n "dropbox-connect" pwa/index.html
```
Expected: a `<script src="dropbox-connect.js"></script>` line — confirms
`pwa/dropbox-connect.js` is loaded and provides the real "Connect to
Dropbox" UI these test pages existed to stand in for (per
`pwa/HANDOFF.md`).

- [ ] **Step 2: Confirm no code/deploy config references these 3 files**

```bash
grep -rln "dbx-test\.html\|sync-test\.html\|store-test\.html" --include="*.yml" --include="*.json" --include="*.js" .
```
Expected: no matches in workflow/config/JS files (prose mentions in
`pwa/README.md` and `pwa/dropbox-connect.js`'s own comments are expected
and left as-is per the spec — this check is only for functional
references like a GitHub Actions workflow or a script that opens these
pages).

- [ ] **Step 3: Delete the three files**

```bash
git rm pwa/dbx-test.html pwa/sync-test.html pwa/store-test.html
```

- [ ] **Step 4: Confirm the real Dropbox-connect flow still works**

```bash
cd pwa && python -m http.server 8080
```
From a fresh/incognito browser profile, open `http://localhost:8080/`,
go to Settings, and confirm the "Connect to Dropbox" widget
(`dropbox-connect.js`'s injected UI) is present and its OAuth flow can be
initiated — you don't need to complete a real OAuth round-trip for this
check, just confirm the button/UI renders and clicking it navigates to
Dropbox's OAuth page (or shows an app-key-required prompt if no App key is
configured yet, which is the expected first-run state).

- [ ] **Step 5: Commit**

```bash
git add pwa/dbx-test.html pwa/sync-test.html pwa/store-test.html
git commit -m "$(cat <<'EOF'
chore(pwa): delete redundant OAuth/storage test harnesses

dbx-test.html, sync-test.html, and store-test.html existed to work
around pwa/index.html having no real in-app "Connect to Dropbox" UI.
pwa/dropbox-connect.js now provides that UI directly in Settings, so
these standalone test pages are redundant.
EOF
)"
```

---

### Task 3: Fix 3 false-success PWA buttons, remove the 4th entirely

**Files:**
- Modify: `web/index.html` (`doBackup()`, `moveDataLocation()`,
  `saveSafeBrowsingKey()`, the "Import legacy backup…" markup block,
  `bindImportLegacy()`)
- Modify: `pwa/index.html` (identical edits)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing consumed by other tasks. (Task 4 also edits these
  files but touches different functions/sections — no overlap.)

- [ ] **Step 1: Fix `doBackup()` to check `res.ok`**

In both files, replace:
```js
async function doBackup(manual){
  try{
    const res = await Store.backupNow();                 // {ok,verified,name,counts}
    const counts = res && res.counts ? res.counts : {imported:imported.length, saved:saved.length, images:0};
    const verified = !!(res && res.verified);
    await Store.kvSet("ia_lastbackup", Date.now());
    await Store.kvSet("ia_backup_last", { ts:Date.now(), counts:counts, verified:verified, where:"Dropbox", name:(res&&res.name)||"" });
    if(manual){
      if(verified===false){ toast("Backup written but NOT verified — check Dropbox\\Interests App\\backups"); }
      else { toast("Backed up: "+(counts.imported||0)+" cards, "+(counts.images||0)+" images"); }
    }
    try{ await storageHealthCheck(); }catch(e){}
    return res;
  }catch(e){ if(manual) toast("Backup failed: "+(e&&e.message||e)); console.warn("backup failed", e); }
}
```
with:
```js
async function doBackup(manual){
  try{
    const res = await Store.backupNow();                 // {ok,verified,name,counts}
    if(res && res.ok===false){
      if(manual) toast(res.reason || "Backup not available");
      return res;
    }
    const counts = res && res.counts ? res.counts : {imported:imported.length, saved:saved.length, images:0};
    const verified = !!(res && res.verified);
    await Store.kvSet("ia_lastbackup", Date.now());
    await Store.kvSet("ia_backup_last", { ts:Date.now(), counts:counts, verified:verified, where:"Dropbox", name:(res&&res.name)||"" });
    if(manual){
      if(verified===false){ toast("Backup written but NOT verified — check Dropbox\\Interests App\\backups"); }
      else { toast("Backed up: "+(counts.imported||0)+" cards, "+(counts.images||0)+" images"); }
    }
    try{ await storageHealthCheck(); }catch(e){}
    return res;
  }catch(e){ if(manual) toast("Backup failed: "+(e&&e.message||e)); console.warn("backup failed", e); }
}
```

- [ ] **Step 2: Fix `moveDataLocation()` to check `res.ok`**

In both files, replace:
```js
async function moveDataLocation(){
  let cur = {};
  try{ cur = await Store.storeLocation(); }catch(e){}
  let target = null;
  const pf = window.ia && window.ia.pickFolder;
  if (pf) { try { target = await pf(); } catch(e){ target = null; } }
  else { target = prompt("Move the data store to a new folder.\nCurrent: " + (cur.path||"(unknown)") + "\n\nEnter the FULL path of the new folder:", cur.path||""); }
  if(!target || target === cur.path) return;
  toast("Moving data store… (the old copy is kept until the move verifies)");
  try{
    const res = await Store.moveStore(target);
    toast("Data store moved to " + (res.path||target));
    try{ await storageHealthCheck(); }catch(e){}
  }catch(e){ toast("Move failed: " + (e&&e.message||e)); }
}
```
with:
```js
async function moveDataLocation(){
  let cur = {};
  try{ cur = await Store.storeLocation(); }catch(e){}
  let target = null;
  const pf = window.ia && window.ia.pickFolder;
  if (pf) { try { target = await pf(); } catch(e){ target = null; } }
  else { target = prompt("Move the data store to a new folder.\nCurrent: " + (cur.path||"(unknown)") + "\n\nEnter the FULL path of the new folder:", cur.path||""); }
  if(!target || target === cur.path) return;
  toast("Moving data store… (the old copy is kept until the move verifies)");
  try{
    const res = await Store.moveStore(target);
    if(res && res.ok===false){ toast(res.reason || "Move not available"); return; }
    toast("Data store moved to " + (res.path||target));
    try{ await storageHealthCheck(); }catch(e){}
  }catch(e){ toast("Move failed: " + (e&&e.message||e)); }
}
```

- [ ] **Step 3: Fix `saveSafeBrowsingKey()` to check the resolved `.ok`**

In both files, replace:
```js
async function saveSafeBrowsingKey(){
  const inp = document.getElementById("sbKey");
  const v = inp ? inp.value.trim() : "";
  if (v === SB_MASK) { toast("Key unchanged"); return; }    // mask untouched = no change
  try { await Store.setSafeBrowsingKey(v); } catch(e){ toast("Couldn't save key", 4000); return; }
  if (inp) inp.value = "";
  toast(v ? "Safe Browsing key saved" : "Safe Browsing key cleared", 4000);
  loadSafetyKeyStatus();
}
```
with:
```js
async function saveSafeBrowsingKey(){
  const inp = document.getElementById("sbKey");
  const v = inp ? inp.value.trim() : "";
  if (v === SB_MASK) { toast("Key unchanged"); return; }    // mask untouched = no change
  let res;
  try { res = await Store.setSafeBrowsingKey(v); } catch(e){ toast("Couldn't save key", 4000); return; }
  if (res && res.ok===false){ toast(res.reason || "Couldn't save key", 4000); return; }
  if (inp) inp.value = "";
  toast(v ? "Safe Browsing key saved" : "Safe Browsing key cleared", 4000);
  loadSafetyKeyStatus();
}
```

- [ ] **Step 4: Remove the "Import from folder…" button and its result span**

In both files, replace:
```html
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
          <label style="font-weight:600">Import legacy backup…</label>
          <div class="hint" style="margin:4px 0 8px">Bring in data from an older version. Both paths replace everything currently in the app — a verified safety backup of your current data is taken first.</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <input type="file" id="restoreFile" accept=".json,application/json" onchange="restoreData(event)" title="Import a single-file .json backup exported by an older version.">
            <button id="btnImportLegacy" class="btn btn-ghost" title="Import an old folder-style backup (contains data.json) from a previous version. Reads only — your source folder is never modified.">Import from folder…</button>
            <span id="importLegacyResult" class="hint"></span>
          </div>
        </div>
```
with:
```html
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
          <label style="font-weight:600">Import legacy backup…</label>
          <div class="hint" style="margin:4px 0 8px">Bring in a single-file .json backup exported by an older version. Replaces everything currently in the app — a verified safety backup of your current data is taken first.</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <input type="file" id="restoreFile" accept=".json,application/json" onchange="restoreData(event)" title="Import a single-file .json backup exported by an older version.">
          </div>
        </div>
```
(This keeps the `#restoreFile` single-file-JSON restore input and its
`restoreData(event)` handler — which routes through `applyRestore()` →
`doRestoreCore()` → `planLegacyRestore()` — fully intact. Only the
folder-import button and its dedicated result span are removed. The hint
text is updated since it previously said "Both paths," which would be
inaccurate with only one path left.)

- [ ] **Step 5: Remove the `bindImportLegacy()` IIFE entirely**

In both files, delete this whole block:
```js
(function bindImportLegacy(){
  var btn = document.getElementById("btnImportLegacy");
  if(!btn) return;
  btn.addEventListener("click", async function(){
    var out = document.getElementById("importLegacyResult");
    var srcDir = null;
    try {
      var pf = window.ia && window.ia.pickFolder;
      if (pf) {
        srcDir = await pf();
      } else {
        srcDir = window.prompt("Path to legacy backup folder (contains data.json):");
      }
    } catch(e) { srcDir = null; }
    if(!srcDir){ return; }
    if(out){ out.textContent = "Importing…"; }
    try {
      var res = await Store.runImport(srcDir);
      if(out){
        out.textContent = "Imported " + res.cards + " cards, " + res.saved + " saved, " +
          res.images + " images — " + (res.missing ? res.missing.length : 0) + " missing. Refreshing…";
      }
      // The DB now holds the imported rows, but in-memory state was loaded at
      // startup. Reload so the library appears without an app restart (same
      // approach the restore-from-backup path uses).
      setTimeout(function(){ location.reload(); }, 1500);
    } catch(e) {
      if(out){ out.textContent = "Import failed: " + (e && e.message ? e.message : e); }
    }
  });
})();
```
(Delete the whole IIFE — do not leave an empty `(function bindImportLegacy(){})();`.)

- [ ] **Step 6: Confirm no dangling references**

```bash
grep -n "btnImportLegacy\|importLegacyResult\|bindImportLegacy" web/index.html pwa/index.html
```
Expected: no matches in either file.

- [ ] **Step 7: Verify file parity and syntax**

```bash
diff <(sed 's/<script[^>]*><\/script>//g; s/<script[^>]*>//g' web/index.html) <(sed 's/<script[^>]*><\/script>//g; s/<script[^>]*>//g' pwa/index.html)
node tests/syntax-check.js
```
Expected: diff shows only the pre-existing PWA-only comment block;
syntax-check reports 0 errors.

- [ ] **Step 8: Manual verification**

On the PWA build (`cd pwa && python -m http.server 8080`), in Settings:
- Confirm "Import from folder…" no longer appears.
- Click "Back up now" (or trigger `doBackup(true)`) — confirm it toasts
  something like "Not applicable on iPad — Dropbox sync is the backup."
  instead of a fake "Backed up: N cards" message.
- Click "Move data location…" — confirm it toasts "Not applicable on
  iPad." instead of "Data store moved to undefined".
- Enter a Safe Browsing key and click Save — confirm it does NOT toast
  "Safe Browsing key saved" (since the PWA stub always returns
  `{ok:false}` — the real failure toast should show instead).

On a real desktop build (or by reading `core/backup.js`/`core/config.js`'s
real `{ok:true,...}` return shapes, already confirmed during planning),
confirm these 3 buttons are structurally unchanged for the success case —
the new `res.ok===false` check only triggers on a real failure, which the
desktop's real implementations don't return under normal operation.

- [ ] **Step 9: Commit**

```bash
git add web/index.html pwa/index.html
git commit -m "$(cat <<'EOF'
fix(web,pwa): stop claiming success for desktop-only Settings actions

doBackup/moveDataLocation/saveSafeBrowsingKey never checked the
{ok:false,reason} result pwa/storage-pwa.js's stubs return for
desktop-only operations, so the PWA showed false-success toasts
(garbled "undefined" text in two cases) instead of the real "not
applicable on iPad" reason. Also removes the "Import from folder..."
button (Store.runImport()) entirely rather than fixing it -- a
narrower, lower-value feature than the still-load-bearing single-file
JSON restore path it sat next to.
EOF
)"
```

---

### Task 4: Hide PWA-inert Settings sections and the Stumble News pill

**Files:**
- Modify: `web/index.html` (add `id`s to 4 Settings fragments, add a
  boot-time hide block, gate the Stumble News pill in `stCatSideHTML()`)
- Modify: `pwa/index.html` (identical edits)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing consumed by other tasks. (Edits different
  functions/sections than Task 3 — no overlap in the same shared files.)

- [ ] **Step 1: Add an `id` to the "Browser extension" section**

In both files, replace:
```html
      <div class="sec">
        <h3>Browser extension</h3>
        <div class="hint" style="margin-bottom:10px">The Interests Capture extension grabs screenshots and metadata when you click imported articles. Set a delay so the page has time to load before the capture fires.</div>
```
with:
```html
      <div class="sec" id="secBrowserExt">
        <h3>Browser extension</h3>
        <div class="hint" style="margin-bottom:10px">The Interests Capture extension grabs screenshots and metadata when you click imported articles. Set a delay so the page has time to load before the capture fires.</div>
```
(This is the opening of the section — the rest of the `.sec` block,
through its closing `</div>`, is unchanged. Do not modify the fields
inside it.)

- [ ] **Step 2: Wrap the "Mix fresh news into Stumble" toggle in its own block**

In both files, replace:
```html
        <label style="display:flex;align-items:center;gap:9px;font-size:14px;cursor:pointer;margin-top:8px">
          <input type="checkbox" id="newsMixToggle" style="width:auto"> Mix fresh news into Stumble
        </label>
        <div class="hint" style="margin:4px 0 0">Blends interest-matched news into your normal Stumble deck (free). Turn off for discovery pages only. The &#128240; News pill in Stumble always gives news-only.</div>
```
with:
```html
        <div id="newsMixBlock">
          <label style="display:flex;align-items:center;gap:9px;font-size:14px;cursor:pointer;margin-top:8px">
            <input type="checkbox" id="newsMixToggle" style="width:auto"> Mix fresh news into Stumble
          </label>
          <div class="hint" style="margin:4px 0 0">Blends interest-matched news into your normal Stumble deck (free). Turn off for discovery pages only. The &#128240; News pill in Stumble always gives news-only.</div>
        </div>
```

- [ ] **Step 3: Add an `id` to the Safe Browsing sub-block**

In both files, replace:
```html
        <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
          <label style="font-weight:600">Google Safe Browsing API key <span id="sbKeyStatus" class="hint"></span></label>
```
with:
```html
        <div id="sbKeyBlock" style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
          <label style="font-weight:600">Google Safe Browsing API key <span id="sbKeyStatus" class="hint"></span></label>
```
(This `<div style="margin-top:16px;...">` is nested inside the "Site
popularity filter" `.sec` — only this inner sub-block gets the new `id`,
not the outer section. The "Prefer popular, well-known sites"/`oprKey`
part of that same section is untouched and stays visible on PWA.)

- [ ] **Step 4: Add an `id` to the "App updates" section**

In both files, replace:
```html
      <div class="sec">
        <h3>App updates</h3>
        <div class="hint" style="margin-bottom:10px">Let the app update itself. Paste a <b>read-only</b> access token once (stored only on this computer — never synced, never in the app file), then use <b>Check for updates now</b> or the button in Help → About. When a newer version exists it downloads in the background; you'll be asked to restart to install.</div>
```
with:
```html
      <div class="sec" id="secAppUpdates">
        <h3>App updates</h3>
        <div class="hint" style="margin-bottom:10px">Let the app update itself. Paste a <b>read-only</b> access token once (stored only on this computer — never synced, never in the app file), then use <b>Check for updates now</b> or the button in Help → About. When a newer version exists it downloads in the background; you'll be asked to restart to install.</div>
```

- [ ] **Step 5: Add the boot-time hide block**

In both files, at the very end of the inline `<script>` block (the last 3
lines before `</script></body></html>` currently read exactly):
```js
setInterval(pollSyncChanged, 30000);
setInterval(pollBatchProgress, 1500);
setupPasteToCard();
```
Append immediately after `setupPasteToCard();` (same indentation level,
still before `</script>`):
```js
setInterval(pollSyncChanged, 30000);
setInterval(pollBatchProgress, 1500);
setupPasteToCard();
// Desktop-only Settings sections are fully functional on the real app but
// silent no-ops on the PWA build (pwa/storage-pwa.js permanently stubs
// their backing calls) — hide them there rather than show controls that
// can never do anything. window.IA_IDB is set only by pwa/idb.js, which
// only pwa/index.html loads, so this is a reliable PWA-vs-desktop check.
if (window.IA_IDB) {
  ["secBrowserExt","newsMixBlock","sbKeyBlock","secAppUpdates"].forEach(function(id){
    var el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
}
```

- [ ] **Step 6: Gate the Stumble "📰 News" pill on the PWA build**

In both files, replace:
```js
function stCatSideHTML(){
  const pills = [{key:"",name:"All"}].concat(CATS);
  return `<aside class="tag-side">
    <div class="tag-side-h">Categories</div>
    <span class="tg${stNewsOnly?" on":""}" onclick="toggleNewsOnly()">&#128240; News</span>
    ${pills.map(c=>`<span class="tg${filterCat===c.key?" on":""}" onclick="setFilter('${c.key}')">${esc(c.name)}</span>`).join("")}
  </aside>`;
}
```
with:
```js
function stCatSideHTML(){
  const pills = [{key:"",name:"All"}].concat(CATS);
  return `<aside class="tag-side">
    <div class="tag-side-h">Categories</div>
    ${window.IA_IDB?"":`<span class="tg${stNewsOnly?" on":""}" onclick="toggleNewsOnly()">&#128240; News</span>`}
    ${pills.map(c=>`<span class="tg${filterCat===c.key?" on":""}" onclick="setFilter('${c.key}')">${esc(c.name)}</span>`).join("")}
  </aside>`;
}
```
(This is the only UI entry point that lets a user turn on `stNewsOnly`
mode. `stNewsSideHTML()` — the sidebar shown *while already in* news-only
mode — is intentionally left unmodified: with no way to turn news-only
mode on via the PWA UI going forward, it's unreachable in practice. Out
of scope for this task: any defensive handling of a pre-existing
`stNewsOnly=true` value loaded from a save made before this change — the
spec scopes this to hiding the entry point, not migrating old state.)

- [ ] **Step 7: Verify file parity and syntax**

```bash
diff <(sed 's/<script[^>]*><\/script>//g; s/<script[^>]*>//g' web/index.html) <(sed 's/<script[^>]*><\/script>//g; s/<script[^>]*>//g' pwa/index.html)
node tests/syntax-check.js
```
Expected: diff shows only the pre-existing PWA-only comment block;
syntax-check reports 0 errors.

- [ ] **Step 8: Manual verification**

On the PWA build (`cd pwa && python -m http.server 8080`): open Settings
and confirm "Browser extension", the "Mix fresh news into Stumble"
toggle, the Safe Browsing key sub-block, and "App updates" are all absent
from the rendered page (not just visually hidden by CSS — confirm via
`document.getElementById("secBrowserExt")` etc. having `display:none`, or
simpler, just visually confirm they don't appear). In Stumble at a wide
viewport (≥760px, where the category sidebar shows), confirm the 📰 News
pill is absent.

On the desktop build (`web/index.html` served by the real Core service,
or opened directly), confirm all 4 sections and the News pill are present
and behave exactly as before this task — `window.IA_IDB` is `undefined`
there, so the hide block and the pill gate are both no-ops.

- [ ] **Step 9: Commit**

```bash
git add web/index.html pwa/index.html
git commit -m "$(cat <<'EOF'
feat(web,pwa): hide desktop-only Settings sections on the PWA build

Browser extension capture settings, the News-mix toggle, the Safe
Browsing key sub-block, and App updates are fully functional on
desktop but silently do nothing on the PWA build (their backing
Store calls are permanently stubbed there). Hide them behind a
window.IA_IDB check -- set only by pwa/idb.js, so it reliably
distinguishes the PWA build from desktop (Electron or a plain
browser tab against the real local service). Also hides the Stumble
News pill, the only UI entry point into a mode that's equally inert
on PWA.
EOF
)"
```
