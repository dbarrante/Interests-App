# Combined Dead+Safety Sweep & Key Instructions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "Check dead links" also run a Google Safe Browsing pass (merged, tagged review), keep the standalone safety button, and add real key-acquisition instructions to Settings.

**Architecture:** Extract `checkLinkSafety`'s loop into a shared `runSafetyPass(cands, opts)` helper; call it from both `checkLinkSafety` (standalone) and `checkDeadLinks` (combined). Unsafe links merge into the existing dead-link review modal via a new `deadRowHTML` row variant. Settings instructions reuse the existing `GUIDES`/`showGuide` modal convention. All edits are in `web/index.html`; no Core/endpoint/storage changes.

**Tech Stack:** Plain inline browser JS in `web/index.html`. Tests: text-assertion wiring tests (`tests/safety-wiring.test.js`) + `tests/syntax-check.js` + full gate `tests/run.js`.

## Global Constraints

- Single-file app; make PRECISE string replacements at the anchors given; do NOT reformat surrounding code. If an anchor isn't found EXACTLY, STOP and report BLOCKED.
- Read-only detection; unsafe links only join the review modal; removal stays in the UNCHANGED snapshot-first `applyDeadRemoval`.
- The safety pass: chunks of 200; honors a caller-supplied stop check; stamps the additive `sb = {at, verdict, threat}` marker; returns entries `{scope, card, unsafe:true, threat}`. Fail-open is inherited from the Core (`safebrowse.checkUrls`).
- No new endpoints, Core, storage, or key-handling changes. Reuses `Store.checkSafety` / `Store.getSafeBrowsingKey` and `/api/check-safety`.
- `process.exitCode`, never `process.exit()` in tests.

---

### Task 1: Extract `runSafetyPass`; refactor `checkLinkSafety`

**Files:**
- Modify: `web/index.html` (replace the `checkLinkSafety` function with `runSafetyPass` + a slimmed `checkLinkSafety`)
- Test: `tests/safety-wiring.test.js` (extend)

**Interfaces:**
- Consumes: `Store.checkSafety`, `Store.getSafeBrowsingKey`, `toast`, `showTab`, `imported`, `saved`, `_sbFresh`, `_sbStop`, `openSafetyReview`, `Store.putCards/putSaved`, `writeSavesFile`.
- Produces: `runSafetyPass(cands, opts:{isStopped?, onStop?}) -> Promise<{scope,card,unsafe:true,threat}[]>` (stamps each card's `sb` marker).

- [ ] **Step 1: Extend the failing test** — in `tests/safety-wiring.test.js`, add before the final `console.log`:

```js
t("shared runSafetyPass helper exists and checkLinkSafety uses it", () => {
  assert.ok(html.indexOf("function runSafetyPass") >= 0);
  assert.ok(html.indexOf("runSafetyPass(") >= 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/safety-wiring.test.js`
Expected: FAIL — `function runSafetyPass` not found.

- [ ] **Step 3: Replace the implementation**

In `web/index.html`, find this EXACT current `checkLinkSafety` function (the whole block) and replace it:

```js
async function checkLinkSafety(){
  let hasKey = false;
  try { hasKey = await Store.getSafeBrowsingKey(); } catch(e){ hasKey = false; }
  if(!hasKey){ toast("Add your Google Safe Browsing API key in Settings first", 6000); showTab("settings"); return; }
  const cand = [];
  imported.forEach(it=>{ if(it && /^https?:\/\//i.test(it.url||"") && !_sbFresh(it)) cand.push({scope:"imported", card:it}); });
  saved.forEach(it=>{ if(it && /^https?:\/\//i.test(it.url||"") && !_sbFresh(it)) cand.push({scope:"saved", card:it}); });
  if(!cand.length){ toast("No links to check (all recently checked)", 4000); return; }
  _sbStop = false;
  const unsafe = []; let done = 0;
  for(let i=0; i<cand.length && !_sbStop; i+=200){
    const chunk = cand.slice(i, i+200);
    toast(`Checking link safety… ${done}/${cand.length} — tap to stop`, 60000, ()=>{ _sbStop = true; });
    let results = [];
    try{ results = await Store.checkSafety(chunk.map(c=>({ id:c.card.id, url:c.card.url }))); }
    catch(e){ console.warn("check-safety chunk failed", e); continue; }
    const byId = {}; results.forEach(r=>byId[r.id]=r);
    chunk.forEach(c=>{ const r=byId[c.card.id]; if(!r) return; const threat=r.threat||null; c.card.sb={ at:Date.now(), verdict: threat?"unsafe":"safe", threat:threat }; if(threat) unsafe.push(Object.assign({}, c, {threat})); });
    done += chunk.length;
  }
  Store.putCards(imported); Store.putSaved(saved); writeSavesFile();
  if(unsafe.length) openSafetyReview(unsafe);
  else toast(_sbStop ? "Stopped — none flagged so far" : (done ? "No unsafe links found." : "Nothing to check"), 5000);
}
```

with:

```js
// Shared safety pass (Google Safe Browsing) used by BOTH the standalone safety button and the
// combined dead-link sweep. Stamps each card's additive `sb` marker and returns the flagged
// entries {scope, card, unsafe:true, threat}. Honors a caller-supplied stop check.
async function runSafetyPass(cands, opts){
  opts = opts || {};
  const isStopped = opts.isStopped || function(){ return false; };
  const onStop = opts.onStop || function(){};
  const unsafe = []; let done = 0;
  for(let i=0; i<cands.length && !isStopped(); i+=200){
    const chunk = cands.slice(i, i+200);
    toast(`Checking link safety… ${done}/${cands.length} — tap to stop`, 60000, onStop);
    let results = [];
    try{ results = await Store.checkSafety(chunk.map(c=>({ id:c.card.id, url:c.card.url }))); }
    catch(e){ console.warn("check-safety chunk failed", e); continue; }
    const byId = {}; results.forEach(r=>byId[r.id]=r);
    chunk.forEach(c=>{ const r=byId[c.card.id]; if(!r) return; const threat=r.threat||null; c.card.sb={ at:Date.now(), verdict: threat?"unsafe":"safe", threat:threat }; if(threat) unsafe.push(Object.assign({}, c, {unsafe:true, threat:threat})); });
    done += chunk.length;
  }
  return unsafe;
}
async function checkLinkSafety(){
  let hasKey = false;
  try { hasKey = await Store.getSafeBrowsingKey(); } catch(e){ hasKey = false; }
  if(!hasKey){ toast("Add your Google Safe Browsing API key in Settings first", 6000); showTab("settings"); return; }
  const cand = [];
  imported.forEach(it=>{ if(it && /^https?:\/\//i.test(it.url||"") && !_sbFresh(it)) cand.push({scope:"imported", card:it}); });
  saved.forEach(it=>{ if(it && /^https?:\/\//i.test(it.url||"") && !_sbFresh(it)) cand.push({scope:"saved", card:it}); });
  if(!cand.length){ toast("No links to check (all recently checked)", 4000); return; }
  _sbStop = false;
  const unsafe = await runSafetyPass(cand, { isStopped: function(){ return _sbStop; }, onStop: function(){ _sbStop = true; } });
  Store.putCards(imported); Store.putSaved(saved); writeSavesFile();
  if(unsafe.length) openSafetyReview(unsafe);
  else toast(_sbStop ? "Stopped — none flagged so far" : "No unsafe links found.", 5000);
}
```

(`safetyRowHTML` reads only `c.threat`, so the added `unsafe:true` key is harmless for the standalone modal.)

- [ ] **Step 4: Run wiring test + syntax + full gate**

Run: `node tests/safety-wiring.test.js` (expect all pass)
Run: `node tests/syntax-check.js` (expect `0 error(s)`)
Run: `node tests/run.js` (expect `ALL TEST FILES PASSED`)

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/safety-wiring.test.js
git commit -m "refactor(ui): extract shared runSafetyPass; checkLinkSafety uses it"
```

---

### Task 2: Combined sweep — `checkDeadLinks` runs safety; merged review row

**Files:**
- Modify: `web/index.html` (`checkDeadLinks` tail; `deadRowHTML`; `renderDeadModal` text)
- Test: `tests/safety-wiring.test.js` (extend)

**Interfaces:**
- Consumes: `runSafetyPass` (Task 1), `_sbFresh`, `_threatLabel`, `_deadStop`, `dead` list, `Store.getSafeBrowsingKey`, existing `_deadReason`/`waybackUrl`/`esc`/`dupeThumb`/`domain`.
- Produces: dead-list entries may carry `{unsafe:true, threat}`; `deadRowHTML` renders that variant.

- [ ] **Step 1: Extend the failing test** — in `tests/safety-wiring.test.js`, add before the final `console.log`:

```js
t("dead-link sweep runs the safety pass and tags unsafe rows", () => {
  // checkDeadLinks must call runSafetyPass; deadRowHTML must branch on c.unsafe
  const cdl = html.indexOf("async function checkDeadLinks");
  const drh = html.indexOf("function deadRowHTML");
  assert.ok(cdl >= 0 && drh >= 0);
  assert.ok(html.indexOf("runSafetyPass(") >= 0);
  assert.ok(html.slice(drh, drh + 800).indexOf("c.unsafe") >= 0, "deadRowHTML should handle c.unsafe");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/safety-wiring.test.js`
Expected: FAIL — `deadRowHTML should handle c.unsafe`.

- [ ] **Step 3a: Add the safety pass to `checkDeadLinks`**

In `checkDeadLinks`, find this EXACT tail block:

```js
  // Persist the lc markers (so re-runs resume) via the normal bulk-replace path.
  Store.putCards(imported); Store.putSaved(saved); writeSavesFile();
  if(dead.length) openDeadReview(dead);
  else toast(_deadStop ? "Stopped — none dead so far" : (done ? "No dead links found." : "Nothing to check"), 5000);
```

Replace it with:

```js
  // Safety pass (Google Safe Browsing) over the same links — flagged links join the review
  // tagged unsafe. Only if a key is set; otherwise a one-time hint. Honors _deadStop. Free, no consent.
  let sbHasKey = false;
  try { sbHasKey = await Store.getSafeBrowsingKey(); } catch(e){ sbHasKey = false; }
  if(sbHasKey){
    const sbCands = cand.filter(c=>!_sbFresh(c.card));
    if(sbCands.length && !_deadStop){
      const flagged = await runSafetyPass(sbCands, { isStopped: function(){ return _deadStop; }, onStop: function(){ _deadStop = true; } });
      flagged.forEach(u=>{ const ex = dead.find(d=>d.card && d.card.id===u.card.id && d.scope===u.scope); if(ex){ ex.unsafe = true; ex.threat = u.threat; } else dead.push(u); });
    }
  } else if(!_deadStop){
    toast("Add a Google Safe Browsing key in Settings to also check link safety", 7000);
  }

  // Persist the lc/sb markers (so re-runs resume) via the normal bulk-replace path.
  Store.putCards(imported); Store.putSaved(saved); writeSavesFile();
  if(dead.length) openDeadReview(dead);
  else toast(_deadStop ? "Stopped — nothing flagged so far" : (done ? "No dead or unsafe links found." : "Nothing to check"), 5000);
```

- [ ] **Step 3b: Teach `deadRowHTML` the unsafe variant**

Replace the EXACT current `deadRowHTML` function:

```js
function deadRowHTML(c){
  const it=c.card; const dom=domain(it.url)||""; const tag=c.scope==="saved"?"Saved":"Imported";
  return `<div class="dupe-row">
    ${dupeThumb(c)}
    <div class="meta"><div class="t">${esc(it.title||dom||"(untitled)")}</div>
      <div class="s">${esc(dom)} · <span class="dupe-badge">${tag}</span> · <span style="color:#e0556b">${c.soft ? esc("AI: "+(c.softReason||"content removed")) : esc(_deadReason(it.lc&&it.lc.code))}</span>${c.soft?` · <a href="${esc(waybackUrl(it.url))}" target="_blank" rel="noopener">archived copy</a>`:""}</div></div>
    <label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" data-rm="${esc(c.scope+":"+it.id)}" checked style="width:auto"> remove</label>
  </div>`;
}
```

with:

```js
function deadRowHTML(c){
  const it=c.card; const dom=domain(it.url)||""; const tag=c.scope==="saved"?"Saved":"Imported";
  const reason = c.unsafe
    ? `<span style="color:#e0556b">&#9888; ${esc(_threatLabel(c.threat))}</span>`
    : c.soft
      ? `<span style="color:#e0556b">${esc("AI: "+(c.softReason||"content removed"))}</span> · <a href="${esc(waybackUrl(it.url))}" target="_blank" rel="noopener">archived copy</a>`
      : `<span style="color:#e0556b">${esc(_deadReason(it.lc&&it.lc.code))}</span>`;
  return `<div class="dupe-row">
    ${dupeThumb(c)}
    <div class="meta"><div class="t">${esc(it.title||dom||"(untitled)")}</div>
      <div class="s">${esc(dom)} · <span class="dupe-badge">${tag}</span> · ${reason}</div></div>
    <label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" data-rm="${esc(c.scope+":"+it.id)}" checked style="width:auto"> remove</label>
  </div>`;
}
```

(`_threatLabel` is a hoisted `function` declaration later in the file, so it's callable here.)

- [ ] **Step 3c: Update the merged modal's header + hint text**

In `renderDeadModal`, find:

```js
    <div class="dupe-head"><span>&#128279; Dead links — ${_deadList.length} found</span>
```
replace with:
```js
    <div class="dupe-head"><span>&#128279; Dead &amp; unsafe links — ${_deadList.length} found</span>
```

And find:
```js
      <div class="s" style="opacity:.7;padding:2px 4px 8px">Only definitively-dead links (404 / gone domain) are listed. Uncheck any you want to keep, then click Remove selected.</div>
```
replace with:
```js
      <div class="s" style="opacity:.7;padding:2px 4px 8px">Dead, removed, or unsafe (malware/phishing) links found in your library. Uncheck any you want to keep, then click Remove selected.</div>
```

- [ ] **Step 4: Run wiring test + syntax + full gate**

Run: `node tests/safety-wiring.test.js` (expect all pass)
Run: `node tests/syntax-check.js` (expect `0 error(s)`)
Run: `node tests/run.js` (expect `ALL TEST FILES PASSED`)

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/safety-wiring.test.js
git commit -m "feat(ui): dead-link sweep also runs Safe Browsing; merged tagged review"
```

---

### Task 3: Settings key instructions (GUIDES + link)

**Files:**
- Modify: `web/index.html` (add `GUIDES.sbkey`; change the Safe Browsing hint to link to it)
- Test: `tests/safety-wiring.test.js` (extend)

**Interfaces:**
- Consumes: existing `GUIDES` object + `showGuide(p)` modal.

- [ ] **Step 1: Extend the failing test** — in `tests/safety-wiring.test.js`, add before the final `console.log`:

```js
t("Settings links to step-by-step Safe Browsing key instructions", () => {
  assert.ok(html.indexOf("showGuide('sbkey')") >= 0);
  assert.ok(html.indexOf("sbkey:") >= 0);
  assert.ok(html.indexOf("Safe Browsing API") >= 0);
  assert.ok(html.indexOf("Create credentials") >= 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/safety-wiring.test.js`
Expected: FAIL — `showGuide('sbkey')` not found.

- [ ] **Step 3a: Add the `sbkey` guide**

In `web/index.html`, find this EXACT line (the start of the groq guide entry inside the `GUIDES` object):

```js
  groqkey: `<h2>Get a free Groq API key</h2><ol>
```

Insert the following IMMEDIATELY BEFORE it (so `sbkey` is a new entry just above `groqkey`):

```js
  sbkey: `<h2>Get a free Google Safe Browsing API key</h2><ol>
    <li>Go to <b>console.cloud.google.com</b> and sign in with your Google account</li>
    <li>Create a project (top bar project dropdown &rarr; <b>New Project</b>), or pick an existing one</li>
    <li>Open <b>APIs &amp; Services &rarr; Library</b>, search <b>Safe Browsing API</b>, and click <b>Enable</b></li>
    <li>Open <b>APIs &amp; Services &rarr; Credentials</b>, click <b>Create credentials &rarr; API key</b></li>
    <li>Copy the key and paste it into the field here</li></ol>
    <p>Safe Browsing is Google's free malware/phishing blocklist — the same one Chrome uses. The free quota (about 10,000 checks/day) is far more than this app needs. The links you check are sent to Google for lookup; nothing else leaves your machine.</p>`,
```

- [ ] **Step 3b: Link the Settings hint to the guide**

Find this EXACT line:

```html
          <div class="hint">Free malware/phishing check for your links. Get a key at <b>developers.google.com/safe-browsing/v4/get-started</b>. Leave blank to disable.</div>
```

Replace with:

```html
          <div class="hint">Free malware/phishing check for your links — <a href="#" onclick="showGuide('sbkey');return false"><b>step-by-step instructions</b></a>. Leave blank to disable.</div>
```

- [ ] **Step 4: Run wiring test + syntax + full gate**

Run: `node tests/safety-wiring.test.js` (expect all pass)
Run: `node tests/syntax-check.js` (expect `0 error(s)`)
Run: `node tests/run.js` (expect `ALL TEST FILES PASSED`)

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/safety-wiring.test.js
git commit -m "feat(ui): step-by-step Safe Browsing key instructions in Settings"
```

---

### Task 4: Data-safety review, version bump, installer

**Files:**
- Modify: `package.json` (version bump)

- [ ] **Step 1: Full gate**

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED`.

- [ ] **Step 2: data-safety-reviewer subagent**

Dispatch the `data-safety-reviewer` against the feature diff (focus: the combined sweep is read-only; unsafe links only join the review modal; removal still flows through the unchanged snapshot-first `applyDeadRemoval`; the `sb` marker stays additive; the dead+unsafe dedup-merge can't drop a card or double-remove; no new personal-data write). Fix any findings; re-run `node tests/run.js`; commit.

(electron-security review is NOT required: no new endpoint, network call, IPC, or key-handling surface — the Safe Browsing path and key handling are unchanged from v1.3.0.)

- [ ] **Step 3: Version bump**

In `package.json`, change `"version": "1.3.0"` to `"version": "1.3.1"` (additive feature/UX → patch/minor; use 1.3.1).

```bash
git add package.json
git commit -m "chore: bump version to 1.3.1 (combined dead+safety sweep, key instructions)"
```

- [ ] **Step 4: Rebuild installer**

Run: `npm run dist`
Expected: `dist/Interests-App-Setup-1.3.1.exe` produced (exit 0; unsigned is normal).

- [ ] **Step 5: Summarize for Dave**

Report what shipped + installer path + how to use (Check dead links now also flags unsafe links in one review; standalone safety button still there; Settings → "step-by-step instructions" link for the key). Do NOT offer merge/PR — build is on master.

---

## Self-Review

**Spec coverage:**
- Combined sweep (dead-link button also runs safety, merged tagged review, social included via `cand`, no-key one-time hint, stoppable, no consent) → Task 2 (+ shared helper Task 1). ✓
- Standalone safety button unchanged → Task 1 (refactor preserves behavior). ✓
- Merged review modal row variant (unsafe = red threat label, no wayback) → Task 2 (`deadRowHTML`). ✓
- Settings key instructions (real Google Cloud steps, collapsible/guide) → Task 3 (reuses `GUIDES`/`showGuide`). ✓
- No new endpoints/Core/storage; removal reuses `applyDeadRemoval`; `sb` additive → all tasks (web-only). ✓
- Data-safety review + installer bump → Task 4. ✓
- Phase 2 open-time + modal-merge refactor explicitly deferred. ✓

**Placeholder scan:** none — every step has complete code/anchors.

**Type consistency:** `runSafetyPass` returns `{scope,card,unsafe:true,threat}`; `checkDeadLinks` merges those into `dead` (dedup by `card.id`+`scope`, setting `ex.unsafe`/`ex.threat`); `deadRowHTML` branches on `c.unsafe`/`c.soft`; `_threatLabel`/`_deadReason`/`waybackUrl` names match existing code; `_sbFresh` filters safety candidates. `safetyRowHTML` (standalone) still reads `c.threat`. Consistent.
