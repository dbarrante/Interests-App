# Failures Modal — Recapture/Remove with Live Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the failures modal, clicking a title clears the card's image (backup-first) and opens the page so the user can recapture it via the extension's Clip button or delete it via the extension's Remove button; the modal then shows each card's live outcome — Recapturing… → ✅ Success, or 🗑 REMOVED.

**Architecture:** Renderer-only (`web/index.html`). The recapture-into-card matching, remove-by-URL, the extension Clip/Remove buttons, and the 3-second `drainCaptures()` ingest loop already exist. This plan adds (1) a live per-row status derived from actual card state, refreshed in place while the modal is open, and (2) the click-time image clear + last-opened + "recapturing" marker on `openFailOne`.

**Tech Stack:** Vanilla JS in a single HTML file; plain-`node` text-assert wiring tests.

## Global Constraints

- Renderer-only: NO extension change, NO Core change. The existing extension popup (Clip/Remove) and `drainCaptures()` matching do the recapture/removal.
- Data safety: the click-time image clear must be backup-first (`snapshotBeforeDestructive()` then `Store.imgDel`), clear ONLY the image (never the card or other fields), and persist via `Store.putCards`.
- `success`/`removed` statuses must be DERIVED from real state at refresh time (image present / card absent from `imported`) — not trusted from a flag — so they can't show a false Success. `recapturing` is the only stored/transient marker.
- The live refresh must update rows IN PLACE (by row id), preserving the user's checkbox selection and scroll position — never rebuild the whole list on a tick.
- Resolved rows (success/removed) disable their title-open click and select checkbox.
- Keep `node tests/run.js` green; commit after each task.

---

### Task 1: Live status display in the failures modal

**Files:**
- Modify: `web/index.html` — add `_failStatus` state (~line 2350 near `let _failModalList`), status helpers + `refreshFailStatuses`/`refreshFailRow` (near the other fail-modal functions ~line 2402), `failRowHTML` (~line 2361), reset in `openFailReview` (~line 2351), and one call at the end of `drainCaptures` (~line 4177) plus a visibility hook.
- Test: `tests/capture-wiring.test.js` (extend)

**Interfaces:**
- Produces: `_failStatus` (object `{ [cardId]: "recapturing" }`); `_failRowStatus(id) -> "" | "recapturing" | "success" | "removed"`; `_failStatusHTML(st) -> string`; `refreshFailRow(id)`; `refreshFailStatuses()`. Task 2 sets `_failStatus[id]="recapturing"` and calls `refreshFailRow(id)`.

- [ ] **Step 1: Write the failing test** — append to `tests/capture-wiring.test.js`:

```js
t("fail modal renders live Success/REMOVED/Recapturing status, refreshed by drainCaptures", () => {
  assert.ok(html.indexOf("function _failRowStatus(") >= 0, "_failRowStatus defined");
  const i = html.indexOf("function _failRowStatus(");
  const b = html.slice(i, i + 400);
  assert.ok(b.indexOf('"removed"') >= 0, "card missing from imported → removed");
  assert.ok(b.indexOf("isBadImg") >= 0 && b.indexOf('"success"') >= 0, "good image → success");
  assert.ok(html.indexOf("function refreshFailStatuses(") >= 0, "refreshFailStatuses defined");
  const di = html.indexOf("async function drainCaptures(");
  const dbody = html.slice(di, di + 8000);
  assert.ok(dbody.indexOf("refreshFailStatuses(") >= 0, "drainCaptures refreshes fail statuses");
  const fi = html.indexOf("function failRowHTML(");
  const fbody = html.slice(fi, fi + 900);
  assert.ok(fbody.indexOf("data-card=") >= 0 && fbody.indexOf('class="fst"') >= 0, "row has data-card + status slot");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/capture-wiring.test.js`
Expected: FAIL — `_failRowStatus defined`.

- [ ] **Step 3a: Add the `_failStatus` state.** Find the line declaring the modal list (~2350):

```js
let _failModalList = [];
```

Add immediately after it:

```js
let _failStatus = {};   // {cardId: "recapturing"} — transient hint set on title-click; success/removed are derived
```

- [ ] **Step 3b: Reset the status map when the modal opens.** In `openFailReview`, find:

```js
  _failModalList = imported.filter(needsRetry);
```

Add immediately after it:

```js
  _failStatus = {};
```

- [ ] **Step 3c: Add the status helpers.** Immediately AFTER the `openFailSelected` function (ends ~line 2407, before `function retryFailFresh(){`), insert:

```js
// Derive a failed card's current status from REAL state (not a trusted flag): gone from the library →
// removed; has a good image again → success; otherwise the transient "recapturing" hint (or none).
function _failRowStatus(id){
  const cur = imported.find(x=>x&&x.id===id);
  if(!cur) return "removed";
  if(!isBadImg(cur.img||"")) return "success";
  return _failStatus[id] || "";
}
function _failStatusHTML(st){
  if(st==="success") return '<span style="color:#22c55e">&#10003; Success</span>';
  if(st==="removed") return '<span style="color:#9a958d">&#128465; Removed</span>';
  if(st==="recapturing") return '<span style="color:#c2410c">Recapturing&hellip;</span>';
  return "";
}
// Update ONE row's badge + interactivity in place (preserves selection + scroll). No full re-render.
function refreshFailRow(id){
  const row = document.querySelector('#failBody .dupe-row[data-card="'+id+'"]'); if(!row) return;
  const st = _failRowStatus(id);
  const resolved = (st==="success" || st==="removed");
  const badge = row.querySelector(".fst"); if(badge) badge.innerHTML = _failStatusHTML(st);
  const titleEl = row.querySelector(".meta .t");
  if(titleEl){ titleEl.style.pointerEvents = resolved ? "none" : ""; titleEl.style.opacity = resolved ? ".55" : ""; }
  const cb = row.querySelector('input[data-id]');
  if(cb){ cb.disabled = resolved; if(resolved) cb.checked = false; }
  row.style.textDecoration = (st==="removed") ? "line-through" : "";
}
// Refresh every row's status while the modal is open (called from the 3s drain loop + on focus return).
function refreshFailStatuses(){
  const modal = document.getElementById("failModal");
  if(!modal || !modal.classList.contains("open")) return;
  _failModalList.forEach(c=>{ if(c && c.id) refreshFailRow(c.id); });
}
```

- [ ] **Step 3d: Render the status slot + `data-card` in `failRowHTML`.** Replace the entire `failRowHTML` function with:

```js
function failRowHTML(c){
  const dom=domain(c.url)||""; const reason=c.capReason||"unreachable";
  const st=_failRowStatus(c.id); const resolved=(st==="success"||st==="removed");
  return `<div class="dupe-row" data-reason="${esc(reason)}" data-card="${esc(c.id)}"${st==="removed"?' style="text-decoration:line-through"':''}>
    ${dupeThumb({scope:"imported", card:c})}
    <div class="meta"><div class="t" title="Open in browser" style="${resolved?'pointer-events:none;opacity:.55':''}"${resolved?'':` onclick="openFailOne('${esc(c.id)}')"`}>${esc(c.title||dom||"(untitled)")}</div>
      <div class="s">${esc(dom)} · <span style="color:#e0556b">${esc(_failLabel(reason))}</span> <span class="fst">${_failStatusHTML(st)}</span></div></div>
    <label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" data-id="${esc(c.id)}"${resolved?' disabled':''} style="width:auto"> select</label>
  </div>`;
}
```

- [ ] **Step 3e: Refresh from the drain loop + on focus return.** In `drainCaptures`, find its final lines (~4177):

```js
    } else {
      toast(assignedTitle ? ("Screenshot saved to: "+assignedTitle) : "Updated cards from extension capture");
    }
  }
}
```

Insert `refreshFailStatuses();` just before the function's closing brace so it runs every tick:

```js
    } else {
      toast(assignedTitle ? ("Screenshot saved to: "+assignedTitle) : "Updated cards from extension capture");
    }
  }
  refreshFailStatuses();
}
```

Then find the `setInterval(drainCaptures, 3000);` line (~4326) and add a focus/visibility hook immediately after it so returning from the browser refreshes promptly:

```js
setInterval(drainCaptures, 3000);
document.addEventListener("visibilitychange", ()=>{ if(!document.hidden){ drainCaptures(); } });   // returning from the browser: ingest + refresh now
```

- [ ] **Step 4: Run tests + gate**

Run: `node tests/capture-wiring.test.js`, then `node tests/syntax-check.js`, then `node tests/run.js`.
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/capture-wiring.test.js
git commit -m "feat(ui): live Success/REMOVED/Recapturing status in the failures modal"
```

---

### Task 2: Click-to-recapture action on `openFailOne`

**Files:**
- Modify: `web/index.html` — `openFailOne` (~line 2402)
- Test: `tests/capture-wiring.test.js` (extend)

**Interfaces:**
- Consumes (from Task 1): `_failStatus`, `refreshFailRow(id)`. Also existing globals: `snapshotBeforeDestructive()`, `Store.imgDel`, `Store.putCards`, `Store.kvSet`, `openUrlsInTabs`, `imported`, `_failModalList`.

- [ ] **Step 1: Write the failing test** — append to `tests/capture-wiring.test.js`:

```js
t("openFailOne clears image backup-first, sets last-opened + recapturing, then opens in browser", () => {
  const i = html.indexOf("function openFailOne(");
  const b = html.slice(i, i + 800);
  assert.ok(b.indexOf("snapshotBeforeDestructive(") >= 0, "backs up before clearing");
  assert.ok(b.indexOf("Store.imgDel(") >= 0, "clears the existing image");
  assert.ok(b.indexOf("ia_last_opened") >= 0, "records last-opened for extension Remove fallback");
  assert.ok(b.indexOf('"recapturing"') >= 0, "marks the card recapturing");
  assert.ok(b.indexOf("openUrlsInTabs(") >= 0, "still opens the link in the browser");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/capture-wiring.test.js`
Expected: FAIL — `backs up before clearing` (the current one-liner has none of these).

- [ ] **Step 3: Rewrite `openFailOne`.** Replace the current one-line function:

```js
function openFailOne(id){ const c=_failModalList.find(x=>x&&x.id===id); if(c&&c.url) openUrlsInTabs([c.url]); }   // single-click a title → open in browser
```

with:

```js
// Single-click a title: back up, clear this card's (bad) image so the recapture lands clean, mark it the
// last-opened card (so the extension's Remove targets it even without a URL match), flag it "recapturing",
// then open the page in the browser. The user then clicks the extension's Clip (recapture) or Remove;
// drainCaptures ingests the result and refreshFailStatuses flips the row to Success/REMOVED.
function openFailOne(id){
  const c=_failModalList.find(x=>x&&x.id===id); if(!c||!c.url) return;
  if(_failRowStatus(id)==="removed") return;   // already resolved — no-op
  snapshotBeforeDestructive();
  const cur=imported.find(x=>x&&x.id===id);
  if(cur){ const img=(typeof cur.img==="string")?cur.img:""; if(img.indexOf("idb:")===0){ try{ Store.imgDel(cur.id); }catch(e){} } cur.img=""; Store.putCards(imported); }
  try{ Store.kvSet("ia_last_opened", {id:c.id, ts:Date.now()}); }catch(e){}
  _failStatus[id]="recapturing";
  refreshFailRow(id);
  openUrlsInTabs([c.url]);
}
```

- [ ] **Step 4: Run tests + gate**

Run: `node tests/capture-wiring.test.js`, then `node tests/syntax-check.js`, then `node tests/run.js`.
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/capture-wiring.test.js
git commit -m "feat(ui): click a failed card → clear image + mark recapturing + open for extension recapture"
```

---

## Notes for the executor

- After both tasks pass, this is shippable. Because Task 2 adds a destructive (image-clear) path, run the **data-safety-reviewer** on the final branch (it's renderer-only, but it touches `Store.imgDel`/`putCards`); the **electron-security-reviewer** is not needed (no endpoint/IPC/extension change). Then bump `package.json` to 1.5.3 and rebuild the installer (`npm run dist`) — the app must be fully CLOSED first (it locks `dist\win-unpacked`).
