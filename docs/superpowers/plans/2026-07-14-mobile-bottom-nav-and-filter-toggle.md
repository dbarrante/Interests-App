# Mobile Bottom Tab Bar + Collapsible Filter Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On phone-width screens (≤760px), replace the top header's section
tabs with a fixed bottom tab bar, and collapse the category/tag pill bar(s)
behind a single tap-to-expand "Filter" toggle, so cards are visible without
scrolling past a screen-filling header.

**Architecture:** `pwa/index.html` and `web/index.html` share identical
CSS/markup/JS outside their `<script src=...>` load lists (confirmed by
diff) — every edit in this plan is applied identically to both files. All
new behavior is scoped inside the existing `@media(max-width:760px)`
breakpoint (the same one where the desktop tag sidebars already hide), so
wide-screen layout is untouched. `pwa/sw.js`'s `SHELL_CACHE` is bumped last
so an already-installed iPhone PWA actually picks up the change.

**Tech Stack:** Vanilla JS/CSS/HTML (no build step, no framework) — this is
a single large hand-written `index.html` per the existing project
convention.

## Global Constraints

- Every edit applies identically to both `pwa/index.html` and
  `web/index.html` — never edit only one.
- All new CSS/behavior lives inside `@media(max-width:760px)` (or CSS that
  only takes effect there) — the `>760px` desktop layout must be
  pixel-for-pixel unchanged.
- No new Settings entries, no persisted state for the new toggle — it always
  starts collapsed.
- Reuse existing functions/state (`showTab`, `setFilter`, `setImpSrc`,
  `renderCatBar`, `CATS`, `PLATS`) rather than introducing parallel
  implementations, per the design doc.
- Spec: `docs/superpowers/specs/2026-07-14-mobile-bottom-nav-and-filter-toggle-design.md`

---

### Task 1: Bottom tab bar (mobile-only), top header simplified

**Files:**
- Modify: `pwa/index.html` (viewport meta ~line 5; CSS block after the
  existing `@media(max-width:640px)` rule, ~line 79; header markup ~lines
  392-404; `updateCounts()` ~lines 2237-2240)
- Modify: `web/index.html` (same content, offset by −12 lines vs. `pwa/`
  after the PWA-only comment block — match by content, not line number)

**Interfaces:**
- Consumes: existing `showTab(t)` (defined ~line 819), existing
  `.tab`/`.tab.active`/`html.dark .tab.active` CSS rules.
- Produces: `[data-cnt="saved"]` / `[data-cnt="imported"]` as the new way
  count badges are targeted (replaces `id="savedCnt"`/`id="impCnt"`) — Task
  2/3 don't touch this, but any future work referencing those ids must be
  updated too.

- [ ] **Step 1: Add `viewport-fit=cover` to the viewport meta tag**

In both files, replace:
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0">
```
with:
```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
```

- [ ] **Step 2: Add the bottom-bar CSS**

In both files, immediately after the existing block that ends with
`.st-bar .btn{padding:12px 20px}\n}` (the `@media(max-width:640px)` rule,
just before the `/* ============ masonry — view modes ============ */`
comment), insert:

```css
/* Mobile (<=760px): the 4 section tabs move to a fixed bottom bar (same
   breakpoint where the desktop tag sidebars already hide), freeing the top
   header for just the logo + Help + Open-in-browser. */
@media(max-width:760px){
  header nav{display:none}
  body{padding-bottom:calc(54px + env(safe-area-inset-bottom))}
  .mtabbar{display:flex}
}
.mtabbar{
  display:none;position:fixed;left:0;right:0;bottom:0;z-index:60;
  gap:2px;background:rgba(246,245,243,.96);backdrop-filter:blur(8px);
  border-top:1px solid var(--line);
  padding:4px 4px calc(4px + env(safe-area-inset-bottom))
}
html.dark .mtabbar{background:rgba(26,24,22,.96)}
.mtabbar .mtab{
  flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;
  padding:6px 2px;font-size:10.5px;border-radius:11px
}
.mtabbar .mtab .micon{font-size:18px;line-height:1}
.mtabbar .mtab .cnt{margin-left:0}
```

- [ ] **Step 3: Add the bottom-bar markup, and switch the top nav's count
  spans from `id` to `data-cnt`**

In both files, replace:
```html
    <nav>
      <button class="tab active" data-tab="stumble" onclick="showTab('stumble')">Stumble</button>
      <button class="tab" data-tab="saved" onclick="showTab('saved')">Saved <span class="cnt" id="savedCnt"></span></button>
      <button class="tab" data-tab="imported" onclick="showTab('imported')">Imported <span class="cnt" id="impCnt"></span></button>
      <button class="tab" data-tab="settings" onclick="showTab('settings')">Settings</button>
    </nav>
    <button class="btn" id="helpBtn" onclick="openHelp()" title="Help &amp; About — version, data location, and a quick tour">?</button>
    <button class="btn" id="browserBtn" onclick="openInBrowser()" title="Open the Interests app in your default web browser (same live data — it talks to the same local service)">&#127760; Open in browser</button>
  </div>
</header>
```
with:
```html
    <nav>
      <button class="tab active" data-tab="stumble" onclick="showTab('stumble')">Stumble</button>
      <button class="tab" data-tab="saved" onclick="showTab('saved')">Saved <span class="cnt" data-cnt="saved"></span></button>
      <button class="tab" data-tab="imported" onclick="showTab('imported')">Imported <span class="cnt" data-cnt="imported"></span></button>
      <button class="tab" data-tab="settings" onclick="showTab('settings')">Settings</button>
    </nav>
    <button class="btn" id="helpBtn" onclick="openHelp()" title="Help &amp; About — version, data location, and a quick tour">?</button>
    <button class="btn" id="browserBtn" onclick="openInBrowser()" title="Open the Interests app in your default web browser (same live data — it talks to the same local service)">&#127760; Open in browser</button>
  </div>
</header>
<nav class="mtabbar tab" aria-label="Main">
  <button class="tab mtab active" data-tab="stumble" onclick="showTab('stumble')"><span class="micon">&#127919;</span>Stumble</button>
  <button class="tab mtab" data-tab="saved" onclick="showTab('saved')"><span class="micon">&#11088;</span>Saved <span class="cnt" data-cnt="saved"></span></button>
  <button class="tab mtab" data-tab="imported" onclick="showTab('imported')"><span class="micon">&#128229;</span>Imported <span class="cnt" data-cnt="imported"></span></button>
  <button class="tab mtab" data-tab="settings" onclick="showTab('settings')"><span class="micon">&#9881;</span>Settings</button>
</nav>
```

(Note the outer `<nav>` is `class="mtabbar"` only — `.tab`'s
`border-radius:999px` etc. must apply to each `<button class="tab mtab">`
inside it, not to the bar itself.)

- [ ] **Step 4: Update `updateCounts()` to target both sets of spans**

In both files, replace:
```js
function updateCounts(){
  document.getElementById("savedCnt").textContent = saved.length?`(${saved.length})`:"";
  document.getElementById("impCnt").textContent = imported.length?`(${imported.length})`:"";
}
```
with:
```js
function updateCounts(){
  document.querySelectorAll('[data-cnt="saved"]').forEach(el=>el.textContent = saved.length?`(${saved.length})`:"");
  document.querySelectorAll('[data-cnt="imported"]').forEach(el=>el.textContent = imported.length?`(${imported.length})`:"");
}
```

- [ ] **Step 5: Verify the two files are still identical outside their
  `<script>` load lists**

Run from the repo root:
```bash
diff <(sed 's/<script[^>]*><\/script>//g; s/<script[^>]*>//g' web/index.html) <(sed 's/<script[^>]*><\/script>//g; s/<script[^>]*>//g' pwa/index.html)
```
Expected: only the pre-existing PWA-only load-order comment block (the
lines already present near the top of `pwa/index.html`'s script list before
this change) — no other differences. If anything else shows up, one file
was edited and the other wasn't; fix before continuing.

- [ ] **Step 6: Run the syntax gate**

```bash
node tests/syntax-check.js
```
Expected: `N inline script block(s) + storage.js = M unit(s), 0 error(s)`
(same counts as before this change — `pwa/index.html`'s inline script body
is identical text, so this also validates it).

- [ ] **Step 7: Manual verification**

```bash
cd pwa && python -m http.server 8080
```
Open `http://localhost:8080/` in a browser, open DevTools' device toolbar,
and pick an iPhone preset (or manually narrow the window to ~375px):
- Top header shows only the logo, `?`, and "Open in browser" — no tabs, no
  wrapping.
- A bottom bar shows 4 tabs (Stumble/Saved/Imported/Settings) with icons;
  tapping each switches views exactly like the old top tabs did, and the
  tapped tab highlights.
- Saved/Imported counts on the bottom bar match the actual list sizes.
- Widen the window back past 760px: top header's nav reappears with tabs,
  bottom bar disappears, layout matches what it looked like before this
  change.

- [ ] **Step 8: Commit**

```bash
cd "D:\Dropbox\Documents\Claude\Projects\Interests App"
git add pwa/index.html web/index.html
git commit -m "feat(pwa): mobile bottom tab bar replaces top nav on narrow screens"
```

---

### Task 2: Collapsible filter toggle for Stumble & Saved

**Files:**
- Modify: `pwa/index.html` (state near `let filterCat`, ~line 809;
  `renderCatBar()`, ~lines 946-968; `setFilter()`, ~lines 969-974)
- Modify: `web/index.html` (same content, matched by function name/content)

**Interfaces:**
- Consumes: `CATS`, `esc()`, `catSidebarOn()`, `stSidebarOn()` (all
  pre-existing).
- Produces: `mobileNarrow()`, `toggleMobileFilter()`, `mobileFilterLabel()`,
  and the module-level `mobileFilterOpen` boolean — Task 3 (Imported) reuses
  all four by name.

- [ ] **Step 1: Add the `mobileFilterOpen` state and three helpers**

In both files, immediately after:
```js
let curTab = "stumble";
let filterCat = "";        // hydrated from Store.kv in bootData()
```
insert:
```js
let mobileFilterOpen = false;  // collapsible filter bar on narrow screens; never persisted
function mobileNarrow(){ return window.innerWidth < 760; }
function mobileFilterLabel(){
  if(curTab==="imported"){ const m=PLATS.find(([k])=>k===impSrc); return m?m[1]:"All sources"; }
  const pills=[{key:"",name:"All"}].concat(CATS);
  const m=pills.find(c=>c.key===filterCat); return m?m.name:"All";
}
function toggleMobileFilter(){
  mobileFilterOpen = !mobileFilterOpen;
  renderCatBar();
  if(curTab==="imported") renderImported();
}
```
(`PLATS` is defined later in the file, ~line 2213, but `mobileFilterLabel`
only reads it when actually called at runtime — by then the whole script
has executed once, so the forward reference is safe, same as other
already-existing forward references in this file, e.g. `renderCatBar`
calling `catSidebarOn` which is defined later too.)

- [ ] **Step 2: Add the collapse behavior to `renderCatBar()`**

In both files, replace:
```js
function renderCatBar(){
  const pills = [{key:"",name:"All",chip:"var(--ink)"}].concat(CATS);
  const catSideActive = curTab==="saved" && catSidebarOn();
  const catHtml = curTab==="imported"
    ? PLATS.map(([k,label])=>
      `<button class="catpill${impSrc===k?" on":""}" style="${impSrc===k?"background:var(--ink)":""}"
        onclick="setImpSrc('${k}')">${k?PICONS[k]||"":""}${label}</button>`).join("")
    : catSideActive ? ""
    : curTab==="stumble"
      // Stumble shows categories in a left sidebar on wide screens (stCatSideHTML); only
      // fall back to top-bar .tg pills when that sidebar is hidden (narrow screens).
      ? (stSidebarOn() ? "" : pills.map(c=>
        `<span class="tg${filterCat===c.key?" on":""}" onclick="setFilter('${c.key}')">${esc(c.name)}</span>`).join(""))
      : pills.map(c=>
    `<button class="catpill${filterCat===c.key?" on":""}" style="${filterCat===c.key?`background:${c.chip}`:""}"
      onclick="setFilter('${c.key}')">${c.name}</button>`).join("");
  document.getElementById("catBar").innerHTML = catHtml
    + `<span style="flex:1"></span>`
    + VIEWS.map(([v,label])=>
    `<button class="catpill${viewMode===v?" on":""}" style="${viewMode===v?"background:var(--ink)":""}" title="View"
      onclick="setView('${v}')">${label}</button>`).join("");
  requestAnimationFrame(setStickyOffsets);
}
```
with:
```js
function renderCatBar(){
  const pills = [{key:"",name:"All",chip:"var(--ink)"}].concat(CATS);
  const catSideActive = curTab==="saved" && catSidebarOn();
  const catHtml = curTab==="imported"
    ? PLATS.map(([k,label])=>
      `<button class="catpill${impSrc===k?" on":""}" style="${impSrc===k?"background:var(--ink)":""}"
        onclick="setImpSrc('${k}')">${k?PICONS[k]||"":""}${label}</button>`).join("")
    : catSideActive ? ""
    : curTab==="stumble"
      // Stumble shows categories in a left sidebar on wide screens (stCatSideHTML); only
      // fall back to top-bar .tg pills when that sidebar is hidden (narrow screens).
      ? (stSidebarOn() ? "" : pills.map(c=>
        `<span class="tg${filterCat===c.key?" on":""}" onclick="setFilter('${c.key}')">${esc(c.name)}</span>`).join(""))
      : pills.map(c=>
    `<button class="catpill${filterCat===c.key?" on":""}" style="${filterCat===c.key?`background:${c.chip}`:""}"
      onclick="setFilter('${c.key}')">${c.name}</button>`).join("");
  // Mobile (<760px): collapse whatever pill row the branches above produced
  // behind a single toggle chip, so a large category/tag list can't push
  // cards off-screen. Wide screens (>=760px) are unaffected.
  const toggleChip = `<button class="catpill on" style="background:var(--ink)" onclick="toggleMobileFilter()">Filter: ${esc(mobileFilterLabel())} ${mobileFilterOpen?"&#9652;":"&#9662;"}</button>`;
  const mobileCatHtml = !mobileNarrow() ? catHtml
    : !catHtml ? ""
    : !mobileFilterOpen ? toggleChip
    : toggleChip + catHtml;
  document.getElementById("catBar").innerHTML = mobileCatHtml
    + `<span style="flex:1"></span>`
    + VIEWS.map(([v,label])=>
    `<button class="catpill${viewMode===v?" on":""}" style="${viewMode===v?"background:var(--ink)":""}" title="View"
      onclick="setView('${v}')">${label}</button>`).join("");
  requestAnimationFrame(setStickyOffsets);
}
```
(The grid/list view-switcher buttons on the right stay always visible even
when collapsed — 5 compact icon buttons don't cause the wrapping problem
this design targets, and hiding the view switcher isn't part of "the filter
bar." If this reads wrong once you see it live, say so before Task 3.)

- [ ] **Step 3: Auto-collapse on pick in `setFilter()`**

In both files, replace:
```js
function setFilter(k){
  filterCat = k;
  save("fcat", k);
  renderCatBar();
  if(curTab==="saved") renderSaved(); else if(curTab==="stumble") renderStumble();
}
```
with:
```js
function setFilter(k){
  filterCat = k;
  save("fcat", k);
  mobileFilterOpen = false;
  renderCatBar();
  if(curTab==="saved") renderSaved(); else if(curTab==="stumble") renderStumble();
}
```

- [ ] **Step 4: Verify file parity, syntax gate, manual check**

Run the same `diff` command from Task 1 Step 5, then:
```bash
node tests/syntax-check.js
```
Expected: `0 error(s)`, same as Task 1.

Manual (same dev server + narrow viewport as Task 1):
- Stumble tab: category row is collapsed to one "Filter: All ▾" chip on
  load. Tap it → full category pill row appears, chip now reads "Filter:
  All ▴" and sits first in the row. Tap any category pill → list filters,
  row collapses back to the single chip showing the picked category's name.
- Saved tab: same behavior.
- Widen past 760px: pill row (or sidebar, depending on the `S.catSidebar`
  setting) looks exactly like it did before this task — no toggle chip
  visible.

- [ ] **Step 5: Commit**

```bash
git add pwa/index.html web/index.html
git commit -m "feat(pwa): collapsible mobile filter toggle for Stumble and Saved"
```

---

### Task 3: Extend the toggle to Imported (source pills + entire toolbar)

Confirmed with the user: on Imported, the toggle hides the *entire* sticky
block — search box, sort, Unreviewed/Failed/Couldn't-capture filters, Get
pictures & info, Library health, tag menu, Select mode, and the tag pill
row — not just the filter-ish parts. `#catBar`'s source-pill row already
collapses via Task 2's generic `renderCatBar()` change (Imported is one of
its branches); this task only needs to gate `.imp-sticky` itself in
`renderImported()`.

**Files:**
- Modify: `pwa/index.html` (`renderImported()`, ~lines 2261-2332;
  `setImpSrc()`, ~line 2214)
- Modify: `web/index.html` (same content, matched by function name)

**Interfaces:**
- Consumes: `mobileNarrow()`, `mobileFilterOpen` (from Task 2).
- Produces: nothing new consumed elsewhere.

- [ ] **Step 1: Gate the sticky toolbar block in `renderImported()`**

In both files, find `renderImported()` and replace the `v.innerHTML =
\`...\`` assignment — everything from `v.innerHTML = \`` down to the
closing `` `; `` right before `attachCardImages();` — with a version that
computes the sticky block separately and conditionally includes it. The
current code is:

```js
  v.innerHTML = `
    <div class="imp-sticky">
    <div class="imp-head">
      <input type="text" placeholder="Search ${imported.length} imported items…" value="${esc(impQuery)}"
        oninput="impQuery=this.value.toLowerCase();renderImportedKeepFocus()">
      <span class="hint" title="Tip: hover a card and press Ctrl+V to paste a screenshot (e.g. from FireShot) as its image">${list.length} shown</span>
      <button class="btn btn-ghost" onclick="toggleImpSort()" title="Sort order">${impSort==="newest"?"&#9660; Newest":"&#9650; Oldest"}</button>
      <button class="btn btn-ghost${impUnreviewed?" btn-primary":""}" onclick="toggleUnreviewed()">${impUnreviewed?"&#10003; ":""}Unreviewed</button>
      ${(function(){ const n=imported.filter(fbMiss).length; return (n||impFbMiss)?`<button class="btn btn-ghost${impFbMiss?" btn-primary":""}" onclick="toggleFbMiss()" title="Facebook cards that couldn't get a picture automatically (restricted/login-gated). Open each and use the extension's Save to grab it.">${impFbMiss?"&#10003; ":"&#128683; "}Couldn't capture${n?" ("+n+")":""}</button>`:""; })()}
      ${(function(){
        // ONE "Get pictures & info" button replaces the six capture/enrich entry points
        // (Enrich / Capture missing / Capture Facebook / Auto-capture all / Auto-capture
        // in tabs / Select→Fetch info) — review D1. While a batch runs it becomes the Stop
        // button (existing batch Stop semantics; fbAuto stops the auto-loop too).
        if(batchUI.active) return `<button class="btn btn-primary" id="batchBtn" onclick="${fbAuto?'stopFbAuto()':'cancelBatchCapture()'}">&#9632; ${fbAuto?'Stop auto-capture':'Stop capture'} (${batchUI.done}/${batchUI.total})</button>`;
        const n = _getpicTotal();
        return `<button class="btn btn-ghost" id="getpicBtn" onclick="openGetPics()" title="Get preview pictures and info for your imported cards — never-tried links, Facebook posts, failed retries, and missing AI descriptions, all in one place.">&#128247; Get pictures &amp; info${n?" ("+n+")":""}</button>`;
      })()}
      ${impFailed?`<button class="btn btn-ghost btn-primary" onclick="clearFailedFilter()" title="Showing only failed captures — click to show all cards again">&#10003; Failed only &#10005;</button>`:""}
      <button class="btn btn-ghost" onclick="openHealth()" title="Review & tidy your library: duplicates, dead &amp; unsafe links, failed captures, and link-less cards — all in one place.">&#129658; Library health</button>
      ${(function(){const n=imported.filter(i=>!i.tags).length+saved.filter(i=>!i.tags).length;
        return n?`<div class="tag-drop"><button class="btn btn-ghost" id="tagBtn" onclick="toggleTagMenu()">&#127991; Tag ${n} untagged &#9662;</button>
          <div class="tag-menu" id="tagMenu">
            <button onclick="closeTagMenu();autoTag(120)">Tag next 120</button>
            <button onclick="closeTagMenu();autoTag(0)">Tag all ${n}</button>
          </div></div>`:"";})()}
      ${selMode
        ? `<button class="btn btn-primary" id="capSelBtn" onclick="captureSelected()" ${selPicks.size?"":"disabled"} title="Recapture the selected cards via the extension worker — every platform (Instagram, Facebook, bookmarks, YouTube, Pinterest). Each page opens briefly, is captured, and closes; the real screenshot overwrites the old image. Keep Chrome open and stay logged in.">&#128260; Recapture (${selPicks.size})</button>
           <button class="btn btn-ghost" id="fetchBtn" onclick="fetchSelectedInfo()" ${selPicks.size?"":"disabled"} title="Fetch an og:image + AI description without the extension (best for non-Facebook links)">&#11015; Fetch info (${selPicks.size})</button>
           <button class="btn btn-ghost" id="openSelBtn" onclick="openSelected()" ${selPicks.size?"":"disabled"} title="Open each selected card's link in its own browser tab. Your browser may ask to allow pop-ups the first time — allow them for this site.">&#128279; Open (${selPicks.size})</button>
           <button class="btn btn-ghost" onclick="selectShown()">Select all shown</button>
           <button class="btn btn-ghost" onclick="toggleSelMode()">Done</button>`
        : `<button class="btn btn-ghost" onclick="toggleSelMode()">&#9745; Select</button>`}
    </div>
    ${impSidebarOn()?"":tagBarHTML()}
    ${impBatchIds ? (function(){
      const wp=list.filter(r=>!isBadImg(r.it.img)).length;
      const pill="cursor:pointer;background:rgba(255,255,255,.22);padding:4px 10px;border-radius:7px;white-space:nowrap";
      let right;
      if(fbAuto && _fbAutoNextAt>Date.now()){
        const left=imported.filter(needsFbCapture).length;
        right=`<span>Auto ON · next batch in <b id="fbAutoCd">${Math.max(0,Math.round((_fbAutoNextAt-Date.now())/1000))}s</b> · ${left} left</span>
          <span onclick="runFbNow()" style="${pill}">Run now</span><span onclick="stopFbAuto()" style="${pill}">&#9632; Stop auto</span>`;
      } else if(fbAuto){
        const left=imported.filter(needsFbCapture).length;
        right=`<span>Auto ON · ${left} left</span><span onclick="stopFbAuto()" style="${pill}">&#9632; Stop auto</span>`;
      } else {
        right=`<span onclick="clearBatchFilter()" title="Back to all Facebook imports" style="${pill}">&#10005; Show all Facebook</span>`;
      }
      return `<div style="margin:8px 0;padding:9px 13px;background:var(--accent);color:#fff;border-radius:9px;display:flex;align-items:center;gap:10px;font-weight:600;font-size:13.5px;flex-wrap:wrap">
        <span>&#128247; Capture batch — <b>${wp}/${list.length}</b> in this batch${_fbSessCaptured?` · <b>${_fbSessCaptured}</b> captured this run`:""}. Pictures fill in here as captures land.</span>
        <span style="margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap">${right}</span>
      </div>`;
    })() : ""}
    </div>
    ${impSidebarOn()
      ? `<div class="imp-body">${tagSideHTML()}<div class="imp-grid ig-${viewMode}">${list.map(r=>impCardHTML(r.it,r.idx)).join("")}</div></div>`
      : `<div class="imp-grid ig-${viewMode}">${list.map(r=>impCardHTML(r.it,r.idx)).join("")}</div>`}`;
  attachCardImages();
  requestAnimationFrame(setStickyOffsets);
```

Replace it with (only the first two lines and the very end differ — the
sticky block's own inner content is moved as-is into a template literal
assigned to `stickyBlock`, gated by the same `mobileNarrow()`/
`mobileFilterOpen` check Task 2 introduced):

```js
  const stickyBlock = (mobileNarrow() && !mobileFilterOpen) ? "" : `
    <div class="imp-sticky">
    <div class="imp-head">
      <input type="text" placeholder="Search ${imported.length} imported items…" value="${esc(impQuery)}"
        oninput="impQuery=this.value.toLowerCase();renderImportedKeepFocus()">
      <span class="hint" title="Tip: hover a card and press Ctrl+V to paste a screenshot (e.g. from FireShot) as its image">${list.length} shown</span>
      <button class="btn btn-ghost" onclick="toggleImpSort()" title="Sort order">${impSort==="newest"?"&#9660; Newest":"&#9650; Oldest"}</button>
      <button class="btn btn-ghost${impUnreviewed?" btn-primary":""}" onclick="toggleUnreviewed()">${impUnreviewed?"&#10003; ":""}Unreviewed</button>
      ${(function(){ const n=imported.filter(fbMiss).length; return (n||impFbMiss)?`<button class="btn btn-ghost${impFbMiss?" btn-primary":""}" onclick="toggleFbMiss()" title="Facebook cards that couldn't get a picture automatically (restricted/login-gated). Open each and use the extension's Save to grab it.">${impFbMiss?"&#10003; ":"&#128683; "}Couldn't capture${n?" ("+n+")":""}</button>`:""; })()}
      ${(function(){
        // ONE "Get pictures & info" button replaces the six capture/enrich entry points
        // (Enrich / Capture missing / Capture Facebook / Auto-capture all / Auto-capture
        // in tabs / Select→Fetch info) — review D1. While a batch runs it becomes the Stop
        // button (existing batch Stop semantics; fbAuto stops the auto-loop too).
        if(batchUI.active) return `<button class="btn btn-primary" id="batchBtn" onclick="${fbAuto?'stopFbAuto()':'cancelBatchCapture()'}">&#9632; ${fbAuto?'Stop auto-capture':'Stop capture'} (${batchUI.done}/${batchUI.total})</button>`;
        const n = _getpicTotal();
        return `<button class="btn btn-ghost" id="getpicBtn" onclick="openGetPics()" title="Get preview pictures and info for your imported cards — never-tried links, Facebook posts, failed retries, and missing AI descriptions, all in one place.">&#128247; Get pictures &amp; info${n?" ("+n+")":""}</button>`;
      })()}
      ${impFailed?`<button class="btn btn-ghost btn-primary" onclick="clearFailedFilter()" title="Showing only failed captures — click to show all cards again">&#10003; Failed only &#10005;</button>`:""}
      <button class="btn btn-ghost" onclick="openHealth()" title="Review & tidy your library: duplicates, dead &amp; unsafe links, failed captures, and link-less cards — all in one place.">&#129658; Library health</button>
      ${(function(){const n=imported.filter(i=>!i.tags).length+saved.filter(i=>!i.tags).length;
        return n?`<div class="tag-drop"><button class="btn btn-ghost" id="tagBtn" onclick="toggleTagMenu()">&#127991; Tag ${n} untagged &#9662;</button>
          <div class="tag-menu" id="tagMenu">
            <button onclick="closeTagMenu();autoTag(120)">Tag next 120</button>
            <button onclick="closeTagMenu();autoTag(0)">Tag all ${n}</button>
          </div></div>`:"";})()}
      ${selMode
        ? `<button class="btn btn-primary" id="capSelBtn" onclick="captureSelected()" ${selPicks.size?"":"disabled"} title="Recapture the selected cards via the extension worker — every platform (Instagram, Facebook, bookmarks, YouTube, Pinterest). Each page opens briefly, is captured, and closes; the real screenshot overwrites the old image. Keep Chrome open and stay logged in.">&#128260; Recapture (${selPicks.size})</button>
           <button class="btn btn-ghost" id="fetchBtn" onclick="fetchSelectedInfo()" ${selPicks.size?"":"disabled"} title="Fetch an og:image + AI description without the extension (best for non-Facebook links)">&#11015; Fetch info (${selPicks.size})</button>
           <button class="btn btn-ghost" id="openSelBtn" onclick="openSelected()" ${selPicks.size?"":"disabled"} title="Open each selected card's link in its own browser tab. Your browser may ask to allow pop-ups the first time — allow them for this site.">&#128279; Open (${selPicks.size})</button>
           <button class="btn btn-ghost" onclick="selectShown()">Select all shown</button>
           <button class="btn btn-ghost" onclick="toggleSelMode()">Done</button>`
        : `<button class="btn btn-ghost" onclick="toggleSelMode()">&#9745; Select</button>`}
    </div>
    ${impSidebarOn()?"":tagBarHTML()}
    ${impBatchIds ? (function(){
      const wp=list.filter(r=>!isBadImg(r.it.img)).length;
      const pill="cursor:pointer;background:rgba(255,255,255,.22);padding:4px 10px;border-radius:7px;white-space:nowrap";
      let right;
      if(fbAuto && _fbAutoNextAt>Date.now()){
        const left=imported.filter(needsFbCapture).length;
        right=`<span>Auto ON · next batch in <b id="fbAutoCd">${Math.max(0,Math.round((_fbAutoNextAt-Date.now())/1000))}s</b> · ${left} left</span>
          <span onclick="runFbNow()" style="${pill}">Run now</span><span onclick="stopFbAuto()" style="${pill}">&#9632; Stop auto</span>`;
      } else if(fbAuto){
        const left=imported.filter(needsFbCapture).length;
        right=`<span>Auto ON · ${left} left</span><span onclick="stopFbAuto()" style="${pill}">&#9632; Stop auto</span>`;
      } else {
        right=`<span onclick="clearBatchFilter()" title="Back to all Facebook imports" style="${pill}">&#10005; Show all Facebook</span>`;
      }
      return `<div style="margin:8px 0;padding:9px 13px;background:var(--accent);color:#fff;border-radius:9px;display:flex;align-items:center;gap:10px;font-weight:600;font-size:13.5px;flex-wrap:wrap">
        <span>&#128247; Capture batch — <b>${wp}/${list.length}</b> in this batch${_fbSessCaptured?` · <b>${_fbSessCaptured}</b> captured this run`:""}. Pictures fill in here as captures land.</span>
        <span style="margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap">${right}</span>
      </div>`;
    })() : ""}
    </div>`;
  v.innerHTML = stickyBlock + (impSidebarOn()
      ? `<div class="imp-body">${tagSideHTML()}<div class="imp-grid ig-${viewMode}">${list.map(r=>impCardHTML(r.it,r.idx)).join("")}</div></div>`
      : `<div class="imp-grid ig-${viewMode}">${list.map(r=>impCardHTML(r.it,r.idx)).join("")}</div>`);
  attachCardImages();
  requestAnimationFrame(setStickyOffsets);
```

- [ ] **Step 2: Auto-collapse on pick in `setImpSrc()`**

In both files, replace:
```js
function setImpSrc(k){ impSrc=k; save("isrc",k); renderCatBar(); renderImported(); }
```
with:
```js
function setImpSrc(k){ impSrc=k; save("isrc",k); mobileFilterOpen=false; renderCatBar(); renderImported(); }
```

- [ ] **Step 3: Verify file parity, syntax gate, manual check**

Run the Task 1 Step 5 `diff` command, then `node tests/syntax-check.js` —
expect the same clean results as before.

Manual (same dev server + narrow viewport):
- Imported tab: on load, `#catBar` shows the single "Filter: All sources ▾"
  chip, and the entire search/actions/tags toolbar is gone — cards start
  right below it.
- Tap the chip → source pills appear in `#catBar`, and the full toolbar
  (search, sort, Unreviewed, Get pictures & info, Library health, tag menu,
  Select, tag pills) reappears above the cards.
- Pick a source pill → list filters to that source, toolbar collapses back
  to the single chip automatically.
- Tap the chip again without picking anything → toolbar collapses back too
  (manual close, not just auto-collapse-on-pick).
- Widen past 760px → toolbar and source pills render exactly as before this
  change (no chip, no collapse behavior) — this is the existing
  `impSidebarOn()`/wide-screen path, untouched.

- [ ] **Step 4: Commit**

```bash
git add pwa/index.html web/index.html
git commit -m "feat(pwa): collapse the Imported toolbar behind the mobile filter toggle"
```

---

### Task 4: Bump the PWA shell cache and do a full regression pass

**Files:**
- Modify: `pwa/sw.js:21`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed elsewhere — this is the last task.

- [ ] **Step 1: Bump `SHELL_CACHE`**

In `pwa/sw.js`, replace:
```js
const SHELL_CACHE = "interests-pwa-shell-v5"; // bump on ANY edit to an already-cached
```
with:
```js
const SHELL_CACHE = "interests-pwa-shell-v6"; // bump on ANY edit to an already-cached
```

- [ ] **Step 2: Full regression pass**

```bash
node tests/run.js
```
Expected: every test prints "passed", 0 failures, process exits 0.

Manual, at both a narrow (≤760px) and wide (>760px) viewport, dev server
from `pwa/`:
- Every tab (Stumble, Saved, Imported, Settings) loads without console
  errors at both widths.
- Narrow: bottom bar navigates correctly; filter toggle collapses/expands
  and auto-collapses on pick, on all three tabs that have one
  (Stumble/Saved/Imported); Settings has no `#catBar` content (unchanged
  from before this plan — `showTab()` already hides `#catBar` entirely on
  Settings).
- Wide: no bottom bar, no filter toggle chip anywhere — layout matches a
  pre-change screenshot/your memory of today's desktop layout.
- If you have a real iPhone available: reinstall/reload the PWA (or trigger
  its update flow) and confirm the new layout actually shows up there, not
  just in desktop DevTools emulation.

- [ ] **Step 3: Commit**

```bash
git add pwa/sw.js
git commit -m "chore(pwa): bump SHELL_CACHE for the mobile nav/filter layout change"
```
