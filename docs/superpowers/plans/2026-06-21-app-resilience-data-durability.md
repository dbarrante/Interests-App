# Data Durability (Resilience Pillar 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Interests App's ~5,500-card archive un-loseable via automatic, rotated, verified daily backups to the connected folder, a storage-health safety net, and one-click recovery — with no backend and no break to the single-file model.

**Architecture:** All app logic stays inline in `index.html`. Backups reuse the existing File System Access `dirHandle` (the one that already syncs `saves.json`) to write full image-bearing backups directly into the connected (Dropbox-synced) folder, rotating to the last 3 and verifying each write. Pure helpers (rotation selection, count comparison) are extracted as self-contained top-level functions so a new Node `tests/` harness can unit-test them; browser/File-System code is validated by an inline-script syntax gate plus a manual test pass.

**Tech Stack:** Vanilla JS (single-file `index.html`), File System Access API, IndexedDB, `localStorage`; Node (no deps) for the test harness.

**Spec:** `docs/superpowers/specs/2026-06-21-app-resilience-data-durability-design.md`

**Conventions for this codebase:**
- No build step; everything is inline in `index.html`. Add new top-level functions next to related code (backup functions near `collectBackup`/`maybeAutoBackup` ~line 823–860; folder functions near `connectFolder`/`writeSavesFile` ~line 3112–3168).
- Pure, Node-testable functions MUST be written as **top-level** functions whose **closing `}` is at column 0** and whose internal braces are indented (the test extractor matches `\nfunction NAME …\n}`).
- After ANY change to `index.html`, run `node tests/syntax-check.js` — it must print `… 0 error(s)`.
- Commit after each task.

---

## Task 1: Test harness scaffold

**Files:**
- Create: `tests/syntax-check.js`
- Create: `tests/_extract.js`
- Create: `tests/README.md`

- [ ] **Step 1: Create the inline-script syntax gate**

Create `tests/syntax-check.js`:

```js
// Validates every inline <script> block in index.html parses. Exit 1 on any error.
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
let m, i = 0, e = 0;
while ((m = re.exec(html))) {
  i++;
  try { new Function(m[1]); }
  catch (x) { e++; console.log("BLOCK " + i + ": " + x.message); }
}
console.log(i + " script block(s), " + e + " error(s)");
process.exit(e ? 1 : 0);
```

- [ ] **Step 2: Create the function extractor**

Create `tests/_extract.js`:

```js
// Pull self-contained top-level functions out of index.html by name so we can
// unit-test the real source without a build step. Requires each function's
// closing brace to be at column 0 (internal braces indented).
const fs = require("fs");
const path = require("path");
function loadFns(names) {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const out = {};
  for (const name of names) {
    const re = new RegExp("\\nfunction " + name + "\\b[\\s\\S]*?\\n\\}");
    const m = html.match(re);
    if (!m) throw new Error("function not found in index.html: " + name);
    out[name] = eval("(" + m[0].trim() + ")");
  }
  return out;
}
module.exports = { loadFns };
```

- [ ] **Step 3: Document how to run tests**

Create `tests/README.md`:

```markdown
# Tests (no dependencies — plain Node)

- `node tests/syntax-check.js` — every inline <script> in index.html must parse (0 errors). Run before every commit.
- `node tests/durability.test.js` — unit tests for pure backup logic extracted from index.html.

Pure functions are extracted from index.html by `_extract.js` (regex on a top-level
`function NAME(){ … }` whose closing brace is at column 0). Keep such functions
formatted that way.
```

- [ ] **Step 4: Run the syntax gate against the current file**

Run: `node tests/syntax-check.js`
Expected: `2 script block(s), 0 error(s)` (exit 0).

- [ ] **Step 5: Commit**

```bash
git add tests/syntax-check.js tests/_extract.js tests/README.md
git commit -m "test: add Node syntax gate + function extractor (resilience harness seed)"
```

---

## Task 2: Pure logic — `pickBackupsToDelete`

**Files:**
- Create: `tests/durability.test.js`
- Modify: `index.html` (add `pickBackupsToDelete` near `collectBackup`, ~line 823)

- [ ] **Step 1: Write the failing test**

Create `tests/durability.test.js`:

```js
const assert = require("assert");
const { loadFns } = require("./_extract");
const { pickBackupsToDelete } = loadFns(["pickBackupsToDelete"]);

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

t("keeps newest 3, deletes the rest (by date)", () => {
  const names = [
    "interests-backup-2026-06-18.json",
    "interests-backup-2026-06-21.json",
    "interests-backup-2026-06-19.json",
    "interests-backup-2026-06-20.json",
    "interests-backup-2026-06-17.json",
  ];
  const del = pickBackupsToDelete(names, 3).sort();
  assert.deepStrictEqual(del, ["interests-backup-2026-06-17.json", "interests-backup-2026-06-18.json"]);
});
t("fewer than keep → delete nothing", () => {
  assert.deepStrictEqual(pickBackupsToDelete(["interests-backup-2026-06-21.json"], 3), []);
});
t("ignores non-matching filenames", () => {
  const names = ["saves.json", "interests-snapshot-latest.json", "interests-backup-before-restore-123.json", "interests-backup-2026-06-21.json"];
  assert.deepStrictEqual(pickBackupsToDelete(names, 3), []);
});
t("empty / undefined input → []", () => {
  assert.deepStrictEqual(pickBackupsToDelete([], 3), []);
  assert.deepStrictEqual(pickBackupsToDelete(undefined, 3), []);
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/durability.test.js`
Expected: throws `function not found in index.html: pickBackupsToDelete` (exit 1) — red.

- [ ] **Step 3: Implement `pickBackupsToDelete` in index.html**

Add directly **above** `async function collectBackup(){` (~line 823):

```js
// Given backup filenames, return the ones to delete (all but the newest `keep`
// by the embedded date). Pure — only touches the exact daily-backup name pattern,
// so snapshots / saves.json / before-restore copies are never selected.
function pickBackupsToDelete(names, keep){
  var re = /^interests-backup-(\d{4}-\d{2}-\d{2})\.json$/;
  var dated = (names || [])
    .map(function(n){ var m = re.exec(n); return m ? { name: n, date: m[1] } : null; })
    .filter(Boolean)
    .sort(function(a, b){ return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
  return dated.slice(Math.max(0, keep)).map(function(d){ return d.name; });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node tests/durability.test.js`
Expected: `4 passed, 0 failed` (exit 0).

- [ ] **Step 5: Syntax gate**

Run: `node tests/syntax-check.js`
Expected: `0 error(s)`.

- [ ] **Step 6: Commit**

```bash
git add index.html tests/durability.test.js
git commit -m "feat(backup): pickBackupsToDelete (pure, tested) for rotation"
```

---

## Task 3: Pure logic — `backupCountsMatch`

**Files:**
- Modify: `tests/durability.test.js` (add tests)
- Modify: `index.html` (add `backupCountsMatch` below `pickBackupsToDelete`)

- [ ] **Step 1: Add the failing tests**

In `tests/durability.test.js`, change the `loadFns` line to also load the new function:

```js
const { pickBackupsToDelete, backupCountsMatch } = loadFns(["pickBackupsToDelete", "backupCountsMatch"]);
```

And add these tests **before** the final `console.log(pass …)`:

```js
t("counts equal → true", () => {
  assert.strictEqual(backupCountsMatch({ imported: 5500, saved: 18, images: 4301 }, { imported: 5500, saved: 18, images: 4301 }), true);
});
t("any count differs → false", () => {
  assert.strictEqual(backupCountsMatch({ imported: 5500, saved: 18, images: 4301 }, { imported: 5500, saved: 18, images: 4300 }), false);
});
t("missing operand → false", () => {
  assert.strictEqual(backupCountsMatch(null, { imported: 1, saved: 1, images: 1 }), false);
  assert.strictEqual(backupCountsMatch({ imported: 1, saved: 1, images: 1 }, undefined), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/durability.test.js`
Expected: throws `function not found in index.html: backupCountsMatch` (exit 1) — red.

- [ ] **Step 3: Implement `backupCountsMatch`**

Add directly **below** `pickBackupsToDelete` in index.html:

```js
// True when two _counts objects agree on imported/saved/images. Used to verify a
// freshly-written backup before older ones are rotated away.
function backupCountsMatch(a, b){
  if(!a || !b) return false;
  return (a.imported|0) === (b.imported|0) && (a.saved|0) === (b.saved|0) && (a.images|0) === (b.images|0);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/durability.test.js`
Expected: `7 passed, 0 failed`.

- [ ] **Step 5: Syntax gate + commit**

```bash
node tests/syntax-check.js   # expect 0 error(s)
git add index.html tests/durability.test.js
git commit -m "feat(backup): backupCountsMatch (pure, tested) for verification"
```

---

## Task 4: Folder I/O helpers

**Files:**
- Modify: `index.html` (add below `writeSavesFile`, ~line 3168)

These use the File System Access API (browser only) — validated by the syntax gate + manual test (Task 9).

- [ ] **Step 1: Add the helpers**

Insert after `writeSavesFile(){…}` (after ~line 3168):

```js
const BACKUP_KEEP = 3;
// Single permission gate for every folder read/write.
async function folderReady(){
  try{ return !!dirHandle && (await dirHandle.queryPermission({mode:"readwrite"})) === "granted"; }
  catch(e){ return false; }
}
async function writeFileToFolder(name, text){
  if(!(await folderReady())) return false;
  try{
    const fh = await dirHandle.getFileHandle(name, {create:true});
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
    return true;
  }catch(e){ console.warn("writeFileToFolder failed ("+name+"):", e && e.message); return false; }
}
async function listFolderBackups(){
  if(!(await folderReady())) return [];
  const out = [];
  try{
    for await (const [name, h] of dirHandle.entries()){
      if(h.kind === "file" && /^interests-backup-\d{4}-\d{2}-\d{2}\.json$/.test(name)){
        out.push({ name: name, date: name.slice(17, 27) });   // "interests-backup-" is 17 chars
      }
    }
  }catch(e){ console.warn("listFolderBackups failed", e); }
  out.sort(function(a, b){ return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); });
  return out;
}
async function rotateBackups(keep){
  if(!(await folderReady())) return;
  keep = (keep == null) ? BACKUP_KEEP : keep;
  const names = [];
  try{ for await (const [name, h] of dirHandle.entries()){ if(h.kind === "file") names.push(name); } }
  catch(e){ return; }
  for(const n of pickBackupsToDelete(names, keep)){ try{ await dirHandle.removeEntry(n); }catch(e){} }
}
async function verifyBackup(name, expectedCounts){
  if(!(await folderReady())) return false;
  try{
    const fh = await dirHandle.getFileHandle(name);
    const file = await fh.getFile();
    const data = JSON.parse(await file.text());
    return backupCountsMatch(data._counts, expectedCounts);
  }catch(e){ console.warn("verifyBackup failed", e); return false; }
}
```

- [ ] **Step 2: Syntax gate**

Run: `node tests/syntax-check.js`
Expected: `0 error(s)`.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat(backup): folder I/O helpers (folderReady, write/list/rotate/verify)"
```

---

## Task 5: Backup engine (rework auto-backup → folder, rotated, verified)

**Files:**
- Modify: `index.html` — replace `exportData`/`maybeAutoBackup` (~840–858), repoint the button (~446) and Ctrl+Shift+B (~860), extend `connectFolder` (~3120–3128).

- [ ] **Step 1: Replace `exportData` + `maybeAutoBackup` with the shared engine**

Replace the whole block from `async function exportData(){` through the end of `async function maybeAutoBackup(){ … }` (lines ~840–858) with:

```js
function markBackupDone(counts, verified, where, name){
  try{
    localStorage.setItem("ia_lastbackup", String(Date.now()));
    localStorage.setItem("ia_backup_last", JSON.stringify({ ts:Date.now(), counts:counts, verified:!!verified, where:where, name:name }));
  }catch(e){}
  const info = document.getElementById("backupInfo");
  if(info) info.textContent = "Last backup: "+counts.imported+" imported, "+counts.saved+" saved, "+counts.images+" images"+(verified?" ✓ verified":"")+" ("+where+")";
  if(typeof renderDurabilityStatus === "function"){ try{ renderDurabilityStatus(); }catch(e){} }
}
// Shared backup core: write a full, image-bearing backup to the connected folder
// (rotated + verified) if connected, else download it. Returns true on success.
async function doBackup(){
  let data;
  try{ data = await collectBackup(); }catch(e){ console.warn("collectBackup failed", e); toast("Backup failed to assemble data"); return false; }
  const name = "interests-backup-" + new Date().toISOString().slice(0,10) + ".json";
  if(await folderReady()){
    const wrote = await writeFileToFolder(name, JSON.stringify(data));
    const ok = wrote && await verifyBackup(name, data._counts);
    if(ok){
      await rotateBackups(BACKUP_KEEP);
      markBackupDone(data._counts, true, "folder", name);
      toast("Backup saved + verified to your folder ("+data._counts.imported+" imported, "+data._counts.images+" images)", 6000);
      return true;
    }
    toast("⚠ Backup write/verify failed — kept your older backups. Check the folder connection.", 8000);
    return false;
  }
  try{ downloadJSON(data, name); }catch(e){ console.warn("download backup failed", e); return false; }
  markBackupDone(data._counts, false, "download", name);
  toast("Backup downloaded. Connect a folder (Settings → Backup) for automatic, rotated, offsite backups.", 8000);
  return true;
}
async function backupNow(){ return doBackup(); }   // manual: button + Ctrl+Shift+B (bypasses the interval)
async function maybeAutoBackup(){
  const days = +S.autoBackup; if(!days) return;
  let last = 0; try{ last = +localStorage.getItem("ia_lastbackup") || 0; }catch(e){}
  if(Date.now() - last < days*86400000) return;
  await doBackup();
}
```

- [ ] **Step 2: Repoint the manual backup button**

In the Settings markup (~line 446) change:

```html
        <button class="btn btn-primary" onclick="exportData()">&#11015; Download full backup</button>
```
to:
```html
        <button class="btn btn-primary" onclick="backupNow()">&#128190; Back up now</button>
```

- [ ] **Step 3: Repoint Ctrl+Shift+B**

Change (~line 860):

```js
document.addEventListener("keydown", e=>{ if((e.ctrlKey||e.metaKey) && e.shiftKey && (e.key==="B"||e.key==="b")){ e.preventDefault(); exportData(); } });
```
to:
```js
document.addEventListener("keydown", e=>{ if((e.ctrlKey||e.metaKey) && e.shiftKey && (e.key==="B"||e.key==="b")){ e.preventDefault(); backupNow(); } });
```

- [ ] **Step 4: Connecting a folder enables daily backups + runs one now**

In `connectFolder()` (~3120), replace:

```js
    await writeSavesFile();
    toast("Connected — saves.json will stay in sync");
```
with:
```js
    await writeSavesFile();
    if(!(+S.autoBackup)){ S.autoBackup = 1; save("settings", S); const sel = document.getElementById("autoBackup"); if(sel) sel.value = "1"; }
    toast("Connected — saves.json syncing + daily backups on");
    doBackup();   // capture an initial full backup to the folder right away
```

- [ ] **Step 5: Syntax gate**

Run: `node tests/syntax-check.js`
Expected: `0 error(s)`.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat(backup): folder-first rotated+verified backups; backupNow; connect enables daily"
```

---

## Task 6: Storage health + durability banner

**Files:**
- Modify: `index.html` — add `storageHealthCheck`/`showDurabilityBanner`/`renderDurabilityStatus` (near `maybeAutoBackup`); add a status block to Settings markup (~after line 447); call `renderDurabilityStatus` from `renderSettings`.

- [ ] **Step 1: Add the health functions**

Add after `maybeAutoBackup(){…}`:

```js
async function storageHealthCheck(){
  let persisted = null, usage = 0, quota = 0;
  try{
    if(navigator.storage && navigator.storage.persisted){
      persisted = await navigator.storage.persisted();
      if(!persisted && navigator.storage.persist){ persisted = await navigator.storage.persist(); }
    }
  }catch(e){}
  try{ if(navigator.storage && navigator.storage.estimate){ const est = await navigator.storage.estimate(); usage = est.usage || 0; quota = est.quota || 0; } }catch(e){}
  let folder = "none";
  if(dirHandle){ folder = (await folderReady()) ? "connected" : "lapsed"; }
  let lastBackup = 0; try{ lastBackup = +localStorage.getItem("ia_lastbackup") || 0; }catch(e){}
  const health = { persisted: persisted, usage: usage, quota: quota, folder: folder, lastBackup: lastBackup, ts: Date.now() };
  try{ localStorage.setItem("ia_health", JSON.stringify(health)); }catch(e){}
  const days = +S.autoBackup || 0;
  const stale = days && lastBackup && (Date.now() - lastBackup > (days + 1) * 86400000);
  const atRisk = (folder === "lapsed") || (folder === "none" && days) || (persisted === false && (!lastBackup || stale));
  if(atRisk) showDurabilityBanner(folder);
  renderDurabilityStatus(health);
  return health;
}
function showDurabilityBanner(folder){
  if(document.getElementById("durBanner")) return;
  const b = document.createElement("div");
  b.className = "banner"; b.id = "durBanner";
  const msg = folder === "lapsed"
    ? "⚠ Automatic backups are paused — reconnect your backup folder."
    : "⚠ No backup folder connected — your data lives only in this browser.";
  b.innerHTML = "<span>" + msg + "</span><button class=\"btn btn-primary\" style=\"padding:6px 14px\">Connect folder</button>";
  b.querySelector("button").onclick = function(){ connectFolder(); b.remove(); };
  const main = document.querySelector("main"); if(main) main.prepend(b);
}
function renderDurabilityStatus(health){
  const el = document.getElementById("durStatus"); if(!el) return;
  let h = health;
  if(!h){ try{ h = JSON.parse(localStorage.getItem("ia_health") || "null"); }catch(e){} }
  h = h || { folder:"none", persisted:null, usage:0, quota:0 };
  const mb = function(n){ return Math.round((n||0)/1048576); };
  let last = "none yet";
  try{ const lb = JSON.parse(localStorage.getItem("ia_backup_last") || "null"); if(lb) last = new Date(lb.ts).toLocaleString() + " · " + lb.counts.imported + " imported, " + lb.counts.images + " images" + (lb.verified ? " · ✓ verified" : "") + " (" + lb.where + ")"; }catch(e){}
  const folderTxt = h.folder === "connected" ? "✓ connected" : (h.folder === "lapsed" ? "⚠ reconnect needed" : "not connected");
  const persistTxt = h.persisted === true ? "✓ granted" : (h.persisted === false ? "⚠ not granted (eviction possible)" : "unknown");
  el.innerHTML =
    "<div>Backup folder: <b>" + folderTxt + "</b></div>" +
    "<div>Storage persistence: <b>" + persistTxt + "</b></div>" +
    (h.quota ? ("<div>Storage used: <b>" + mb(h.usage) + " / " + mb(h.quota) + " MB</b></div>") : "") +
    "<div>Last full backup: <b>" + last + "</b></div>";
}
```

- [ ] **Step 2: Add the status block to Settings markup**

In the "Backup & restore" section, immediately after the `#backupInfo` span (~line 447), add:

```html
        <div id="durStatus" class="hint" style="margin-top:10px;line-height:1.7"></div>
```

- [ ] **Step 3: Populate it when Settings opens**

In `renderSettings()` (search for `function renderSettings(){`), add as the **last line before the closing `}`**:

```js
  if(typeof renderDurabilityStatus === "function") renderDurabilityStatus();
```

- [ ] **Step 4: Syntax gate**

Run: `node tests/syntax-check.js`
Expected: `0 error(s)`.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat(backup): storage-health check, durability status block + at-risk banner"
```

---

## Task 7: Pre-destructive rolling snapshot

**Files:**
- Modify: `index.html` — add `snapshotBeforeDestructive`; call it at the top of `applyDupeRemoval`, `groomNoLink`, and the manual branch of `clearFbPlaceholders`.

- [ ] **Step 1: Add the snapshot helper**

Add below the folder helpers (after `verifyBackup`):

```js
// Capture the CURRENT card lists (refs-only, no images) to a rolling file BEFORE a
// bulk-destructive op, so a mistaken removal is recoverable. Captures synchronously
// (so the caller's mutation can't race it), writes async/fire-and-forget.
function snapshotBeforeDestructive(){
  let text;
  try{ text = JSON.stringify({ updated:new Date().toISOString(), _snapshot:true, saved:saved, hidden:hidden, clicks:clicks, likes:likes, imported:imported, about:S.about, interests:S.interests, weights:S.weights }, null, 2); }
  catch(e){ return; }
  writeFileToFolder("interests-snapshot-latest.json", text);   // fire-and-forget; folderReady checked inside
}
```

- [ ] **Step 2: Hook the bulk-destructive paths**

Add `snapshotBeforeDestructive();` as the **first statement inside the function body** of:
- `applyDupeRemoval(` (search for `function applyDupeRemoval`)
- `groomNoLink(` (search for `function groomNoLink`)

And in `clearFbPlaceholders(silent)` (search for `function clearFbPlaceholders`), add immediately after the opening `{`:

```js
  if(!silent) snapshotBeforeDestructive();
```

- [ ] **Step 3: Syntax gate**

Run: `node tests/syntax-check.js`
Expected: `0 error(s)`.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(backup): rolling refs snapshot before dedupe/groom/clear-placeholders"
```

---

## Task 8: One-click recovery (folder restore)

**Files:**
- Modify: `index.html` — refactor `restoreData` into `applyRestore` (~861–899); add `restoreLatest`, `renderBackupList`; add Settings markup + buttons.

- [ ] **Step 1: Replace `restoreData` with `applyRestore` + a thin file-picker wrapper**

Replace the entire `function restoreData(ev){ … }` block (~861–899) with:

```js
// Restore core, shared by the file picker and the folder restore. Validates,
// saves a safety copy (folder if connected, else download), wipes ia_*, writes
// keys, restores IndexedDB images, reloads.
async function applyRestore(data, sourceLabel){
  const keys = data && data.keys;
  if(!keys || typeof keys !== "object" || !Object.keys(keys).length){ toast("This file isn't an Interests backup"); return false; }
  const n = Object.keys(keys).length;
  const when = data._exported ? (" from " + data._exported.slice(0,10)) : "";
  const cnt = data._counts ? (" (" + data._counts.imported + " imported, " + data._counts.saved + " saved)") : "";
  if(!confirm("Restore this backup" + when + cnt + (sourceLabel ? ("\n[" + sourceLabel + "]") : "") + "?\n\nThis REPLACES everything currently in the app. A safety copy of your current data is saved first.")) return false;
  // 1. safety copy of current state (folder if connected, else download)
  try{
    const safety = await collectBackup();
    const sname = "interests-backup-before-restore-" + Date.now() + ".json";
    if(await folderReady()) await writeFileToFolder(sname, JSON.stringify(safety));
    else downloadJSON(safety, sname);
  }catch(e){}
  // 2. wipe + 3. write keys back verbatim
  try{
    const existing = [];
    for(let i=0;i<localStorage.length;i++){ const k = localStorage.key(i); if(k && k.startsWith("ia_")) existing.push(k); }
    existing.forEach(function(k){ localStorage.removeItem(k); });
    Object.keys(keys).forEach(function(k){ if(k.startsWith("ia_")){ const v = keys[k]; localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v)); } });
  }catch(e){ toast("Restore failed: " + e.message + " — data may exceed this browser's storage limit"); return false; }
  // 4. restore card images into IndexedDB
  const images = data.images || {};
  for(const id of Object.keys(images)){ try{ await idbPutImg(id, images[id]); }catch(e){} }
  toast("Restored " + n + " data sets + " + Object.keys(images).length + " images — reloading…");
  setTimeout(function(){ location.reload(); }, 1000);
  return true;
}
function restoreData(ev){
  const file = ev.target.files && ev.target.files[0]; if(!file) return;
  const reset = function(){ ev.target.value = ""; };
  const reader = new FileReader();
  reader.onerror = function(){ toast("Couldn't read that file"); reset(); };
  reader.onload = function(){
    let data;
    try{ data = JSON.parse(reader.result); }catch(e){ toast("Not a valid backup file (bad JSON)"); reset(); return; }
    applyRestore(data, file.name).then(reset, reset);
  };
  reader.readAsText(file);
}
async function restoreLatest(){
  if(!(await folderReady())){ toast("Connect your backup folder first, or use 'Restore from a file' below."); return; }
  const list = await listFolderBackups();
  if(!list.length){ toast("No backups found in the connected folder."); return; }
  const newest = list[0];
  let data;
  try{ const fh = await dirHandle.getFileHandle(newest.name); const f = await fh.getFile(); data = JSON.parse(await f.text()); }
  catch(e){ toast("Couldn't read " + newest.name); return; }
  await applyRestore(data, newest.name);
}
async function restoreFromList(name){
  let data;
  try{ const fh = await dirHandle.getFileHandle(name); const f = await fh.getFile(); data = JSON.parse(await f.text()); }
  catch(e){ toast("Couldn't read " + name); return; }
  await applyRestore(data, name);
}
async function renderBackupList(){
  const el = document.getElementById("backupList"); if(!el) return;
  const list = await listFolderBackups();
  if(!list.length){ el.innerHTML = ""; return; }
  el.innerHTML = "<div class=\"hint\" style=\"margin-top:10px\">Backups in your folder:</div>" +
    list.map(function(b){ return "<div style=\"margin:4px 0\"><b>" + b.date + "</b> <button class=\"btn btn-ghost\" style=\"padding:3px 10px;margin-left:8px\" onclick=\"restoreFromList('" + b.name + "')\">Restore</button></div>"; }).join("");
}
```

- [ ] **Step 2: Add the restore-latest button + list to Settings**

In the "Backup & restore" section, immediately **before** `<label style="margin-top:16px;display:block">Restore from a backup file</label>` (~line 456), insert:

```html
        <label style="margin-top:16px;display:block">Restore</label>
        <button class="btn btn-primary" onclick="restoreLatest()">&#8617; Restore latest backup</button>
        <div id="backupList"></div>
```

Then change that following label text from `Restore from a backup file` to `Restore from a file instead` (so the two paths read clearly). The file input line stays unchanged.

- [ ] **Step 3: Populate the list when Settings opens**

In `renderSettings()`, add after the `renderDurabilityStatus()` line from Task 6:

```js
  if(typeof renderBackupList === "function") renderBackupList();
```

- [ ] **Step 4: Syntax gate**

Run: `node tests/syntax-check.js`
Expected: `0 error(s)`.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "feat(backup): applyRestore refactor + one-click restore-latest + folder pick-list"
```

---

## Task 9: Boot wiring + manual verification pass

**Files:**
- Modify: `index.html` — boot sequence (~3617–3619).

- [ ] **Step 1: Order boot so the folder handle + health run before backup**

Replace lines ~3617–3619:

```js
restoreFolder();

initImageStore().then(()=>{ if(curTab==="imported") renderImported(); maybeAutoBackup(); }).catch(e=>console.warn("image store init failed",e));
```
with:
```js
(async()=>{
  try{ await restoreFolder(); }catch(e){ console.warn("restoreFolder failed", e); }
  try{ await initImageStore(); if(curTab==="imported") renderImported(); }
  catch(e){ console.warn("image store init failed", e); }
  try{ await storageHealthCheck(); }catch(e){ console.warn("health check failed", e); }
  maybeAutoBackup();
})();
setInterval(function(){ maybeAutoBackup(); }, 6*3600*1000);   // keep a long-open session backing up across day boundaries
```

- [ ] **Step 2: Run all automated checks**

Run: `node tests/syntax-check.js` → expect `0 error(s)`.
Run: `node tests/durability.test.js` → expect `7 passed, 0 failed`.

- [ ] **Step 3: Manual test pass (hard-reload the app at localhost:3456 in Chrome)**

Verify each, noting results:
1. **Connect:** Settings → Connect app folder (pick the Dropbox folder) → toast says daily backups on; the auto-backup dropdown shows "Every day"; a `interests-backup-<today>.json` appears in the folder; "Last full backup" status shows ✓ verified.
2. **Rotate:** create 4 dummy `interests-backup-2026-06-1X.json` files in the folder, run **Back up now** → only the newest 3 remain (today's + the two newest dummies); `saves.json` and any `interests-snapshot-*`/`before-restore` files are untouched.
3. **Verify-guard:** (sanity) confirm the status block reads "✓ verified".
4. **Health/banner:** in Chrome → site settings, revoke the folder permission → reload → top banner "Automatic backups are paused — reconnect"; status shows "⚠ reconnect needed".
5. **Snapshot:** run Scan duplicates → remove some → `interests-snapshot-latest.json` exists in the folder (refs only).
6. **Restore latest:** Settings → Restore latest backup → confirm dialog shows date+counts → after reload, imported/saved counts and FB card images are intact.
7. **Pick-list:** the "Backups in your folder" list shows the dated backups, each with a Restore button.
8. **Fallback:** disconnect/none state → Back up now downloads to Downloads + nudge toast; file-picker restore still works.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(backup): boot order (folder→images→health→backup) + 6h auto-backup timer"
```

---

## Self-review notes (author)

- **Spec coverage:** Component 1 → Tasks 2–5 (rotate=Task2, verify=Task3, engine=Task5). Component 2 → Tasks 6–7. Component 3 → Task 8. `tests/` seed → Tasks 1–3. Boot/health wiring → Task 9. All spec sections mapped.
- **Type/name consistency:** `folderReady`, `writeFileToFolder`, `listFolderBackups`, `rotateBackups(BACKUP_KEEP)`, `verifyBackup`, `pickBackupsToDelete`, `backupCountsMatch`, `doBackup`/`backupNow`/`maybeAutoBackup`, `markBackupDone`, `storageHealthCheck`/`showDurabilityBanner`/`renderDurabilityStatus`, `snapshotBeforeDestructive`, `applyRestore`/`restoreLatest`/`restoreFromList`/`renderBackupList` — used consistently across tasks.
- **Pre-reqs:** `pickBackupsToDelete`/`backupCountsMatch` (Tasks 2–3) exist before `rotateBackups`/`verifyBackup` use them (Task 4); `renderDurabilityStatus` referenced by `markBackupDone` (Task 5) is guarded by `typeof … === "function"` until defined in Task 6.
- **No placeholders:** every code step is complete and runnable.
