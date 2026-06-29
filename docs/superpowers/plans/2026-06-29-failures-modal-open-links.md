# Failures Modal — Open / Verify Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user verify "may be dead" links from the failed-capture triage modal by single-clicking a title (opens one link in the browser) or selecting several and pressing a new "Open" button (opens them in browser tabs).

**Architecture:** Renderer-only change in `web/index.html`. Extract the existing main-grid open-in-tabs logic from `openSelected()` into a reusable `openUrlsInTabs(urls, opts)` helper, then wire the failures modal (clickable titles + an "Open" button) to that helper. Everything opens in the real browser — the reuse-window setting is never consulted by this feature.

**Tech Stack:** Vanilla JS in a single HTML file; plain-`node` text-assert wiring tests.

## Global Constraints

- Renderer-only: no `core/` change, no Core endpoint, no data-store/backup/delete change. The data-safety and electron-security domain reviewers are NOT required for this feature.
- Security invariant (preserve): only ever hand `http(s)` URLs to `window.open` — never `javascript:`/`data:`/etc. This guard lives in `openUrlsInTabs`.
- `openSelected()`'s current behavior must be preserved exactly after the refactor (dedup, http-only filter, `_openedSel` per-Select-session dedup, 25-tab confirm, blocked/opened toasts).
- This feature opens in the browser only — never route through the reuse-window / `window.ia.openInApp` path.
- Verification opens must NOT be logged as interest "clicks" (never call `openItem`).
- Keep `node tests/run.js` green; commit after each task.

---

### Task 1: Extract `openUrlsInTabs(urls, opts)` and refactor `openSelected()`

**Files:**
- Modify: `web/index.html` (the `openSelected` function, currently at ~line 2816)
- Test: `tests/capture-wiring.test.js` (extend)

**Interfaces:**
- Produces: `openUrlsInTabs(urls, opts?) -> number` — opens each distinct `http(s)` URL in its own browser tab. `opts.skip` (optional `Set` of `normalizeUrl` keys) is both a skip-list and an accumulator: URLs whose key is in `skip` are not reopened, and each newly opened URL's key is added to it. Dedups within the call, filters to `http(s)`, confirms past 25, opens synchronously inside the user gesture, shows the same blocked/opened toasts as today. Returns the number of tabs opened.

- [ ] **Step 1: Write the failing test** — in `tests/capture-wiring.test.js`, append:

```js
t("openUrlsInTabs is the shared open-in-tabs helper, used by openSelected", () => {
  assert.ok(html.indexOf("function openUrlsInTabs(") >= 0, "openUrlsInTabs defined");
  const oi = html.indexOf("function openUrlsInTabs(");
  const obody = html.slice(oi, oi + 1600);
  assert.ok(obody.indexOf("https?:") >= 0, "keeps http(s)-only guard");
  assert.ok(obody.indexOf(">25") >= 0 && obody.indexOf("confirm(") >= 0, "keeps the 25-tab confirm");
  assert.ok(obody.indexOf("window.open(") >= 0, "opens via window.open (browser tab)");
  const si = html.indexOf("function openSelected(");
  const sbody = html.slice(si, si + 600);
  assert.ok(sbody.indexOf("openUrlsInTabs(") >= 0, "openSelected delegates to openUrlsInTabs");
  assert.ok(sbody.indexOf("_openedSel") >= 0, "openSelected still passes its session skip-set");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/capture-wiring.test.js`
Expected: FAIL — `openUrlsInTabs defined`.

- [ ] **Step 3: Implement the helper + refactor.** Replace the ENTIRE current `openSelected` function (from `function openSelected(){` through its closing `}` — currently lines ~2816–2848) with the helper followed by the slimmed `openSelected`:

```js
// Open each distinct http(s) URL in its own browser tab (deduped). Non-web links (javascript:/data:/
// etc. from an old import or restored backup) are skipped — mirrors the import og-image guard. Opens
// synchronously inside the user's click so the pop-up blocker treats them as ONE gesture (opening on a
// timer/await gets every tab after the first blocked). opts.skip: optional Set of normalizeUrl keys to
// skip and to add newly opened keys to (per-session dedup for the main grid). Returns tabs opened.
function openUrlsInTabs(urls, opts){
  opts = opts || {};
  const skip = opts.skip || null;
  const seen=new Set(), distinct=[];
  for(const u of (urls||[])){ if(!u) continue; const k=normalizeUrl(u); if(seen.has(k)) continue; seen.add(k); distinct.push(u); }
  const httpUrls = distinct.filter(u=>/^https?:\/\//i.test(u));
  const unsafe = distinct.length - httpUrls.length;
  const note = unsafe ? " ("+unsafe+" non-web link"+(unsafe===1?"":"s")+" skipped)" : "";
  const toOpen = skip ? httpUrls.filter(u=>!skip.has(normalizeUrl(u))) : httpUrls;
  if(!toOpen.length){
    if(unsafe && !httpUrls.length) toast("Those links can't be opened in a tab (not http/https).");
    else if(skip && httpUrls.length) toast("Already opened the selected link"+(httpUrls.length===1?"":"s")+" this session — click Done, then Select again to reopen."+note, 7000);
    else toast("Nothing to open."+note);
    return 0;
  }
  // opening a lot of tabs at once can choke the browser / trip the pop-up blocker — confirm past a sane number
  if(toOpen.length>25 && !confirm("Open all "+toOpen.length+" links in new tabs?\n\nYour browser may block the pop-ups or slow down. If they don't all appear, allow pop-ups for this site and try again.")) return 0;
  let opened=0, blocked=0;
  for(const u of toOpen){ let w=null; try{ w=window.open(u,"_blank"); }catch(e){} if(w){ try{ w.opener=null; }catch(e){} if(skip) skip.add(normalizeUrl(u)); opened++; } else blocked++; }
  if(blocked && !opened){
    toast("Your browser blocked the pop-ups. Click the blocked-pop-up icon in the address bar, allow pop-ups for this site, then click Open again."+note, 9000);
  } else if(blocked){
    toast("Opened "+opened+" tab"+(opened===1?"":"s")+", but "+blocked+" still blocked — allow pop-ups for this site and click Open again to open the rest."+note, 9000);
  } else {
    toast("Opened "+opened+" tab"+(opened===1?"":"s")+"."+note);
  }
  return opened;
}
function openSelected(){
  const picks=[...selPicks].map(i=>imported[i]).filter(it=>it && it.url);
  if(!picks.length){ toast("Select some cards with a link first"); return; }
  openUrlsInTabs(picks.map(it=>it.url), {skip:_openedSel});
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/capture-wiring.test.js`, then `node tests/syntax-check.js`, then `node tests/run.js`.
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/capture-wiring.test.js
git commit -m "refactor(ui): extract openUrlsInTabs shared by openSelected (no behavior change)"
```

---

### Task 2: Wire the failures modal — clickable titles + "Open" button

**Files:**
- Modify: `web/index.html` — modal CSS (~line 187, near `#failBody`), `failRowHTML` (~line 2358), `renderFailModal` action bar (~line 2384), plus two new functions near the other fail-modal functions (~line 2398)
- Test: `tests/capture-wiring.test.js` (extend)

**Interfaces:**
- Consumes: `openUrlsInTabs(urls)` (Task 1); `_failModalList` (array of failed cards, already defined ~line 2350); `_failCheckedIds()` (returns checked id strings, already defined ~line 2395).
- Produces: `openFailSelected()` (opens all checked cards' links in browser tabs); `openFailOne(id)` (opens one card's link in the browser).

- [ ] **Step 1: Write the failing test** — in `tests/capture-wiring.test.js`, append:

```js
t("fail modal: title opens one link in browser; Open button opens selected via openUrlsInTabs", () => {
  assert.ok(html.indexOf("function openFailSelected(") >= 0, "openFailSelected defined");
  assert.ok(html.indexOf("function openFailOne(") >= 0, "openFailOne defined");
  const fi = html.indexOf("function failRowHTML(");
  const fbody = html.slice(fi, fi + 800);
  assert.ok(fbody.indexOf("openFailOne(") >= 0, "title click opens one link");
  const ri = html.indexOf("function renderFailModal(");
  const rbody = html.slice(ri, ri + 2600);
  assert.ok(rbody.indexOf("openFailSelected()") >= 0, "Open button calls openFailSelected");
  const oi = html.indexOf("function openFailSelected(");
  const obody = html.slice(oi, oi + 400);
  assert.ok(obody.indexOf("openUrlsInTabs(") >= 0, "openFailSelected uses the shared browser-tab helper");
  assert.ok(obody.indexOf("openInApp") < 0, "must not use the reuse-window path");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/capture-wiring.test.js`
Expected: FAIL — `openFailSelected defined`.

- [ ] **Step 3a: Add the clickable-title CSS.** Find the `#failBody{...}` rule (added in v1.5.1, ~line 187):

```css
#failBody{display:flex;flex-direction:column;flex:1 1 auto;min-height:0;width:100%;overflow:hidden}
```

Insert these two rules immediately AFTER it:

```css
#failBody .dupe-row .meta .t{cursor:pointer}
#failBody .dupe-row .meta .t:hover{text-decoration:underline}
```

- [ ] **Step 3b: Make the title a single-open click target.** In `failRowHTML`, find the title line:

```js
    <div class="meta"><div class="t">${esc(c.title||dom||"(untitled)")}</div>
```

Replace it with (adds `title=` tooltip + `onclick` calling `openFailOne` with the card id — ids are an internal stable charset, safe in the JS string):

```js
    <div class="meta"><div class="t" title="Open in browser" onclick="openFailOne('${esc(c.id)}')">${esc(c.title||dom||"(untitled)")}</div>
```

- [ ] **Step 3c: Add the "Open" button as the FIRST action.** In `renderFailModal`, find the pinned action bar:

```js
    <div class="dupe-foot" style="border-top:0;border-bottom:1px solid var(--line);justify-content:flex-start;flex-wrap:wrap">
      <button class="btn btn-primary" onclick="retryFailFresh()">&#128260; Retry (fresh)</button>
```

Insert the Open button between the opening `<div class="dupe-foot" ...>` and the Retry button so the bar reads Open · Retry · Mark done · Remove:

```js
    <div class="dupe-foot" style="border-top:0;border-bottom:1px solid var(--line);justify-content:flex-start;flex-wrap:wrap">
      <button class="btn btn-ghost" onclick="openFailSelected()">&#8599; Open</button>
      <button class="btn btn-primary" onclick="retryFailFresh()">&#128260; Retry (fresh)</button>
```

- [ ] **Step 3d: Add the two opener functions.** Immediately AFTER the `_failCheckedIds` function (currently ends ~line 2397, just before `function retryFailFresh(){`), insert:

```js
function openFailOne(id){ const c=_failModalList.find(x=>x&&x.id===id); if(c&&c.url) openUrlsInTabs([c.url]); }   // single-click a title → open in browser
function openFailSelected(){
  const ids=new Set(_failCheckedIds()); if(!ids.size){ toast("Select some cards first"); return; }
  const urls=_failModalList.filter(c=>c&&ids.has(c.id)).map(c=>c.url).filter(Boolean);
  openUrlsInTabs(urls);   // browser tabs only — no reuse-window, no session-skip in the modal
}
```

- [ ] **Step 4: Run tests + gate**

Run: `node tests/capture-wiring.test.js`, then `node tests/syntax-check.js`, then `node tests/run.js`.
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/capture-wiring.test.js
git commit -m "feat(ui): open/verify links from the failures modal (click a title, or Open selected)"
```

---

## Notes for the executor

- After both tasks pass, this is shippable. Per the project rule, bump `package.json` to the next patch version (1.5.2) and rebuild the installer (`npm run dist`) — but the app must be fully closed first (it locks `dist\win-unpacked`). No domain reviews needed (renderer-only, no store/endpoint/delete change); a final whole-branch read is enough.
