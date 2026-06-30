# Instagram Match-and-Heal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a captured Instagram post matches a failed imported card (by permalink shortcode), heal that card with the captured photo instead of creating a duplicate Saved card — recovering the IG backlog as the user browses, while new IG posts still go to Saved.

**Architecture:** App-only (`web/index.html`), in the capture-ingest path. A pure `igShortcode(url)` extracts the post code from `/p|reel|reels|tv/<code>`. `igHealMatch(cap)` heals any failed imported card whose shortcode matches the captured IG post (and whose image is bad or the v4.39-era static logo), then `drainCaptures` calls it before falling back to `addClip` (→ Saved). No extension or Core change — reuses the IG capture that already works.

**Tech Stack:** Vanilla JS single-file renderer; plain-`node` tests (`_extract` loadFns for pure functions + text-assert wiring).

## Global Constraints

- App-only: no extension change, no Core/endpoint change, no new fetch. Reuses the existing extension IG capture (v4.39) and `setCardImage`.
- Non-destructive: heal ONLY cards whose image is bad (`isBadImg`) OR the IG static logo (`/static\.cdninstagram\.com|rsrc\.php|\/images\//i`) — never overwrite a genuinely good image; never delete a card; never create a duplicate when matched.
- IG-only: the helpers act only on `instagram.com` post shortcodes; Facebook/Pinterest/normal clips are untouched.
- Matching ignores `/p` vs `/reel(s)` vs `/tv` (same `<code>` = same post). A capture with no usable image heals nothing (returns `false` → falls through to `addClip`'s existing IG-no-image toast).
- Keep `node tests/run.js` green; commit after each task.

---

### Task 1: `igShortcode(url)` pure helper

**Files:**
- Modify: `web/index.html` (add a top-level function immediately BEFORE `function addClip(cap){`, ~line 4277)
- Test: `tests/capture-wiring.test.js` (extend, using `_extract`'s `loadFns`)

**Interfaces:**
- Produces: `igShortcode(url) -> string` — the IG post code, or `""` for non-IG / non-post URLs. (Top-level function declaration so `loadFns` can extract it.)

- [ ] **Step 1: Write the failing test** — append to `tests/capture-wiring.test.js` (add the require at the top of the file if not already present: `const { loadFns } = require("./_extract");`):

```js
t("igShortcode extracts the IG post code from p/reel/reels/tv, else ''", () => {
  const { igShortcode } = loadFns(["igShortcode"]);
  assert.strictEqual(igShortcode("https://www.instagram.com/p/ABC123/"), "ABC123");
  assert.strictEqual(igShortcode("https://www.instagram.com/reel/DYnA8VyoVYR/"), "DYnA8VyoVYR");
  assert.strictEqual(igShortcode("https://www.instagram.com/reels/DZ-P1bMxOwg/"), "DZ-P1bMxOwg");
  assert.strictEqual(igShortcode("https://www.instagram.com/tv/XYZ9/"), "XYZ9");
  assert.strictEqual(igShortcode("https://www.instagram.com/accounts/login/"), "");
  assert.strictEqual(igShortcode("https://fatpita.net/?i=6043"), "");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/capture-wiring.test.js`
Expected: FAIL — `function not found in index.html: igShortcode` (loadFns throws) / not defined.

- [ ] **Step 3: Implement.** In `web/index.html`, immediately before `function addClip(cap){`, add:

```js
// Extract an Instagram post shortcode from a /p|reel|reels|tv/<code> permalink (else ""). Lets a
// freshly-captured IG post be matched to a failed imported card regardless of /p vs /reel(s) form.
function igShortcode(url){
  const m = /instagram\.com\/(?:p|reel|reels|tv)\/([\w-]+)/i.exec(url||"");
  return m ? m[1] : "";
}
```

- [ ] **Step 4: Run tests + gate**

Run: `node tests/capture-wiring.test.js`, then `node tests/syntax-check.js`, then `node tests/run.js`.
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/capture-wiring.test.js
git commit -m "feat(ui): igShortcode helper — extract Instagram post code for matching"
```

---

### Task 2: `igHealMatch` + wire into `drainCaptures` + backlog guidance

**Files:**
- Modify: `web/index.html` — add `igHealMatch` (top-level, immediately before `function addClip(cap){`, after `igShortcode`); wire the `drainCaptures` `"saved"` branch (~line 4143); extend the failures-modal help text in `renderFailModal` (~line 2390)
- Test: `tests/capture-wiring.test.js` (extend)

**Interfaces:**
- Consumes: `igShortcode` (Task 1); existing globals `imported`, `isBadImg`, `setCardImage`, `Store.putCards`, `updateCounts`, `renderImportedKeepFocus`, `curTab`.
- Produces: `igHealMatch(cap) -> bool`.

- [ ] **Step 1: Write the failing test** — append to `tests/capture-wiring.test.js`:

```js
t("IG match-and-heal: igHealMatch defined, heals by shortcode, called before addClip", () => {
  assert.ok(html.indexOf("function igHealMatch(") >= 0, "igHealMatch defined");
  const hi = html.indexOf("function igHealMatch(");
  const hb = html.slice(hi, hi + 1000);
  assert.ok(hb.indexOf("igShortcode") >= 0, "matches by shortcode");
  assert.ok(hb.indexOf("setCardImage") >= 0, "heals via setCardImage");
  assert.ok(hb.indexOf("isBadImg") >= 0 && hb.indexOf("cdninstagram") >= 0, "heals bad-image OR static-logo cards");
  const di = html.indexOf("async function drainCaptures(");
  const db = html.slice(di, di + 9000);
  assert.ok(db.replace(/\s/g, "").indexOf("if(!igHealMatch(cap))addClip(cap)") >= 0, "drainCaptures tries igHealMatch before addClip");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/capture-wiring.test.js`
Expected: FAIL — `igHealMatch defined`.

- [ ] **Step 3a: Add `igHealMatch`.** In `web/index.html`, immediately before `function addClip(cap){` (and after `igShortcode`), add:

```js
// A captured Instagram post: if its shortcode matches failed imported card(s) — whose image is bad or
// the v4.39-era static logo — heal them with the captured photo instead of creating a duplicate Saved
// card. Returns true if it healed at least one. Non-IG / no-image / no-match -> false (caller falls
// back to addClip). Deliberate user re-capture; never touches a genuinely good image.
function igHealMatch(cap){
  const sc = igShortcode(cap && cap.url); if(!sc) return false;
  const img = (cap && (cap.clipImage || cap.screenshot || cap.ogImage || cap.contentImage)) || "";
  if(!img) return false;
  const broken = (s)=> isBadImg(s) || /static\.cdninstagram\.com|rsrc\.php|\/images\//i.test(s);
  const matches = imported.filter(c=> c && igShortcode(c.url)===sc && broken((typeof c.img==="string"?c.img:"")||""));
  if(!matches.length) return false;
  const now=Date.now();
  matches.forEach(c=>{ setCardImage(c, img); c.captured=now; c.lastUpdate=now; c.lastResult="ok"; c.capReason=""; });
  Store.putCards(imported); updateCounts();
  if(curTab==="imported") renderImportedKeepFocus();
  return true;
}
```

- [ ] **Step 3b: Wire into `drainCaptures`.** Find the `"saved"` branch (~line 4143):

```js
    if(decision.action === "saved"){
      try{ addClip(cap); }catch(e){ console.error("[clip] addClip failed", e); }
      continue;
    }
```

Replace with (heal an IG match first; only Saved if it didn't):

```js
    if(decision.action === "saved"){
      try{ if(!igHealMatch(cap)) addClip(cap); }catch(e){ console.error("[clip] addClip failed", e); }
      continue;
    }
```

- [ ] **Step 3c: Backlog guidance.** In `renderFailModal`, find the help line (~line 2390):

```js
      <div class="s" style="opacity:.7;padding:2px 4px 8px">Select cards, then use a button above. <b>Retry (fresh)</b> clears the old picture and re-captures; <b>Remove</b> deletes (backup-first); <b>Mark done</b> stops a card showing as failed (e.g. no preview image). Login-walled cards need the extension.</div>
```

Replace the trailing `Login-walled cards need the extension.` with an Instagram-specific instruction:

```js
      <div class="s" style="opacity:.7;padding:2px 4px 8px">Select cards, then use a button above. <b>Retry (fresh)</b> clears the old picture and re-captures; <b>Remove</b> deletes (backup-first); <b>Mark done</b> stops a card showing as failed (e.g. no preview image). <b>Instagram:</b> open your IG <b>Saved collection</b> in Chrome (logged in) and right-click &#8594; &ldquo;Save to Interests&rdquo; on each post &mdash; matching ones heal here automatically.</div>
```

- [ ] **Step 4: Run tests + gate**

Run: `node tests/capture-wiring.test.js`, then `node tests/syntax-check.js`, then `node tests/run.js`.
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/capture-wiring.test.js
git commit -m "feat(ui): Instagram match-and-heal — captured IG posts fix matching failed cards"
```

---

## Notes for the executor

- After both tasks pass, run the **data-safety-reviewer** (additive card mutation: confirm it only heals bad/logo-image cards, never overwrites a good image, never deletes, never duplicates). No electron-security review needed (app-only, no endpoint/IPC/extension change). Then bump `package.json` 1.5.6 → 1.5.7 and rebuild the installer (`npm run dist`) — the app must be fully CLOSED first.
- `setCardImage(c, img)` stores a `data:` image as `idb:` (and a non-`data:` http URL as the URL), cleaning up any prior `idb:` blob — confirm by reading its definition before relying on it.
