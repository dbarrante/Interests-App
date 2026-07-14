# Single-Card Reader View (Imported) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A full-page, immersive single-card overlay for the Imported tab —
image-dominant with a text strip at the bottom — that pages through the
current filtered/sorted view one card at a time, with arrow/keyboard/swipe
navigation and a backup-first Remove that auto-advances.

**Architecture:** A new modal (`#readerModal`) in the existing
`#modal`/`#healthModal`/`#getpicModal` family, opened from a new per-card
icon button. Navigation state (`readerSnapshot`, `readerPos`) is new global
state, scoped to one open reader session at a time. `readerSnapshot` stores
**item ids, not array indices** — `removeCards()` splices the `imported`
array, which shifts every index after the removed item; ids are stable
across that splice, indices are not (see Task 1 for the id-assignment
detail this requires).

**Tech Stack:** Vanilla JS/CSS/HTML — same single-file `index.html`
convention as the rest of this project, no build step.

## Global Constraints

- Every edit applies identically to both `web/index.html` and
  `pwa/index.html` (byte-identical outside `<script src=...>` tags) — never
  edit only one.
- Imported tab only — no changes to Saved or Stumble.
- The reader shows the card's own stored data (title/image/description/
  tags) — never embeds or loads the actual external article.
- Reuse existing primitives: `impFilterPredicate`, `removeCards`,
  `snapshotBeforeDestructive`, `impThumb`, `esc`, `cleanDesc`, `toast`,
  `attachCardImages` — do not reimplement any of these.
- `readerSnapshot` is an array of `it.id` strings (not `imported` array
  indices) — indices go stale the moment `removeCards` splices `imported`;
  ids don't.
- Spec: `docs/superpowers/specs/2026-07-14-single-card-reader-view-design.md`

---

### Task 1: Modal scaffolding, entry icon, open/close, single-card render

**Files:**
- Modify: `web/index.html` (CSS ~lines 291, 327-331; HTML ~line 654; JS
  global state ~line 722, new functions after `impOpen` ~line 3368,
  `impCardHTML` ~line 3153)
- Modify: `pwa/index.html` (identical edits, offset by the pre-existing
  PWA-only comment block)

**Interfaces:**
- Consumes: `imported` (global array), `impFilterPredicate` (not yet used
  in this task — Task 2), `impThumb(it)`, `domain(it.url)`, `esc()`,
  `cleanDesc()`, `newId()`, `Store.putCards()`, `attachCardImages()`.
- Produces: `readerSnapshot` (global, array of item-id strings),
  `readerPos` (global, integer index into `readerSnapshot`),
  `readerImgHTML(it)`, `renderReader()`, `openReader(idx)`,
  `closeReader()`, `readerPage(dir)` — Tasks 2-4 call/modify these by name.

- [ ] **Step 1: Add the `#readerModal` markup**

In both files, replace:
```html
<div id="getpicModal"><div class="gp-box"><div id="getpicBody"></div></div></div>
```
with:
```html
<div id="getpicModal"><div class="gp-box"><div id="getpicBody"></div></div></div>
<div id="readerModal"><div class="reader-box" id="readerBody"></div></div>
```

- [ ] **Step 2: Add the reader CSS**

In both files, immediately after this existing line (the last rule of the
"Get pictures & info panel" CSS block):
```css
.gp-foot{padding:14px 20px;border-top:1px solid var(--line);display:flex;align-items:center;gap:12px;justify-content:flex-end;flex-wrap:wrap}
```
insert:
```css

/* ---- Single-card reader view (Imported triage) ---- */
#readerModal{display:none;position:fixed;inset:0;background:#000;z-index:97}
#readerModal.open{display:flex}
.reader-box{position:relative;width:100%;height:100%;display:flex;flex-direction:column}
.reader-close{position:absolute;top:14px;right:16px;z-index:2;border:0;background:rgba(0,0,0,.5);color:#fff;width:34px;height:34px;border-radius:50%;font-size:16px;cursor:pointer}
.reader-img{flex:1;min-height:0;background:#1a1815;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
.reader-img img{max-width:100%;max-height:100%;object-fit:contain}
.reader-img .ic{width:96px;height:96px;border-radius:16px;background:linear-gradient(135deg,#c2410c,#9a3412);color:#fff;font-size:32px;font-weight:800;display:flex;align-items:center;justify-content:center}
.reader-strip{position:absolute;left:0;right:0;bottom:0;background:linear-gradient(transparent,rgba(20,15,10,.92) 40%);color:#fff;padding:40px 60px 20px}
.reader-title{font-size:20px;font-weight:800;line-height:1.3}
.reader-desc{font-size:14px;color:#e8ddd0;margin-top:6px;line-height:1.5}
.reader-tags{margin-top:8px}
.reader-tags .tag{background:rgba(255,255,255,.16);color:#fff;border-radius:999px;padding:3px 10px;font-size:11px;font-weight:700;margin-right:6px;display:inline-block}
.reader-foot{display:flex;align-items:center;justify-content:space-between;margin-top:14px}
.reader-pos{font-size:12px;color:#cfc4b6}
.reader-arrow{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;background:rgba(0,0,0,.5);color:#fff;border:0;font-size:22px;cursor:pointer;z-index:2}
.reader-arrow.l{left:14px}
.reader-arrow.r{right:14px}
.reader-arrow:disabled{opacity:.25;cursor:default}
```
(`z-index:97` sits above `#modal`(90)/`#healthModal`/`#getpicModal`(95) —
the reader "layers over everything" per spec — but below `#toast`(99), so
toast notifications still show on top of an open reader.)

- [ ] **Step 3: Add the `.imp-reader` icon button style**

In both files, replace:
```css
.imp-edit,.imp-refresh{position:absolute;top:6px;z-index:6;width:28px;height:28px;border:1px solid var(--line);background:rgba(255,255,255,.94);border-radius:8px;cursor:pointer;display:none;align-items:center;justify-content:center;font-size:14px;line-height:1;padding:0;color:var(--muted);box-shadow:0 1px 3px rgba(0,0,0,.08)}
.imp-edit{right:6px}
.imp-refresh{right:40px;font-size:15px}
.imp-card:hover .imp-edit,.imp-card:hover .imp-refresh{display:flex}
.imp-edit:hover,.imp-refresh:hover{border-color:var(--accent);color:var(--accent)}
```
with:
```css
.imp-edit,.imp-refresh,.imp-reader{position:absolute;top:6px;z-index:6;width:28px;height:28px;border:1px solid var(--line);background:rgba(255,255,255,.94);border-radius:8px;cursor:pointer;display:none;align-items:center;justify-content:center;font-size:14px;line-height:1;padding:0;color:var(--muted);box-shadow:0 1px 3px rgba(0,0,0,.08)}
.imp-edit{right:6px}
.imp-refresh{right:40px;font-size:15px}
.imp-reader{right:74px}
.imp-card:hover .imp-edit,.imp-card:hover .imp-refresh,.imp-card:hover .imp-reader{display:flex}
.imp-edit:hover,.imp-refresh:hover,.imp-reader:hover{border-color:var(--accent);color:var(--accent)}
```

- [ ] **Step 4: Add the entry-point icon to `impCardHTML()`**

In both files, replace:
```js
    ${selMode?`<div class="pickov" onclick="togglePick(${idx})">${selPicks.has(idx)?'<span class="pk">&#10003;</span>':""}</div>`:`${it.url?`<button class="imp-refresh${(it.lastResult==='pending' && _refreshPins.has(it.id))?' spin':''}" title="Refresh image — recapture this page" onclick="event.stopPropagation();impRefresh(${idx})">&#8635;</button>`:""}<button class="imp-edit" title="Edit card" onclick="event.stopPropagation();impEdit(${idx})">&#9998;</button>`}
```
with:
```js
    ${selMode?`<div class="pickov" onclick="togglePick(${idx})">${selPicks.has(idx)?'<span class="pk">&#10003;</span>':""}</div>`:`${it.url?`<button class="imp-refresh${(it.lastResult==='pending' && _refreshPins.has(it.id))?' spin':''}" title="Refresh image — recapture this page" onclick="event.stopPropagation();impRefresh(${idx})">&#8635;</button>`:""}<button class="imp-reader" title="Open reader view" onclick="event.stopPropagation();openReader(${idx})">&#128214;</button><button class="imp-edit" title="Edit card" onclick="event.stopPropagation();impEdit(${idx})">&#9998;</button>`}
```
(Note: this is deliberately a sibling of `impOpen()`, not a call to it —
`impOpen()` has side effects — click history, recapture-request triggers,
`openLink(it.url)` navigation — that the reader must NOT trigger, since
the reader shows the card's own data and never navigates away.)

- [ ] **Step 5: Add the global reader state**

In both files, replace:
```js
let saved=[], hidden=[], clicks=[], shown=[], likes=[], imported=[], spool=[], stDeal=[], stSize=1;
```
with:
```js
let saved=[], hidden=[], clicks=[], shown=[], likes=[], imported=[], spool=[], stDeal=[], stSize=1;
let readerSnapshot=null, readerPos=0;   // reader view: array of item ids (NOT imported-array indices — removeCards splices imported, which shifts indices but not ids) + current position
```

- [ ] **Step 6: Add the reader functions**

In both files, find the end of `impOpen()` — replace:
```js
  if(doCapture) enrichOnOpen(it, idx);
}
// Force a fresh image for one card: drop the current picture and request a
```
with:
```js
  if(doCapture) enrichOnOpen(it, idx);
}
// Single-card reader view — image-dominant overlay for triaging Imported
// items one at a time. readerSnapshot holds item ids (not imported-array
// indices), because removeCards() splices the imported array and shifts
// every index after the removed item; ids stay valid across that splice.
function readerImgHTML(it){
  const dom = it.url ? domain(it.url) : "";
  const yt = /^YouTube/i.test(it.title) || /youtu/.test(dom);
  const thumb = impThumb(it);
  const isIdbImg = it.img && String(it.img).indexOf("idb:")===0;
  if(isIdbImg) return `<img data-imgid="${esc(it.id)}" loading="lazy" onerror="this.outerHTML='<div class=ic>${yt?"YT":"IM"}</div>'">`;
  if(thumb) return `<img src="${esc(thumb)}" loading="lazy" onerror="this.outerHTML='<div class=ic>${yt?"YT":"IM"}</div>'">`;
  return `<div class="ic">${yt?"YT":"IM"}</div>`;
}
function renderReader(){
  if(!readerSnapshot || !readerSnapshot.length){ closeReader(); return; }
  const it = imported.find(c=>c && c.id===readerSnapshot[readerPos]);
  if(!it){ closeReader(); return; }
  document.getElementById("readerBody").innerHTML = `
    <button class="reader-close" onclick="closeReader()">&#10005;</button>
    <div class="reader-img">${readerImgHTML(it)}</div>
    <div class="reader-strip">
      <div class="reader-title">${esc(it.title)}</div>
      ${it.desc?`<div class="reader-desc">${esc(cleanDesc(it.desc))}</div>`:""}
      ${it.tags&&it.tags.length?`<div class="reader-tags">${it.tags.map(t=>`<span class="tag">${esc(t)}</span>`).join("")}</div>`:""}
      <div class="reader-foot">
        <span class="reader-pos">${readerPos+1} of ${readerSnapshot.length}</span>
      </div>
    </div>
    <button class="reader-arrow l" onclick="readerPage(-1)" ${readerPos<=0?"disabled":""}>&#8249;</button>
    <button class="reader-arrow r" onclick="readerPage(1)" ${readerPos>=readerSnapshot.length-1?"disabled":""}>&#8250;</button>`;
  attachCardImages();
}
function openReader(idx){
  const it = imported[idx];
  if(!it) return;
  if(!it.id){ it.id=newId(); Store.putCards(imported); }   // same lazy-id-assignment impOpen() does
  readerSnapshot = [it.id];
  readerPos = 0;
  document.getElementById("readerModal").classList.add("open");
  renderReader();
}
function closeReader(){
  document.getElementById("readerModal").classList.remove("open");
  readerSnapshot = null;
}
function readerPage(dir){
  if(!readerSnapshot) return;
  const next = readerPos + dir;
  if(next<0 || next>=readerSnapshot.length) return;
  readerPos = next;
  renderReader();
}
// Force a fresh image for one card: drop the current picture and request a
```

- [ ] **Step 7: Verify file parity and syntax**

```bash
diff <(sed 's/<script[^>]*><\/script>//g; s/<script[^>]*>//g' web/index.html) <(sed 's/<script[^>]*><\/script>//g; s/<script[^>]*>//g' pwa/index.html)
node tests/syntax-check.js
```
Expected: diff shows only the pre-existing PWA-only comment block;
syntax-check reports 0 errors (same count as before).

- [ ] **Step 8: Manual verification**

```bash
cd pwa && python -m http.server 8080
```
With some existing Imported cards, open `http://localhost:8080/`, go to
Imported, hover a card, click the new 📖 icon (should appear between the
⟲ refresh and ✎ edit icons — right of refresh, left of edit): confirm the
reader opens full-page showing that card's image (or the YT/IM badge if no
image), title, description (if any), tags (if any), and "1 of 1". Confirm
both arrow buttons are disabled (only one item in the snapshot at this
stage). Confirm ✕ closes it back to the grid.

- [ ] **Step 9: Commit**

```bash
cd "D:\Dropbox\Documents\Claude\Projects\Interests App"
git add web/index.html pwa/index.html
git commit -m "feat(web,pwa): single-card reader view scaffolding (Imported)"
```

---

### Task 2: Real paging — snapshot the current filtered/sorted view

**Files:**
- Modify: `web/index.html` (`openReader()`, added in Task 1)
- Modify: `pwa/index.html` (identical edit)

**Interfaces:**
- Consumes: `readerSnapshot`/`readerPos`/`openReader` (Task 1),
  `impFilterPredicate(it, savedUrls)`, `saved` (global), `impSort`
  (global).
- Produces: nothing new — `openReader`'s signature and `readerSnapshot`'s
  shape (array of ids) are unchanged; only what goes into the array
  changes.

- [ ] **Step 1: Replace `openReader()`'s snapshot computation**

In both files, replace:
```js
function openReader(idx){
  const it = imported[idx];
  if(!it) return;
  if(!it.id){ it.id=newId(); Store.putCards(imported); }   // same lazy-id-assignment impOpen() does
  readerSnapshot = [it.id];
  readerPos = 0;
  document.getElementById("readerModal").classList.add("open");
  renderReader();
}
```
with:
```js
function openReader(idx){
  const it = imported[idx];
  if(!it) return;
  // Every item needs a stable id BEFORE building the snapshot (readerSnapshot
  // is id-based) — assign any missing ones now, mirroring impOpen()'s lazy
  // per-item assignment, but for the whole array at once.
  let idsAssigned = false;
  imported.forEach(c=>{ if(c && !c.id){ c.id=newId(); idsAssigned=true; } });
  if(idsAssigned) Store.putCards(imported);
  const savedUrls = new Set(saved.filter(s=>s.url).map(s=>s.url));
  readerSnapshot = imported.map((c,i)=>({it:c,idx:i}))
    .filter(r=>impFilterPredicate(r.it, savedUrls))
    .sort((a,b)=>{ const av=a.it.sdate||a.it.ts||0, bv=b.it.sdate||b.it.ts||0; return impSort==="oldest" ? av-bv : bv-av; })
    .map(r=>r.it.id);
  readerPos = readerSnapshot.indexOf(it.id);
  if(readerPos<0) readerPos = 0;
  document.getElementById("readerModal").classList.add("open");
  renderReader();
}
```
(This is the exact same filter+sort chain `renderImported()` uses to build
its `list` — `imported.map((it,idx)=>({it,idx})).filter(r=>impFilterPredicate(r.it, savedUrls)).sort(...)`
— so the reader's paging order always matches what's currently on screen.)

- [ ] **Step 2: Verify file parity and syntax**

```bash
diff <(sed 's/<script[^>]*><\/script>//g; s/<script[^>]*>//g' web/index.html) <(sed 's/<script[^>]*><\/script>//g; s/<script[^>]*>//g' pwa/index.html)
node tests/syntax-check.js
```
Expected: same as Task 1 Step 7.

- [ ] **Step 3: Manual verification**

With multiple Imported cards visible (at least 3), open the reader from
one in the middle of the grid: confirm the position indicator shows the
correct "N of M" matching that card's position in the currently-visible
(filtered/sorted) grid order, both arrows are enabled (except at the
actual ends), and clicking Next/Previous moves through cards in the same
order as the grid. Apply a search or tag filter in Imported first, then
open the reader from a card in that filtered view: confirm the reader's
snapshot respects the active filter (paging stays within the filtered
set, matching the count shown in the grid's "N shown" label).

- [ ] **Step 4: Commit**

```bash
git add web/index.html pwa/index.html
git commit -m "feat(web,pwa): reader view pages through the current filtered/sorted Imported view"
```

---

### Task 3: Keyboard and touch-swipe paging

**Files:**
- Modify: `web/index.html` (the unified Escape `keydown` listener; a new
  touch listener added right after it)
- Modify: `pwa/index.html` (identical edits)

**Interfaces:**
- Consumes: `readerPage(dir)`, `closeReader()` (Task 1), the existing
  `readerModal`/`getpicModal`/`healthModal`/`modal` `.open`-class
  convention.
- Produces: nothing new consumed elsewhere.

- [ ] **Step 1: Extend the unified keydown handler**

In both files, replace:
```js
// Unified Escape handler for all three overlay surfaces (was three separate keydown
// listeners each closing independently — a single Esc could close more than one at
// once). Topmost-first priority: getpic modal, then health modal, then the guide
// modal. One Esc closes exactly one surface.
document.addEventListener("keydown", e=>{
  if(e.key!=="Escape") return;
  if(document.getElementById("getpicModal").classList.contains("open")) closeGetPics();
  else if(document.getElementById("healthModal").classList.contains("open")) closeHealth();
  else if(document.getElementById("modal").classList.contains("open")) closeGuide();
});
```
with:
```js
// Unified keydown handler for all overlay surfaces (was three separate keydown
// listeners each closing independently — a single Esc could close more than one at
// once). Topmost-first priority: reader, then getpic modal, then health modal, then
// the guide modal. One Esc closes exactly one surface. The reader also gets
// Left/Right arrow-key paging while it's the open surface.
document.addEventListener("keydown", e=>{
  const readerOpen = document.getElementById("readerModal").classList.contains("open");
  if(readerOpen && e.key==="ArrowLeft"){ readerPage(-1); return; }
  if(readerOpen && e.key==="ArrowRight"){ readerPage(1); return; }
  if(e.key!=="Escape") return;
  if(readerOpen) closeReader();
  else if(document.getElementById("getpicModal").classList.contains("open")) closeGetPics();
  else if(document.getElementById("healthModal").classList.contains("open")) closeHealth();
  else if(document.getElementById("modal").classList.contains("open")) closeGuide();
});
```

- [ ] **Step 2: Add touch-swipe paging**

In both files, immediately after the keydown handler block from Step 1
(right after its closing `});`), insert:
```js
// Touch-swipe paging for the reader view. Delegated on #readerBody (a
// stable element — its innerHTML is replaced on every render, but the
// container itself persists) and scoped to .reader-img so a swipe
// starting on the Remove button or tags doesn't also page. Attached once
// at boot; works on any touch-capable device (touch events simply never
// fire on non-touch devices, so no platform/width check is needed).
let _readerTouchX = null;
document.getElementById("readerBody").addEventListener("touchstart", e=>{
  if(!e.target.closest(".reader-img")) return;
  _readerTouchX = e.touches[0].clientX;
});
document.getElementById("readerBody").addEventListener("touchend", e=>{
  if(_readerTouchX==null) return;
  const dx = e.changedTouches[0].clientX - _readerTouchX;
  _readerTouchX = null;
  if(Math.abs(dx) < 40) return;   // ignore small/accidental drags and taps
  readerPage(dx<0 ? 1 : -1);      // swipe left (negative dx) -> next, matching the › arrow
});
```

- [ ] **Step 3: Verify file parity and syntax**

```bash
diff <(sed 's/<script[^>]*><\/script>//g; s/<script[^>]*>//g' web/index.html) <(sed 's/<script[^>]*><\/script>//g; s/<script[^>]*>//g' pwa/index.html)
node tests/syntax-check.js
```
Expected: same as Task 1 Step 7.

- [ ] **Step 4: Manual verification**

With the reader open on a middle item: press Right arrow key, confirm it
pages to the next card (same as clicking ›); press Left arrow key, confirm
it pages back; press Esc, confirm it closes the reader specifically (not
some other modal). Open the reader, then also open Library Health on top
of it (if reachable) or another modal, and confirm Esc closes only the
topmost one first. On a touch-capable device or browser touch-emulation
(e.g. Chrome DevTools device toolbar with touch simulation), swipe left on
the image area, confirm it pages to the next card; swipe right, confirm it
pages back; confirm a small/accidental touch (tap) on the image doesn't
trigger a page change; confirm swiping while starting on the Remove
button/tags area doesn't page (only `.reader-img` swipes count).

- [ ] **Step 5: Commit**

```bash
git add web/index.html pwa/index.html
git commit -m "feat(web,pwa): keyboard arrow-key and touch-swipe paging for the reader view"
```

---

### Task 4: Remove — backup-first delete with auto-advance

**Files:**
- Modify: `web/index.html` (`renderReader()`'s `.reader-foot` markup, new
  `readerRemove()` function)
- Modify: `pwa/index.html` (identical edits)

**Interfaces:**
- Consumes: `readerSnapshot`/`readerPos`/`renderReader`/`closeReader`
  (Task 1), `snapshotBeforeDestructive()`, `removeCards(ids, opts)`,
  `renderImported()`, `toast()`, `curTab` (global).
- Produces: `readerRemove()` — not consumed by any later task (this is the
  last task).

- [ ] **Step 1: Add the Remove button to `renderReader()`**

In both files, replace:
```js
      <div class="reader-foot">
        <span class="reader-pos">${readerPos+1} of ${readerSnapshot.length}</span>
      </div>
```
with:
```js
      <div class="reader-foot">
        <button class="reader-remove" onclick="readerRemove()">&#128465; Remove</button>
        <span class="reader-pos">${readerPos+1} of ${readerSnapshot.length}</span>
      </div>
```

- [ ] **Step 2: Add the Remove button CSS**

In both files, immediately after this existing line:
```css
.reader-pos{font-size:12px;color:#cfc4b6}
```
insert:
```css
.reader-remove{background:var(--accent-strong);color:#fff;border:0;border-radius:999px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer}
```

- [ ] **Step 3: Add `readerRemove()`**

In both files, find the end of `readerPage(dir)` (added in Task 1) —
replace:
```js
function readerPage(dir){
  if(!readerSnapshot) return;
  const next = readerPos + dir;
  if(next<0 || next>=readerSnapshot.length) return;
  readerPos = next;
  renderReader();
}
```
with:
```js
function readerPage(dir){
  if(!readerSnapshot) return;
  const next = readerPos + dir;
  if(next<0 || next>=readerSnapshot.length) return;
  readerPos = next;
  renderReader();
}
// Backup-first delete, matching the Library-health pattern exactly
// (snapshotBeforeDestructive -> removeCards -> toast). readerSnapshot
// stores ids specifically so this splice-then-renumber never invalidates
// the remaining entries the way an index-based snapshot would.
function readerRemove(){
  if(!readerSnapshot || !readerSnapshot.length) return;
  const id = readerSnapshot[readerPos];
  const it = imported.find(c=>c && c.id===id);
  if(!it) return;
  snapshotBeforeDestructive();
  removeCards(new Set([id]), {scope:"imported"});
  readerSnapshot.splice(readerPos, 1);
  if(curTab==="imported") renderImported();
  if(!readerSnapshot.length){ closeReader(); toast("Removed 1 card"); return; }
  if(readerPos >= readerSnapshot.length) readerPos = readerSnapshot.length - 1;
  renderReader();
  toast("Removed 1 card");
}
```

- [ ] **Step 4: Verify file parity and syntax**

```bash
diff <(sed 's/<script[^>]*><\/script>//g; s/<script[^>]*>//g' web/index.html) <(sed 's/<script[^>]*><\/script>//g; s/<script[^>]*>//g' pwa/index.html)
node tests/syntax-check.js
```
Expected: same as Task 1 Step 7.

- [ ] **Step 5: Manual verification**

With at least 3 Imported cards visible, open the reader on the first one:
click Remove, confirm — a toast confirms removal, the reader immediately
shows what was previously "next" (now at the same position, "N of M" with
M decremented by 1), the card is genuinely gone from the grid underneath
(close the reader and confirm the grid no longer shows it, and it's still
gone after a page reload — confirming `persistCards`/the real Store write
happened, not just an in-memory splice). Page to the LAST card in the
snapshot and click Remove: confirm the reader closes back to the grid
(nothing left to advance to) rather than showing a blank/broken state.
Confirm a Dropbox backup was actually triggered by `snapshotBeforeDestructive()`
(check the backup folder's timestamp updates, or just confirm the call
fires — it's fire-and-forget by design, matching every other destructive
action in this app).

- [ ] **Step 6: Full regression pass**

```bash
node tests/run.js
```
Expected: `ALL TEST FILES PASSED`. This feature has no automated coverage
of its own (matching this project's convention for `index.html`'s inline
script) — this run only confirms nothing else broke.

- [ ] **Step 7: Commit**

```bash
git add web/index.html pwa/index.html
git commit -m "feat(web,pwa): reader view Remove button (backup-first delete, auto-advance)"
```
