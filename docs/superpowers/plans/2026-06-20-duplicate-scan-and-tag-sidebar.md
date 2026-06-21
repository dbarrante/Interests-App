# Duplicate Scan/Review + Tags Sidebar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add (A) a duplicate scan with a review modal that matches cards by fuzzy title OR normalized link across Imported+Saved and removes the extras keeping the best copy, and (B) a Settings toggle that renders Imported tags in a sticky left sidebar.

**Architecture:** Single-file vanilla app — ALL app changes are in `index.html` (inline `<script>` + `<style>`). Feature A adds pure helpers (`normTitle`, `scanDuplicates`, `dupePrimary`) + a dedicated `#dupeModal` overlay + `applyDupeRemoval`, and repoints the existing toolbar dedup button. Feature B factors the tag list into one producer used by both the existing top bar and a new sticky `.tag-side` column, gated by `S.tagSidebar`.

**Tech Stack:** HTML/CSS/JS in one file; `localStorage` (`ia_*` via `save()`/`load()`); IndexedDB images (`idb:<id>` refs, `_imgCache`, `idbDelImg`). No build, no test framework — pure-logic tasks are tested with throwaway Node scripts that extract the real function source from `index.html` and `eval` it; UI tasks are verified with an inline-script syntax check + manual steps.

**Key existing helpers to reuse (do not reinvent):** `normalizeUrl(url)`, `isBadImg(u)`, `resolveImg(v)`, `setCardImage(it,src)`, `setSavedImage(item,src)`, `idbDelImg(id)`, `_imgCache`, `imageChain(item)`, `esc(s)`, `domain(u)`, `toast(msg,ms)`, `save(key,val)`, `writeSavesFile()`, `updateCounts()`, `renderImported()`, `setImpTag(t)`, `impTag`, the `S` settings object + `save("settings",S)`, and the `#modal`/`#modalBody` guide overlay (`showGuide`/`closeGuide`) as a styling reference.

**Conventions:** Commit after each task. Run the syntax check (Task 0) after every task that edits `index.html`. Date in commit bodies is fine to omit. End commits with the Co-Authored-By line already used in this repo.

---

## Task 0: Syntax-check harness (reference — used by every later task)

No code change. This is the command every task runs after editing `index.html`.

- [ ] **Step 1: Confirm the check command works**

Run (from the app root `D:\Dropbox\Documents\Claude\Projects\Interests App`):

```bash
node -e 'const fs=require("fs");const html=fs.readFileSync("index.html","utf8");const re=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;let m,i=0,e=0;while((m=re.exec(html))){i++;try{new Function(m[1])}catch(x){e++;console.log("Block",i,"ERR:",x.message)}}console.log(i+" block(s), "+e+" error(s)")'
```

Expected: `2 block(s), 0 error(s)`

---

## Task A1: `normTitle(t)` fuzzy-title normalizer

**Files:**
- Modify: `index.html` — add `normTitle` next to `normalizeUrl` (search for `function normalizeUrl` in the inline script and add directly after it).
- Test: `tmp/test_normTitle.js` (throwaway; delete after).

- [ ] **Step 1: Write the failing test**

Create `tmp/test_normTitle.js`:

```javascript
const fs = require("fs");
const src = fs.readFileSync("index.html", "utf8");
const m = src.match(/function normTitle\s*\([\s\S]*?\n\}/);
if (!m) { console.error("normTitle not found"); process.exit(1); }
eval(m[0]);
const eq = (a, b, label) => { const pass = a === b; console.log(pass ? "PASS" : "FAIL", label, "=>", JSON.stringify(a)); if (!pass) process.exitCode = 1; };
// emoji + punctuation + casing + "See more" collapse to the same key
eq(normTitle("LOW-CARB Pepperoni Pizza! 🍕"), normTitle("low carb pepperoni pizza"), "emoji/punct/case same key");
eq(normTitle("Keto Bacon Cheeseburger Casserole… See more"), normTitle("keto bacon cheeseburger casserole"), "trailing see-more stripped");
eq(normTitle("From your 'Food' Facebook collection — Keto Daily"), normTitle("keto daily"), "leading collection cruft stripped");
// short / generic titles return "" (not groupable by title)
eq(normTitle("Facebook post"), "", "generic short title -> empty");
eq(normTitle("hi"), "", "too short -> empty");
eq(normTitle(""), "", "empty -> empty");
// a real title returns a non-empty normalized key
console.log(normTitle("DeLorean DMC-12 Widebody").length > 0 ? "PASS real title nonempty" : "FAIL real title nonempty");
```

- [ ] **Step 2: Run it — expect failure**

Run: `node tmp/test_normTitle.js`
Expected: FAIL `normTitle not found` (exit 1).

- [ ] **Step 3: Implement `normTitle`**

Add immediately after the `normalizeUrl` function in the inline `<script>`:

```javascript
// Fuzzy title key for duplicate detection. Returns "" for titles too short/generic
// to group on safely (callers then fall back to link-only matching for that card).
function normTitle(t){
  let s = (t==null?"":String(t)).toLowerCase().replace(/ /g," ");
  s = s.replace(/\bfrom your\b.*?\bcollection\b/g, " ");        // "From your 'Food' Facebook collection"
  s = s.replace(/^\s*saved\b/g, " ");                            // leading "Saved ..."
  s = s.replace(/[…]|\.\.\.\s*(see more|more)?\s*$/g, " "); // trailing …/... / "see more"
  s = s.replace(/\bsee more\b\s*$/g, " ");
  s = s.replace(/[^a-z0-9 ]+/g, " ");                            // drop emoji/punctuation
  s = s.replace(/\s+/g, " ").trim();
  // generic platform titles ("facebook post", "saved video", "reel", …) must NOT group
  if (/^(facebook|fb|instagram|ig|pinterest|saved)?\s?(post|video|reel|photo|photos|story|link|watch|pin|item)s?$/.test(s)) return "";
  if (s.length < 10 || s.split(" ").length < 2) return "";       // too short to group on safely
  return s;
}
```

- [ ] **Step 4: Run the test — expect pass**

Run: `node tmp/test_normTitle.js`
Expected: all `PASS`, exit 0.

- [ ] **Step 5: Syntax-check + commit**

Run the Task 0 command (expect `0 error(s)`), then:

```bash
rm tmp/test_normTitle.js
git add index.html
git commit -m "Add normTitle() fuzzy-title key for duplicate detection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task A2: `dupePrimary(members)` keep-the-best chooser

**Files:**
- Modify: `index.html` — add `dupePrimary` after `normTitle`.
- Test: `tmp/test_dupePrimary.js` (throwaway).

`members` is an array of `{card, scope, idx}` where `scope` is `"imported"` or `"saved"`. Returns the member to KEEP.

- [ ] **Step 1: Write the failing test**

Create `tmp/test_dupePrimary.js`:

```javascript
const fs = require("fs");
const src = fs.readFileSync("index.html", "utf8");
function grab(name){ const m = src.match(new RegExp("function "+name+"\\s*\\([\\s\\S]*?\\n\\}")); if(!m){console.error(name+" missing");process.exit(1);} return m[0]; }
// stubs the function depends on:
global._imgCache = {};
global.isBadImg = (u)=> !u || /favicon|mshots|thum\.io/i.test(u);
global.resolveImg = (v)=> !v ? "" : (v.indexOf("idb:")===0 ? (_imgCache[v.slice(4)]||"") : v);
eval(grab("dupePrimary"));
const card = (o)=>({id:o.id, img:o.img||"", image:o.image||"", desc:o.desc||"", tags:o.tags||[], sdate:o.sdate||0, ts:o.ts||0});
const M = (c,scope)=>({card:c,scope:scope||"imported",idx:0});
// real image beats no image
let g1=[M(card({id:"a"})), M(card({id:"b",img:"data:image/jpeg;base64,xxxx"}))];
console.log(dupePrimary(g1).card.id==="b" ? "PASS image wins" : "FAIL image wins");
// among imageless, Saved beats Imported
let g2=[M(card({id:"i"}),"imported"), M(card({id:"s"}),"saved")];
console.log(dupePrimary(g2).card.id==="s" ? "PASS saved wins" : "FAIL saved wins");
// desc beats no desc when images equal (both none)
let g3=[M(card({id:"x"})), M(card({id:"y",desc:"hello there"}))];
console.log(dupePrimary(g3).card.id==="y" ? "PASS desc wins" : "FAIL desc wins");
```

- [ ] **Step 2: Run it — expect failure**

Run: `node tmp/test_dupePrimary.js`
Expected: FAIL `dupePrimary missing`.

- [ ] **Step 3: Implement `dupePrimary`**

Add after `normTitle`:

```javascript
// Pick the member to KEEP from a duplicate group. Higher score wins.
function dupePrimary(members){
  const score = (mem)=>{
    const it = mem.card;
    const img = mem.scope==="saved" ? it.image : it.img;
    let s = 0;
    if (img && !isBadImg(resolveImg(img))) s += 16;       // has a real picture
    if (it.desc && it.desc.length > 8) s += 8;             // has a description
    if (it.tags && it.tags.length) s += 4;                 // has tags
    if (it.sdate) s += 2;                                  // has a real saved date
    if (mem.scope==="saved") s += 1;                       // a deliberate Saved clip
    return s;
  };
  let best = members[0], bestScore = score(members[0]);
  for (let k=1; k<members.length; k++){
    const sc = score(members[k]);
    const older = (members[k].card.sdate||members[k].card.ts||0) < (best.card.sdate||best.card.ts||Infinity);
    if (sc > bestScore || (sc === bestScore && older)) { best = members[k]; bestScore = sc; }
  }
  return best;
}
```

- [ ] **Step 4: Run the test — expect pass**

Run: `node tmp/test_dupePrimary.js`
Expected: all `PASS`.

- [ ] **Step 5: Syntax-check + commit**

Run Task 0 check, then:

```bash
rm tmp/test_dupePrimary.js
git add index.html
git commit -m "Add dupePrimary() keep-the-best chooser for duplicate groups

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task A3: `scanDuplicates()` grouping across Imported + Saved

**Files:**
- Modify: `index.html` — add `scanDuplicates` after `dupePrimary`.
- Test: `tmp/test_scan.js` (throwaway).

Returns an array of groups; each group is `{members:[{card,scope,idx}], keepId}` with `members.length >= 2`. Grouping: union of normalized-link key and `normTitle` key (a card joins a group if it shares EITHER key with any member). Cards with no url AND empty normTitle are skipped.

- [ ] **Step 1: Write the failing test**

Create `tmp/test_scan.js`:

```javascript
const fs = require("fs");
const src = fs.readFileSync("index.html", "utf8");
function grab(name){ const m = src.match(new RegExp("function "+name+"\\s*\\([\\s\\S]*?\\n\\}")); if(!m){console.error(name+" missing");process.exit(1);} return m[0]; }
global._imgCache = {};
global.isBadImg = (u)=> !u || /favicon|mshots|thum\.io/i.test(u);
global.resolveImg = (v)=> !v ? "" : (v.indexOf("idb:")===0 ? (_imgCache[v.slice(4)]||"") : v);
global.normalizeUrl = (u)=>{ try{ const x=new URL(u); return (x.hostname.replace(/^www\./,"")+x.pathname).replace(/\/$/,"").toLowerCase(); }catch(e){ return (u||"").toLowerCase(); } };
eval(grab("normTitle")); eval(grab("dupePrimary"));
global.imported = [
  {id:"i1", url:"https://facebook.com/x/posts/1", title:"DeLorean DMC-12 Widebody build", img:""},
  {id:"i2", url:"https://www.facebook.com/x/posts/1/", title:"different text here entirely", img:""},   // dup of i1 by LINK
  {id:"i3", url:"https://facebook.com/y/posts/9", title:"Keto Bacon Cheeseburger Casserole", img:""},
  {id:"i4", url:"https://facebook.com/z/posts/8", title:"Keto Bacon Cheeseburger Casserole! 🍔 See more", img:""}, // dup of i3 by TITLE
  {id:"i5", url:"https://facebook.com/a/posts/3", title:"Facebook post", img:""},   // generic title, unique link -> NOT grouped
  {id:"i6", url:"https://facebook.com/b/posts/4", title:"Facebook post", img:""},   // generic title, unique link -> NOT grouped
];
global.saved = [
  {id:"s1", url:"https://facebook.com/y/posts/9", image:"data:image/jpeg;base64,zz", title:"Keto Bacon Cheeseburger Casserole"}, // dup of i3/i4 cross-scope
];
eval(grab("scanDuplicates"));
const groups = scanDuplicates();
const ids = groups.map(g=>g.members.map(m=>m.card.id).sort()).sort((a,b)=>a[0]<b[0]?-1:1);
console.log("groups:", JSON.stringify(ids));
const has = (arr)=> ids.some(g=> g.length===arr.length && g.every((x,k)=>x===arr[k]));
console.log(has(["i1","i2"]) ? "PASS link group i1+i2" : "FAIL link group i1+i2");
console.log(has(["i3","i4","s1"]) ? "PASS cross-scope title group i3+i4+s1" : "FAIL cross-scope title group");
console.log(!ids.some(g=>g.includes("i5")||g.includes("i6")) ? "PASS generic titles not grouped" : "FAIL generic titles grouped");
const g3 = groups.find(g=>g.members.some(m=>m.card.id==="s1"));
console.log(g3 && g3.keepId==="s1" ? "PASS keep s1 (has image)" : "FAIL keep s1");
```

- [ ] **Step 2: Run it — expect failure**

Run: `node tmp/test_scan.js`
Expected: FAIL `scanDuplicates missing`.

- [ ] **Step 3: Implement `scanDuplicates`**

Add after `dupePrimary`:

```javascript
// Find duplicate groups across imported + saved. Two cards match on the same
// normalized link OR the same fuzzy normTitle (empty normTitle never matches).
function scanDuplicates(){
  const members = [];
  imported.forEach((c,idx)=>{ if(c) members.push({card:c, scope:"imported", idx}); });
  saved.forEach((c,idx)=>{ if(c) members.push({card:c, scope:"saved", idx}); });
  // union-find over members keyed by url + title
  const parent = members.map((_,i)=>i);
  const find = (x)=>{ while(parent[x]!==x){ parent[x]=parent[parent[x]]; x=parent[x]; } return x; };
  const union = (a,b)=>{ const ra=find(a), rb=find(b); if(ra!==rb) parent[ra]=rb; };
  const byUrl = {}, byTitle = {};
  members.forEach((m,i)=>{
    const it = m.card;
    if (it.url){ const k="u:"+normalizeUrl(it.url); if(byUrl[k]!=null) union(byUrl[k], i); else byUrl[k]=i; }
    const t = normTitle(it.title);
    if (t){ const k="t:"+t; if(byTitle[k]!=null) union(byTitle[k], i); else byTitle[k]=i; }
  });
  const groups = {};
  members.forEach((m,i)=>{ const r=find(i); (groups[r]=groups[r]||[]).push(m); });
  const out = [];
  Object.values(groups).forEach(mem=>{
    if (mem.length < 2) return;
    out.push({ members: mem, keepId: dupePrimary(mem).card.id });
  });
  return out;
}
```

- [ ] **Step 4: Run the test — expect pass**

Run: `node tmp/test_scan.js`
Expected: all `PASS`.

- [ ] **Step 5: Syntax-check + commit**

Run Task 0 check, then:

```bash
rm tmp/test_scan.js
git add index.html
git commit -m "Add scanDuplicates() — link OR fuzzy-title grouping across imported+saved

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task A4: `#dupeModal` overlay + CSS

**Files:**
- Modify: `index.html` — add a `#dupeModal` element right after the existing `<div id="modal">…</div>` block (search for `id="modal"` in the HTML body), and add CSS after the `#modal` rules (search `#modal{` in the `<style>`).

This is a UI scaffold task (no behavior yet) so the modal exists for Task A5/A6.

- [ ] **Step 1: Add the overlay markup**

After the closing `</div>` of the existing `#modal` element, add:

```html
<div id="dupeModal"><div class="dupe-box"><div id="dupeBody"></div></div></div>
```

- [ ] **Step 2: Add CSS**

After the `#modal.open{display:flex}` rule in `<style>`, add:

```css
#dupeModal{display:none;position:fixed;inset:0;background:rgba(31,29,26,.5);z-index:95;align-items:flex-start;justify-content:center;padding:40px 16px;overflow:auto}
#dupeModal.open{display:flex}
.dupe-box{background:var(--card);color:var(--ink);border-radius:14px;box-shadow:var(--shadow);width:min(820px,96vw);max-height:88vh;display:flex;flex-direction:column;overflow:hidden}
.dupe-head{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px;font-weight:700}
.dupe-list{overflow:auto;padding:8px 16px}
.dupe-foot{padding:14px 20px;border-top:1px solid var(--line);display:flex;align-items:center;gap:12px;justify-content:flex-end}
.dupe-group{border:1px solid var(--line);border-radius:11px;padding:10px;margin:12px 0}
.dupe-row{display:flex;align-items:center;gap:12px;padding:6px 4px}
.dupe-row img,.dupe-row .ph{width:64px;height:48px;object-fit:cover;border-radius:7px;background:#e8e4de;flex-shrink:0}
.dupe-row .meta{flex:1;min-width:0}
.dupe-row .meta .t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dupe-row .meta .s{font-size:12px;opacity:.7}
.dupe-row.keep{background:rgba(34,139,69,.12);border-radius:8px}
.dupe-badge{font-size:11px;font-weight:700;padding:2px 7px;border-radius:6px;background:var(--line)}
```

- [ ] **Step 3: Syntax-check + commit**

Run Task 0 check (expect `0 error(s)`), then:

```bash
git add index.html
git commit -m "Add #dupeModal overlay scaffold + styles for duplicate review

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task A5: Render the review modal + selection state (`openDupeReview`, `closeDupeReview`, `dupeSetKeep`)

**Files:**
- Modify: `index.html` — add these functions after `scanDuplicates`.

State lives in module vars `_dupeGroups` (the scan result) so re-rendering on keep-reassign is cheap. Each removable row carries a checkbox `data-rm="<scope>:<id>"`, pre-checked. The kept row shows a "Keep" button (click to reassign) and no checkbox.

- [ ] **Step 1: Implement the render + helpers**

Add after `scanDuplicates`:

```javascript
let _dupeGroups = [];
function dupeThumb(mem){
  const it = mem.card;
  const v = mem.scope==="saved" ? it.image : it.img;
  const src = resolveImg(v);
  if (src && !isBadImg(src)) return `<img src="${esc(src)}" loading="lazy">`;
  return `<div class="ph"></div>`;
}
function dupeRowHTML(mem, gi, keep){
  const it = mem.card;
  const dom = domain(it.url) || (mem.scope==="saved"?"saved":"");
  const date = it.sdate ? new Date(it.sdate).toLocaleDateString() : "";
  const tag = mem.scope==="saved" ? "Saved" : "Imported";
  return `<div class="dupe-row${keep?" keep":""}">
    ${dupeThumb(mem)}
    <div class="meta"><div class="t">${esc(it.title||dom||"(untitled)")}</div>
      <div class="s">${esc(dom)} · <span class="dupe-badge">${tag}</span>${date?` · ${esc(date)}`:""}</div></div>
    ${keep
      ? `<span class="dupe-badge" style="background:rgba(34,139,69,.25)">Keep</span>`
      : `<label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" data-rm="${esc(mem.scope+":"+it.id)}" checked style="width:auto"> remove</label>
         <button class="btn btn-ghost" style="padding:4px 9px" onclick="dupeSetKeep(${gi},'${esc(it.id)}')">Keep this</button>`}
  </div>`;
}
function renderDupeModal(){
  const total = _dupeGroups.reduce((n,g)=>n+(g.members.length-1),0);
  const body = document.getElementById("dupeBody");
  body.innerHTML = `
    <div class="dupe-head"><span>&#128270; Duplicate review — ${_dupeGroups.length} group${_dupeGroups.length===1?"":"s"}, ${total} removable</span>
      <span style="flex:1"></span><button class="btn btn-ghost" onclick="closeDupeReview()">&#10005;</button></div>
    <div class="dupe-list">
      ${_dupeGroups.map((g,gi)=>`<div class="dupe-group">
        ${g.members.slice().sort((a,b)=> (a.card.id===g.keepId?-1:1)-(b.card.id===g.keepId?-1:1))
            .map(m=>dupeRowHTML(m, gi, m.card.id===g.keepId)).join("")}
      </div>`).join("")}
    </div>
    <div class="dupe-foot"><button class="btn btn-ghost" onclick="closeDupeReview()">Cancel</button>
      <button class="btn btn-primary" onclick="applyDupeRemoval()">Remove selected</button></div>`;
}
function dupeSetKeep(gi, id){
  if (_dupeGroups[gi]) _dupeGroups[gi].keepId = id;
  renderDupeModal();
}
function openDupeReview(groups){
  _dupeGroups = groups || [];
  if (!_dupeGroups.length){ toast("No duplicates found"); return; }
  renderDupeModal();
  document.getElementById("dupeModal").classList.add("open");
}
function closeDupeReview(){ document.getElementById("dupeModal").classList.remove("open"); _dupeGroups = []; }
```

- [ ] **Step 2: Syntax-check**

Run Task 0 check. Expected `0 error(s)`.

- [ ] **Step 3: Temporary manual smoke test**

In the app console (after hard-reload) run: `openDupeReview(scanDuplicates())`.
Expected: the modal opens listing duplicate groups with one "Keep" row each and pre-checked "remove" rows; the ✕/Cancel closes it; "Keep this" on another row moves the highlight. (No removal yet — that's Task A6/clicking "Remove selected" will error until A6.)

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Render duplicate-review modal + keep-reassign (openDupeReview/dupeSetKeep)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task A6: `applyDupeRemoval()` + repoint the toolbar button

**Files:**
- Modify: `index.html` — add `applyDupeRemoval` after `closeDupeReview`; replace the toolbar dedup button (search for `groomDupes()` in `renderImported` — the line `${(function(){const d=dupeCount();...})()}`).

`applyDupeRemoval` reads the checked `data-rm` boxes, merges best fields from each removed member into its group's kept card, removes the members from the right array, deletes orphaned IDB images, persists, re-renders, toasts.

- [ ] **Step 1: Implement `applyDupeRemoval`**

Add after `closeDupeReview`:

```javascript
function applyDupeRemoval(){
  const checked = new Set(Array.prototype.map.call(
    document.querySelectorAll('#dupeBody input[data-rm]:checked'), el=>el.getAttribute("data-rm")));
  if (!checked.size){ toast("Nothing selected to remove"); return; }
  const rmImported = new Set(), rmSaved = new Set();
  let removed = 0;
  for (const g of _dupeGroups){
    const keep = g.members.find(m=>m.card.id===g.keepId) || g.members[0];
    const keepIsSaved = keep.scope==="saved";
    for (const mem of g.members){
      if (mem===keep) continue;
      if (!checked.has(mem.scope+":"+mem.card.id)) continue;   // user spared it
      const src = mem.scope==="saved" ? mem.card.image : mem.card.img;
      const k = keep.card;
      // merge best fields into the kept card
      const keepImg = keepIsSaved ? k.image : k.img;
      if (isBadImg(resolveImg(keepImg)) && !isBadImg(resolveImg(src))){
        const data = resolveImg(src);
        if (data){ keepIsSaved ? setSavedImage(k, data) : setCardImage(k, data); }
      }
      if (!k.desc && mem.card.desc) k.desc = mem.card.desc;
      if (!k.sdate && mem.card.sdate) k.sdate = mem.card.sdate;
      if (mem.card.tags && mem.card.tags.length) k.tags = [...new Set([...(k.tags||[]), ...mem.card.tags])];
      if (mem.card.liked) k.liked = true;
      // delete the removed card's own (now orphaned) image
      const ref = mem.scope==="saved" ? mem.card.image : mem.card.img;
      if (ref && (ref+"").indexOf("idb:")===0){ idbDelImg(mem.card.id); delete _imgCache[mem.card.id]; }
      (mem.scope==="saved" ? rmSaved : rmImported).add(mem.card.id);
      removed++;
    }
  }
  if (rmImported.size) imported = imported.filter(c=>!c||!rmImported.has(c.id));
  if (rmSaved.size) saved = saved.filter(c=>!c||!rmSaved.has(c.id));
  save("imported", imported); save("saved", saved); writeSavesFile(); updateCounts();
  closeDupeReview();
  if (curTab==="imported") renderImported(); else if (curTab==="saved") renderSaved();
  toast("Removed "+removed+" duplicate"+(removed===1?"":"s")+" — kept the best copy of each", 5000);
}
```

- [ ] **Step 2: Replace the toolbar button**

In `renderImported`, find the line that renders the dedup button (it calls `dupeCount()` and `groomDupes()`):

```javascript
      ${(function(){const d=dupeCount(); return d?`<button class="btn btn-ghost" onclick="groomDupes()" title="Merge & remove cards that share the same link">&#128203; Remove ${d} duplicate${d>1?"s":""}</button>`:"";})()}
```

Replace it with:

```javascript
      <button class="btn btn-ghost" onclick="openDupeReview(scanDuplicates())" title="Scan Imported + Saved for duplicate links and near-identical titles, then review before removing">&#128270; Scan duplicates</button>
```

(Leave `dupeCount`/`groomDupes` defined — harmless dead code — OR delete both function bodies if you prefer; nothing else calls them after this change. Verify with `grep -n "groomDupes\|dupeCount" index.html` showing only the definitions.)

- [ ] **Step 3: Syntax-check**

Run Task 0 check. Expected `0 error(s)`.

- [ ] **Step 4: Manual verification**

Hard-reload `http://localhost:3456`. On the Imported tab click **🔎 Scan duplicates** → review modal lists groups → leave defaults → **Remove selected**. Expected: removed count toast; the Imported (and Saved) counts drop by the removed amount; the kept card retains a real image; re-running the scan shows fewer/no groups. Spot-check one kept card still opens/links correctly.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Duplicate removal (applyDupeRemoval) + replace one-click dedup with Scan duplicates

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task B1: Factor the tag list into one producer (`tagListData`)

**Files:**
- Modify: `index.html` — add `tagListData()` and refactor `tagBarHTML()` to use it (search `function tagBarHTML`).

Both the top bar and the new sidebar need the same `{top, untagged}` data — DRY it.

- [ ] **Step 1: Add `tagListData` + refactor `tagBarHTML`**

Replace the body of `tagBarHTML` so the counting lives in `tagListData`:

```javascript
function tagListData(){
  const counts = {}; let untagged = 0;
  imported.forEach(i=>{ if(i.tags && i.tags.length) i.tags.forEach(t=>counts[t]=(counts[t]||0)+1); else untagged++; });
  return { top: Object.entries(counts).sort((a,b)=>b[1]-a[1]), untagged };
}
function tagBarHTML(){
  const { top, untagged } = tagListData();
  const shown = top.slice(0,24);
  if(!shown.length && !untagged) return "";
  return `<div class="tagbar">
    ${impTag?`<span class="tg on" onclick="setImpTag('${esc(impTag)}')">&#10005; ${esc(impTag==="__none"?"untagged":impTag)}</span>`:""}
    ${shown.map(([t,n])=>impTag===t?"":`<span class="tg" onclick="setImpTag('${esc(t)}')">${esc(t)} <b>${n}</b></span>`).join("")}
    ${untagged && impTag!=="__none" ? `<span class="tg" style="opacity:.65" onclick="setImpTag('__none')">untagged <b>${untagged}</b></span>`:""}
  </div>`;
}
```

- [ ] **Step 2: Syntax-check + manual**

Run Task 0 check (`0 error(s)`). Hard-reload; Imported tab still shows the same top tag bar and clicking a tag still filters (no visible change — pure refactor).

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "Factor tag counting into tagListData() (shared by bar + future sidebar)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task B2: `S.tagSidebar` setting + Settings toggle

**Files:**
- Modify: `index.html` — add the checkbox to the Settings panel (search for `id="datesToggle"` in the HTML and add a sibling label after that line), and wire it in `renderSettings` (search for `datesToggle").onchange`).

- [ ] **Step 1: Add the checkbox markup**

After the `datesToggle` label line in the Settings HTML, add:

```html
        <label style="display:block;margin-top:8px">
          <input type="checkbox" id="tagSideToggle" style="width:auto"> Tags in a left sidebar (Imported view)
        </label>
```

- [ ] **Step 2: Wire it in `renderSettings`**

Immediately after the existing `document.getElementById("datesToggle").onchange = …;` line, add:

```javascript
  document.getElementById("tagSideToggle").checked = !!S.tagSidebar;
  document.getElementById("tagSideToggle").onchange = e=>{ S.tagSidebar = e.target.checked; save("settings", S); if(curTab==="imported") renderImported(); };
```

- [ ] **Step 3: Syntax-check + manual**

Run Task 0 check (`0 error(s)`). Hard-reload → Settings shows the new toggle; toggling it persists (reload Settings, box stays as set). It has no visible effect on Imported yet (Task B3 wires the layout).

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Add S.tagSidebar setting + Settings toggle (no layout effect yet)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task B3: Sidebar layout in `renderImported` + CSS + responsive

**Files:**
- Modify: `index.html` — branch the Imported body on `S.tagSidebar` (in `renderImported`, where `${tagBarHTML()}` and the `<div class="imp-grid …">` are produced), and add CSS after the `.imp-sticky` rules.

When `S.tagSidebar` is on AND viewport ≥ 760px: hide the top tag bar; wrap `[ .tag-side | .imp-grid ]` in `.imp-body`. Otherwise: current top bar.

- [ ] **Step 1: Add the sidebar producer**

Add near `tagBarHTML`:

```javascript
function tagSideHTML(){
  const { top, untagged } = tagListData();
  if(!top.length && !untagged) return `<aside class="tag-side"></aside>`;
  return `<aside class="tag-side">
    <div class="tag-side-h">Tags</div>
    ${impTag?`<span class="tg on" onclick="setImpTag('${esc(impTag)}')">&#10005; ${esc(impTag==="__none"?"untagged":impTag)}</span>`:""}
    ${top.map(([t,n])=>impTag===t?"":`<span class="tg" onclick="setImpTag('${esc(t)}')">${esc(t)} <b>${n}</b></span>`).join("")}
    ${untagged && impTag!=="__none" ? `<span class="tg" style="opacity:.65" onclick="setImpTag('__none')">untagged <b>${untagged}</b></span>`:""}
  </aside>`;
}
function impSidebarOn(){ return !!S.tagSidebar && window.innerWidth >= 760; }
```

- [ ] **Step 2: Branch the render**

In `renderImported`, the template currently ends the sticky block then renders `${tagBarHTML()}` and later the grid line `<div class="imp-grid ig-${viewMode}">…</div>`. Change:

(a) the tag-bar line `${tagBarHTML()}` → `${impSidebarOn()?"":tagBarHTML()}` (top bar only when sidebar is OFF).

(b) the grid line:

```javascript
    <div class="imp-grid ig-${viewMode}">${list.map(r=>impCardHTML(r.it,r.idx)).join("")}</div>`;
```

→

```javascript
    ${impSidebarOn()
      ? `<div class="imp-body">${tagSideHTML()}<div class="imp-grid ig-${viewMode}">${list.map(r=>impCardHTML(r.it,r.idx)).join("")}</div></div>`
      : `<div class="imp-grid ig-${viewMode}">${list.map(r=>impCardHTML(r.it,r.idx)).join("")}</div>`}`;
```

- [ ] **Step 3: Add CSS**

After the `.imp-sticky` rules in `<style>`, add:

```css
.imp-body{display:flex;align-items:flex-start;gap:16px}
.imp-body .imp-grid{flex:1;min-width:0}
.tag-side{flex:0 0 210px;position:sticky;top:var(--catBottom,104px);max-height:calc(100vh - var(--catBottom,104px) - 16px);overflow:auto;display:flex;flex-direction:column;gap:6px;padding:4px 2px}
.tag-side .tag-side-h{font-size:12px;font-weight:700;opacity:.6;text-transform:uppercase;letter-spacing:.04em;margin:2px 4px 4px}
.tag-side .tg{display:block;width:100%;box-sizing:border-box}
@media(max-width:760px){.tag-side{display:none}.imp-body{display:block}}
```

- [ ] **Step 4: Recompute sticky offset on resize**

`impSidebarOn()` depends on width, so a resize across 760px must re-render. In the existing `window.addEventListener("resize", setStickyOffsets)` registration, add a re-render. Find that line and change to:

```javascript
window.addEventListener("resize", ()=>{ setStickyOffsets(); if(curTab==="imported") renderImported(); });
```

- [ ] **Step 5: Syntax-check**

Run Task 0 check. Expected `0 error(s)`.

- [ ] **Step 6: Manual verification**

Hard-reload. With the Settings toggle OFF: Imported shows the top tag bar (unchanged). Turn it ON: the top bar disappears and a vertical tag list appears on the left, sticky while cards scroll, clicking a tag filters, the active-tag/"untagged"/clear still work. Narrow the window below ~760px: the sidebar hides and the top bar returns; widen: sidebar returns.

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "Render Imported tags in a sticky left sidebar when S.tagSidebar is on

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] Run Task 0 syntax check → `0 error(s)`.
- [ ] `grep -n "scanDuplicates\|dupePrimary\|normTitle\|applyDupeRemoval\|tagListData\|tagSideHTML\|S.tagSidebar" index.html` — every referenced symbol is defined.
- [ ] Manual end-to-end: Scan duplicates → review → remove (counts drop, best copy kept); Settings tag-sidebar toggle on/off + narrow-window fallback.
- [ ] Push: `git push origin master`.

---

## Spec coverage check (self-review)

- Fuzzy title match → Task A1 (`normTitle`) + A3 grouping. ✓
- Existing link match retained → Task A3 (`normalizeUrl` key). ✓
- Imported + Saved scope (incl. cross-scope groups) → Task A3 (members from both arrays, union). ✓
- Review list, pre-checked, reassign keep, confirm → Tasks A4/A5; removal A6. ✓
- Keep-the-best (image>desc>tags>date>Saved) + merge → Tasks A2 + A6. ✓
- Replace the one-click dedup button → Task A6 Step 2. ✓
- Orphan IDB image cleanup on removal → Task A6 (`idbDelImg`+`_imgCache`). ✓
- `S.tagSidebar` toggle in Settings → Task B2. ✓
- Sticky left sidebar, Imported only, top bar hidden when on, responsive fallback → Task B3. ✓
- Out of scope (same-image match, Saved sidebar, undo) → not implemented, as specified. ✓
