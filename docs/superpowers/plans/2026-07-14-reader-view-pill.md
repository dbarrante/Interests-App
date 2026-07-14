# Reader View Pill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-shot "📖 Reader" pill to Imported's view-mode selector
that opens the single-card reader at the first item in the current
filtered/sorted view.

**Architecture:** `openReader(idx)` gains an optional `idx` — when omitted,
it still builds the same snapshot it always does, just starts at position
0 instead of looking up a clicked item. The pill calls `openReader()` with
no argument. Nothing about persisted `viewMode`/`gridClass()` changes.

**Tech Stack:** Vanilla JS/HTML — same single-file `index.html` convention.

## Global Constraints

- Every edit applies identically to both `web/index.html` and
  `pwa/index.html` (byte-identical outside `<script src=...>` tags).
- Imported tab only — the pill must not render on Saved.
- The pill must NEVER become a persisted `viewMode` value — `gridClass()`
  turns `viewMode` directly into a CSS class on every app boot, and no
  `.m-reader` (or similar) rule exists.
- Spec: `docs/superpowers/specs/2026-07-14-reader-view-pill-design.md`

---

### Task 1: Optional-idx `openReader()` + the pill

**Files:**
- Modify: `web/index.html` (`openReader(idx)`, ~line 3433;
  `renderCatBar()`'s view-pills line, ~line 1035-1037)
- Modify: `pwa/index.html` (identical edits)
- Modify: `pwa/sw.js` (`SHELL_CACHE` bump, since this touches
  `pwa/index.html`)

**Interfaces:**
- Consumes: `readerSnapshot`/`readerPos`/`renderReader`/`impFilterPredicate`/
  `imported`/`saved`/`impSort`/`newId`/`Store.putCards`/`toast` (all
  pre-existing).
- Produces: nothing new consumed elsewhere — this is the last task.

- [ ] **Step 1: Make `idx` optional in `openReader()`, add the
  empty-snapshot guard**

In both files, replace:
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
  document.body.classList.add("reader-locked");   // no page-scroll behind the fixed reader
  renderReader();
}
```
with:
```js
// idx omitted (the view-mode pill's call) -> start at the first item in
// the current filtered/sorted view instead of a specific clicked card.
function openReader(idx){
  const it = (idx!=null) ? imported[idx] : null;
  if(idx!=null && !it) return;
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
  if(!readerSnapshot.length){ toast("Nothing to show in the reader — check your filters"); return; }
  readerPos = it ? readerSnapshot.indexOf(it.id) : 0;
  if(readerPos<0) readerPos = 0;
  document.getElementById("readerModal").classList.add("open");
  document.body.classList.add("reader-locked");   // no page-scroll behind the fixed reader
  renderReader();
}
```
(`it ? readerSnapshot.indexOf(it.id) : 0` — when `idx` was provided, keep
positioning at that specific card; when omitted, `it` is `null`, so this
short-circuits straight to `0`, the first item.)

- [ ] **Step 2: Add the pill, gated to the Imported tab**

In both files, replace:
```js
  document.getElementById("catBar").innerHTML = mobileCatHtml
    + `<span style="flex:1"></span>`
    + VIEWS.map(([v,label])=>
    `<button class="catpill${viewMode===v?" on":""}" style="${viewMode===v?"background:var(--ink)":""}" title="View"
      onclick="setView('${v}')">${label}</button>`).join("");
```
with:
```js
  document.getElementById("catBar").innerHTML = mobileCatHtml
    + `<span style="flex:1"></span>`
    + VIEWS.map(([v,label])=>
    `<button class="catpill${viewMode===v?" on":""}" style="${viewMode===v?"background:var(--ink)":""}" title="View"
      onclick="setView('${v}')">${label}</button>`).join("")
    + (curTab==="imported" ? `<button class="catpill" title="Open reader view" onclick="openReader()">&#128214; Reader</button>` : "");
```
(No `.on`/active-state class on this button, unlike the `VIEWS` pills — it's
a one-shot trigger, not a persistent selectable mode, per the spec.)

- [ ] **Step 3: Bump `pwa/sw.js`'s `SHELL_CACHE`**

Read the current value first (it changes as other work lands — check
`pwa/sw.js` for the line `const SHELL_CACHE = "interests-pwa-shell-vN";`)
and bump `N` by exactly 1 from whatever the current live value is. Do not
assume a specific number — confirm it by reading the file immediately
before editing it.

- [ ] **Step 4: Verify file parity and syntax**

```bash
diff <(sed 's/<script[^>]*><\/script>//g; s/<script[^>]*>//g' web/index.html) <(sed 's/<script[^>]*><\/script>//g; s/<script[^>]*>//g' pwa/index.html)
node tests/syntax-check.js
```
Expected: diff shows only the pre-existing PWA-only comment block;
syntax-check reports 0 errors.

- [ ] **Step 5: Manual verification**

```bash
cd pwa && python -m http.server 8080
```
With several Imported cards (at least 3): confirm the "📖 Reader" pill
appears in the view-selector row on Imported, and does NOT appear on
Saved. Tap the pill: confirm the reader opens showing the FIRST card in
the current grid order (not necessarily `imported[0]` — the first one as
currently sorted/filtered). Apply a search or tag filter that still
matches at least one card, tap the pill again: confirm it opens at the
first card of THAT filtered view. Apply a filter that matches ZERO cards,
tap the pill: confirm a toast appears ("Nothing to show in the reader —
check your filters") and the reader does NOT open (no flash-open). Confirm
the existing per-card 📖 icon still opens the reader at that specific card
(unchanged `idx`-provided behavior). Confirm using the pill doesn't change
the grid's view mode — check which of 1×1/2×2/4×4/Detail/List was active
before, close the reader, confirm the grid still shows in that same mode.
Reload the page after using the pill at least once: confirm the grid
renders normally (proving `viewMode`/`gridClass()` were never touched by
this feature).

- [ ] **Step 6: Full regression pass**

```bash
node tests/run.js
```
Expected: `ALL TEST FILES PASSED`. No automated coverage of this feature
itself (matching this project's convention) — this run only confirms
nothing else broke.

- [ ] **Step 7: Commit**

```bash
cd "D:\Dropbox\Documents\Claude\Projects\Interests App"
git add web/index.html pwa/index.html pwa/sw.js
git commit -m "feat(web,pwa): add a one-shot reader-view pill to Imported's view selector"
```
