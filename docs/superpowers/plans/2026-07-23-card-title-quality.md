# Card Title Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every card (Imported + Saved) has an accurate, non-generic, unique title — filling gaps with an AI-generated one (≤8 words) when the source page has none — and give the user a Library Health tab to find and fix the ones that still need it.

**Architecture:** A new pure predicate `isGenericTitle(title, url)` (dual browser/Node, `web/lib/capture-state.js`) becomes the single "does this title need fixing" check, replacing the existing `genericTitle()` at its 3 call sites. A new pure module `web/title-ai.js` builds the AI prompt and parses the reply. A new inline-script orchestration function `generateUniqueTitle(card, extraAvoid)` (in `web/index.html`/`pwa/index.html`, not extractable to a pure module — it needs `imported`/`saved`/`callAI`/`IA_AI`) ties detection + generation + a local uniqueness check together, with retry-with-feedback on collision. It's wired into single-card refresh (automatic) and a new "Title issues" Library Health tab (explicit, reviewed). Bulk refresh gets the stricter detector but stays AI-free.

**Tech Stack:** Vanilla JS, no build step. `web/index.html`/`pwa/index.html` inline `<script>` blocks; small dual browser/Node modules under `web/lib/` and `web/` root (mirrored byte-identical into `pwa/`); plain Node `assert` test scripts under `tests/`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-23-card-title-quality-design.md` — every task below implements a section of it; treat that doc as the source of truth for *why*, this plan for *how*.
- `web/index.html` is authoritative; `pwa/index.html` mirrors every change in this plan (structurally equivalent, not always byte-identical — follow the existing pattern: some functions are exact copies, `drainCaptures` is only behavior-identical per `tests/surface-parity-manifest.js`'s `indexContracts` list).
- `web/lib/capture-state.js` ↔ `pwa/lib/capture-state.js` MUST stay byte-identical (enforced by `tests/surface-parity-manifest.js`'s `exactPairs`). Edit one, then copy it verbatim over the other — never hand-edit both separately.
- `web/title-ai.js` (new) ↔ `pwa/title-ai.js` (new) — not currently enforced by the parity manifest, but every existing root-level dual-module pair (`web/deadcheck-ai.js` ↔ `pwa/deadcheck-ai.js`, `web/ai.js` ↔ `pwa/ai.js`) is kept byte-identical in practice. This plan adds the new pair to `exactPairs` too (Task 3) so drift is caught automatically.
- Any edit to `pwa/index.html`, `pwa/idb.js`, `pwa/storage-pwa.js`, or any file the PWA app-shell caches requires bumping `SHELL_CACHE` in `pwa/sw.js` and the matching assertion in `tests/duplicate-review-mode.test.js` (project convention — installed PWAs otherwise keep serving stale cached content).
- `card.desc` (imported cards) vs `item.benefit` (saved items) are the two different "extra context" fields — never `.description`. `generateUniqueTitle` must read `card.desc || card.benefit` to work for both scopes.
- `{confirm:true}` on `Store.putCards`/`Store.putSaved` is reserved for user-reviewed *removals* (bypasses the mass-delete guard). A title edit is never a removal — persist with plain `persistCards()` / `Store.putSaved(saved)`, matching the existing `impEditSave` manual-edit precedent (`web/index.html:3770-3784`).
- Run `node tests/run.js` (full suite) before every commit in this plan — it's fast enough (whole repo, seconds) to run every time, not just at the end.

---

## Task 1: `isGenericTitle(title, url)` predicate

**Files:**
- Modify: `web/lib/capture-state.js`
- Modify: `pwa/lib/capture-state.js` (copy of the above, byte-identical)
- Test: `tests/capture-state.test.js`

**Interfaces:**
- Produces: `isGenericTitle(title, url) -> boolean` — exported via `module.exports` (Node) and `root.isGenericTitle` (browser), same pattern as every other function in this file. Pure, no DOM/Store/global access.

- [ ] **Step 1: Write the failing tests**

Append to `tests/capture-state.test.js` (after the existing `isBadImg` tests, before the `captureable` tests — anywhere at the top level works since `t()` just runs and tallies):

```js
/* ---------- isGenericTitle ---------- */
t("isGenericTitle: blank/whitespace -> generic", () => {
  assert.ok(CS.isGenericTitle("", "https://example.com/a"));
  assert.ok(CS.isGenericTitle("   ", "https://example.com/a"));
  assert.ok(CS.isGenericTitle(undefined, "https://example.com/a"));
  assert.ok(CS.isGenericTitle(null, "https://example.com/a"));
});
t("isGenericTitle: under 25 chars -> generic", () => {
  assert.ok(CS.isGenericTitle("Short title here", "https://example.com/a")); // 17 chars
});
t("isGenericTitle: 'N photos/videos' -> generic", () => {
  assert.ok(CS.isGenericTitle("12 photos from the trip", "https://example.com/a"));
  assert.ok(CS.isGenericTitle("3 videos you might like", "https://example.com/a"));
});
t("isGenericTitle: bare URL as title -> generic", () => {
  assert.ok(CS.isGenericTitle("https://www.instagram.com/p/Cabc123XYZ/", "https://www.instagram.com/p/Cabc123XYZ/"));
});
t("isGenericTitle: title equals the URL's domain -> generic", () => {
  assert.ok(CS.isGenericTitle("instagram.com", "https://www.instagram.com/reel/xyz"));
  assert.ok(CS.isGenericTitle("Instagram.com", "https://instagram.com/reel/xyz")); // case-insensitive
});
t("isGenericTitle: platform-name blocklist (exact, case-insensitive) -> generic", () => {
  ["Facebook", "instagram", "Pinterest", "YouTube", "no title", "Untitled", "Untitled Pin Page"]
    .forEach(bad => assert.ok(CS.isGenericTitle(bad, "https://example.com/a"), bad + " should be flagged"));
});
t("isGenericTitle: templated generic nouns -> generic", () => {
  ["Facebook post", "Saved video", "Instagram reel", "Pinterest pin", "Saved item"]
    .forEach(bad => assert.ok(CS.isGenericTitle(bad, "https://example.com/a"), bad + " should be flagged"));
});
t("isGenericTitle: 'Instagram post <slug>' -> generic even when long", () => {
  assert.ok(CS.isGenericTitle("Instagram post abc123xyz456slug789", "https://instagram.com/p/x"));
});
t("isGenericTitle: '<Platform> post by <Author>' -> generic", () => {
  assert.ok(CS.isGenericTitle("Facebook post by Jane Smith Cooking Co", "https://facebook.com/x"));
});
t("isGenericTitle: a real descriptive title -> NOT generic", () => {
  assert.ok(!CS.isGenericTitle("How to Build a Backyard Pizza Oven This Weekend", "https://example.com/pizza-oven"));
  assert.ok(!CS.isGenericTitle("SpaceX Starship Completes First Orbital Refueling Test", "https://spacenews.example.com/starship"));
});
t("isGenericTitle: a title that happens to contain a generic word but isn't just that word -> NOT generic", () => {
  assert.ok(!CS.isGenericTitle("Reel Mower Maintenance: A Complete Seasonal Guide", "https://example.com/mower"));
});
t("isGenericTitle: url missing/malformed never throws", () => {
  assert.doesNotThrow(() => CS.isGenericTitle("Some Title Long Enough To Pass", undefined));
  assert.doesNotThrow(() => CS.isGenericTitle("Some Title Long Enough To Pass", "not a url"));
  assert.doesNotThrow(() => CS.isGenericTitle("Some Title Long Enough To Pass", ""));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node tests/capture-state.test.js`
Expected: several `FAIL` lines with `CS.isGenericTitle is not a function` (or `TypeError`), since the function doesn't exist yet.

- [ ] **Step 3: Implement `isGenericTitle` in `web/lib/capture-state.js`**

Add this function after `isBadImg` (right before the `hammingDist` comment block, so it sits with the other pure predicates near the top):

```js
  // isGenericTitle(title, url): does this title need replacing? Combines a
  // length/pattern heuristic (ported from index.html's former genericTitle())
  // with an explicit platform-name/templated-generic blocklist and a
  // domain-equals-title check. This is the ONE canonical "bad title" check —
  // used by single/bulk refresh AND the Library Health "Title issues" tab.
  var GENERIC_TITLE_BLOCKLIST = {
    "facebook": 1, "instagram": 1, "pinterest": 1, "twitter": 1, "x": 1,
    "youtube": 1, "tiktok": 1, "reddit": 1, "no title": 1, "untitled": 1,
    "untitled pin page": 1
  };
  var GENERIC_TITLE_NOUN_RE = /^(facebook|fb|instagram|ig|pinterest|saved)?\s?(post|video|reel|photo|photos|story|link|watch|pin|item)s?$/i;
  var GENERIC_TITLE_PLATFORM_POST_RE = /^instagram post\b/i;
  var GENERIC_TITLE_POST_BY_RE = /^(facebook|instagram|pinterest)\s+post\s+by\b/i;
  function isGenericTitle(title, url) {
    var t = String(title == null ? "" : title).trim();
    if (!t) return true;
    if (t.length < 25) return true;
    if (/^\d+\s*(photo|video)s?\b/i.test(t)) return true;
    if (/^https?:\/\//i.test(t)) return true;
    var tl = t.toLowerCase();
    var dom = "";
    try { dom = new URL(String(url || "")).hostname.replace(/^www\./, "").toLowerCase(); } catch (e) { dom = ""; }
    if (dom && tl === dom) return true;
    if (GENERIC_TITLE_BLOCKLIST[tl]) return true;
    if (GENERIC_TITLE_NOUN_RE.test(tl)) return true;
    if (GENERIC_TITLE_PLATFORM_POST_RE.test(tl)) return true;
    if (GENERIC_TITLE_POST_BY_RE.test(tl)) return true;
    return false;
  }
```

Then add `isGenericTitle` to both export blocks at the bottom of the file:

```js
  var api = {
    isFavicon: isFavicon, isBadImg: isBadImg, isGenericTitle: isGenericTitle, hammingDist: hammingDist,
    captureable: captureable, captureableFb: captureableFb,
    needsCapture: needsCapture, needsRetry: needsRetry,
    needsFbCapture: needsFbCapture, fbMiss: fbMiss,
    titleMismatch: titleMismatch,
    isVerifiedDiscoveryResult: isVerifiedDiscoveryResult,
    isFreshDiscoveryItem: isFreshDiscoveryItem
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) {
    root.isFavicon = isFavicon;
    root.isBadImg = isBadImg;
    root.isGenericTitle = isGenericTitle;
    root.hammingDist = hammingDist;
    root.captureable = captureable;
    root.captureableFb = captureableFb;
    root.needsCapture = needsCapture;
    root.needsRetry = needsRetry;
    root.needsFbCapture = needsFbCapture;
    root.fbMiss = fbMiss;
    root.titleMismatch = titleMismatch;
    root.isVerifiedDiscoveryResult = isVerifiedDiscoveryResult;
    root.isFreshDiscoveryItem = isFreshDiscoveryItem;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tests/capture-state.test.js`
Expected: all tests print `passed`, `0 failed`.

- [ ] **Step 5: Copy the file byte-identical into `pwa/lib/capture-state.js`**

Run:
```bash
cp "web/lib/capture-state.js" "pwa/lib/capture-state.js"
```

- [ ] **Step 6: Verify the parity test still passes and run the full suite**

Run: `node tests/surface-parity.test.js && node tests/run.js`
Expected: both pass (parity test confirms the two files are identical; full suite green).

- [ ] **Step 7: Commit**

```bash
git add web/lib/capture-state.js pwa/lib/capture-state.js tests/capture-state.test.js
git commit -m "Add isGenericTitle() canonical bad-title predicate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Replace `genericTitle()` with `isGenericTitle()` at its 3 call sites

**Files:**
- Modify: `web/index.html` (lines ~2957, ~2965, ~3974, ~5661 — `genericTitle` definition + 3 call sites)
- Modify: `pwa/index.html` (mirrored: `genericTitle` definition + 3 call sites)
- Test: `tests/title-quality-wiring.test.js` (new)

**Interfaces:**
- Consumes: `isGenericTitle(title, url)` from Task 1 (already loaded via `<script src="lib/capture-state.js">`, which both files already include before their inline `<script>` block — no new script tag needed).
- Produces: nothing new consumed by later tasks; this task only removes `genericTitle` and repoints its 3 callers.

- [ ] **Step 1: Write the failing wiring test**

Create `tests/title-quality-wiring.test.js`:

```js
// tests/title-quality-wiring.test.js — card-title-quality feature wiring,
// checked structurally against both web/index.html and pwa/index.html
// (regex-based, matching the settings-wiring.test.js convention — these
// files have no build step, so we assert on the actual shipped source).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": the old genericTitle() function is gone", () => {
    assert.ok(!/function genericTitle\(/.test(src), "genericTitle() should be fully replaced by isGenericTitle()");
  });
  t(label + ": enrichPins uses isGenericTitle", () => {
    assert.match(src, /if\(m\.title && isGenericTitle\(p\.title, ?p\.url\)\) p\.title=m\.title\.slice\(0,250\);/);
  });
  t(label + ": enrichOnOpen's free re-fetch uses isGenericTitle", () => {
    assert.match(src, /if\(m\.title && m\.title\.length>10 && isGenericTitle\(it\.title, ?it\.url\)\)\{ it\.title=m\.title\.slice\(0,250\); changed=true; \}/);
  });
  t(label + ": addClip uses isGenericTitle", () => {
    assert.match(src, /if\(cap\.title && \(isNew \|\| isGenericTitle\(item\.title\|\|"", ?item\.url\)\)\) item\.title = cap\.title\.slice\(0,250\);/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/title-quality-wiring.test.js`
Expected: all 8 checks FAIL (nothing changed yet).

- [ ] **Step 3: Edit `web/index.html`**

Remove the old function (line 2957):
```
function genericTitle(t){ return t.length<25 || /^\d+\s*(photo|video)s?\b/i.test(t); }
```
(delete this line entirely — `isGenericTitle` from `web/lib/capture-state.js` replaces it)

Replace the 3 call sites:

`enrichPins` (was line 2965):
```js
    if(m.title && genericTitle(p.title)) p.title=m.title.slice(0,250);
```
→
```js
    if(m.title && isGenericTitle(p.title, p.url)) p.title=m.title.slice(0,250);
```

`enrichOnOpen` (was line 3974):
```js
          if(m.title && m.title.length>10 && genericTitle(it.title)){ it.title=m.title.slice(0,250); changed=true; }
```
→
```js
          if(m.title && m.title.length>10 && isGenericTitle(it.title, it.url)){ it.title=m.title.slice(0,250); changed=true; }
```

`addClip` (was line 5661):
```js
  if(cap.title && (isNew || genericTitle(item.title||""))) item.title = cap.title.slice(0,250);
```
→
```js
  if(cap.title && (isNew || isGenericTitle(item.title||"", item.url))) item.title = cap.title.slice(0,250);
```

- [ ] **Step 4: Make the identical edits in `pwa/index.html`**

Same 4 changes (remove `function genericTitle(t){...}` at its line ~3031; update the 3 call sites at their pwa line numbers — search for the same literal snippets, they're byte-identical to web's).

- [ ] **Step 5: Run the syntax gate and the wiring test**

Run: `node tests/syntax-check.js && node tests/title-quality-wiring.test.js`
Expected: syntax gate reports `0 errors`; all 8 wiring checks pass.

- [ ] **Step 6: Run the full suite**

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED` (confirms nothing that depended on `genericTitle`'s old behavior broke — there are no direct tests of `genericTitle` itself since it lived inline, only these new wiring checks).

- [ ] **Step 7: Commit**

```bash
git add web/index.html pwa/index.html tests/title-quality-wiring.test.js
git commit -m "Replace genericTitle() with the canonical isGenericTitle() everywhere

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: AI title-generation module (`web/title-ai.js`)

**Files:**
- Create: `web/title-ai.js`
- Create: `pwa/title-ai.js` (byte-identical copy)
- Modify: `web/index.html` (add `<script src="title-ai.js">` tag)
- Modify: `pwa/index.html` (add `<script src="title-ai.js">` tag)
- Modify: `tests/surface-parity-manifest.js` (add the new pair to `exactPairs`)
- Test: `tests/title-ai.test.js` (new)

**Interfaces:**
- Produces: `buildTitlePrompt({url, domain, description, avoidTitles}) -> string`, `parseTitleReply(text) -> string|null`. Exported via `module.exports` (Node) and `root.buildTitlePrompt`/`root.parseTitleReply` (browser) — same pattern as `web/deadcheck-ai.js`.
- Consumed by: Task 4's `generateUniqueTitle()`.

- [ ] **Step 1: Write the failing tests**

Create `tests/title-ai.test.js` (modeled directly on `tests/deadcheck-ai.test.js`):

```js
const assert = require("assert");
const t2 = require("../web/title-ai.js");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("buildTitlePrompt includes url, domain, description, and asks for <=8 words", () => {
  const p = t2.buildTitlePrompt({ url:"https://x.com/p/1", domain:"x.com", description:"A guide to backyard pizza ovens." });
  assert.ok(p.indexOf("https://x.com/p/1") >= 0);
  assert.ok(p.indexOf("x.com") >= 0);
  assert.ok(p.indexOf("A guide to backyard pizza ovens.") >= 0);
  assert.ok(/8 words/i.test(p));
});
t("buildTitlePrompt with no avoidTitles doesn't mention avoiding anything", () => {
  const p = t2.buildTitlePrompt({ url:"https://x.com/p/1", domain:"x.com", description:"desc" });
  assert.ok(!/do not reuse/i.test(p));
});
t("buildTitlePrompt with avoidTitles lists each one to avoid", () => {
  const p = t2.buildTitlePrompt({ url:"https://x.com/p/1", domain:"x.com", description:"desc", avoidTitles:["Backyard Pizza Oven Guide", "DIY Pizza Oven Build"] });
  assert.ok(/do not reuse/i.test(p));
  assert.ok(p.indexOf("Backyard Pizza Oven Guide") >= 0);
  assert.ok(p.indexOf("DIY Pizza Oven Build") >= 0);
});
t("parseTitleReply strips surrounding quotes and whitespace", () => {
  assert.strictEqual(t2.parseTitleReply('  "Backyard Pizza Oven Guide"  '), "Backyard Pizza Oven Guide");
});
t("parseTitleReply strips a leading 'Title:' label", () => {
  assert.strictEqual(t2.parseTitleReply("Title: Backyard Pizza Oven Guide"), "Backyard Pizza Oven Guide");
});
t("parseTitleReply takes only the first line", () => {
  assert.strictEqual(t2.parseTitleReply("Backyard Pizza Oven Guide\nHere's why: ..."), "Backyard Pizza Oven Guide");
});
t("parseTitleReply truncates to 8 words as a backstop", () => {
  assert.strictEqual(
    t2.parseTitleReply("This Is A Very Long Title With Way More Than Eight Words In It"),
    "This Is A Very Long Title With Way"
  );
});
t("parseTitleReply on empty/garbage -> null", () => {
  assert.strictEqual(t2.parseTitleReply(""), null);
  assert.strictEqual(t2.parseTitleReply("   "), null);
  assert.strictEqual(t2.parseTitleReply(null), null);
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/title-ai.test.js`
Expected: `Cannot find module '../web/title-ai.js'`.

- [ ] **Step 3: Create `web/title-ai.js`**

```js
// Pure helpers for AI card-title generation (dual browser/Node, like
// web/deadcheck-ai.js). The AI call itself reuses index.html's provider
// dispatch (IA_AI/callAI); these only build the prompt and parse the reply.
(function (root) {
  "use strict";

  // buildTitlePrompt({url, domain, description, avoidTitles}) — asks for
  // exactly one title, <=8 words, grounded in whatever context is available.
  // avoidTitles (0+ strings) are titles already taken in the library — only
  // populated on a uniqueness-collision retry (see generateUniqueTitle in
  // index.html), so the common case (first attempt) never mentions them.
  function buildTitlePrompt(info) {
    info = info || {};
    var url = String(info.url || "");
    var domain = String(info.domain || "");
    var description = String(info.description || "").slice(0, 1000);
    var avoidTitles = Array.isArray(info.avoidTitles) ? info.avoidTitles.filter(Boolean) : [];
    var lines = [
      "Write ONE short, descriptive, specific title for this saved web page, 8 words or fewer.",
      "No platform names (Facebook/Instagram/Pinterest/etc), no generic filler like \"Post\" or \"Video\" — describe the actual subject.",
      "",
      "URL: " + url,
      "Domain: " + domain,
      "Description: " + description
    ];
    if (avoidTitles.length) {
      lines.push("");
      lines.push("Do not reuse any of these exact titles (already used elsewhere in the library):");
      avoidTitles.forEach(function (a) { lines.push("- " + String(a)); });
    }
    lines.push("");
    lines.push("Return ONLY the title, no quotes, no explanation.");
    return lines.join("\n");
  }

  // parseTitleReply(text) — extract a single-line title: first line only,
  // strip a leading "Title:" label and surrounding quotes/whitespace, then
  // hard-truncate to 8 words as a backstop (the model's own instruction-
  // following can't be trusted to enforce the word limit). Returns null for
  // empty/whitespace-only input.
  function parseTitleReply(text) {
    var s = String(text == null ? "" : text).split("\n")[0];
    s = s.replace(/^\s*title\s*:\s*/i, "");
    s = s.replace(/^["'\s]+|["'\s]+$/g, "");
    if (!s) return null;
    var words = s.split(/\s+/);
    if (words.length > 8) s = words.slice(0, 8).join(" ");
    return s;
  }

  var api = { buildTitlePrompt: buildTitlePrompt, parseTitleReply: parseTitleReply };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) { root.buildTitlePrompt = buildTitlePrompt; root.parseTitleReply = parseTitleReply; }
})(typeof self !== "undefined" ? self : this);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node tests/title-ai.test.js`
Expected: all 8 pass, `0 failed`.

- [ ] **Step 5: Copy byte-identical into `pwa/title-ai.js`**

Run:
```bash
cp "web/title-ai.js" "pwa/title-ai.js"
```

- [ ] **Step 6: Add the script tag to both HTML files**

In `web/index.html`, find the existing `<script src="deadcheck-ai.js"></script>` (line ~473) and add right after it:
```html
<script src="title-ai.js"></script>
```

In `pwa/index.html`, find its `<script src="deadcheck-ai.js"></script>` (line ~512) and add right after it, identically:
```html
<script src="title-ai.js"></script>
```

- [ ] **Step 7: Add the new pair to the surface-parity manifest**

In `tests/surface-parity-manifest.js`, add a line to `exactPairs`:

```js
  exactPairs: [
    ["web/lib/capture-state.js", "pwa/lib/capture-state.js"],
    ["web/lib/import-parsers.js", "pwa/lib/import-parsers.js"],
    ["web/lib/urlkey.js", "pwa/lib/urlkey.js"],
    ["web/route-capture.js", "pwa/route-capture.js"],
    ["web/profile-analyze.js", "pwa/profile-analyze.js"],
    ["web/title-ai.js", "pwa/title-ai.js"],
  ],
```

- [ ] **Step 8: Run the syntax gate, parity test, and full suite**

Run: `node tests/syntax-check.js && node tests/surface-parity.test.js && node tests/run.js`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add web/title-ai.js pwa/title-ai.js web/index.html pwa/index.html tests/title-ai.test.js tests/surface-parity-manifest.js
git commit -m "Add title-ai.js: AI title-generation prompt builder + reply parser

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Uniqueness + `generateUniqueTitle()` orchestration

**Files:**
- Modify: `web/index.html` (add 3 new functions near `normTitle`, e.g. right after it at line ~4720)
- Modify: `pwa/index.html` (mirrored, near its `normTitle` at line ~4794)
- Test: `tests/title-quality-wiring.test.js` (extend from Task 2)

**Interfaces:**
- Consumes: `isGenericTitle` (Task 1), `buildTitlePrompt`/`parseTitleReply` (Task 3), `callAI`/`IA_AI.hasAIKey` (existing `web/ai.js`), `domain()` (existing, `web/index.html:973`), `imported`/`saved` (existing global arrays).
- Produces: `normalizeTitleKey(t) -> string`, `allTitleKeys(excludeId) -> Set<string>`, `generateUniqueTitle(card, extraAvoid) -> Promise<string|null>` — the last is consumed by Task 5 (single-card refresh) and Task 7 (Library Health tab).

This task can't be pure-unit-tested the way Tasks 1 and 3 were — `generateUniqueTitle` reaches into `imported`/`saved`/`callAI` which only exist inside the loaded page. It's covered structurally here (does the code exist, in the right shape) and behaviorally in Task 5's integration test (which extracts and executes it with mocked globals).

- [ ] **Step 1: Write the failing structural test**

Append to `tests/title-quality-wiring.test.js` (inside the existing `for (const [label, src] of ...)` loop, alongside the Task 2 checks):

```js
  t(label + ": normalizeTitleKey exists and normalizes case/whitespace", () => {
    assert.match(src, /function normalizeTitleKey\(t\)\{/);
  });
  t(label + ": allTitleKeys scans both imported and saved", () => {
    const m = /function allTitleKeys\(excludeId\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "allTitleKeys not found");
    assert.match(m[1], /imported\.forEach/);
    assert.match(m[1], /saved\.forEach/);
  });
  t(label + ": generateUniqueTitle retries up to 3 times on collision, then disambiguates", () => {
    const m = /async function generateUniqueTitle\(card, ?extraAvoid\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "generateUniqueTitle not found");
    assert.match(m[1], /attempt\s*<\s*3/, "should retry up to 3 times");
    assert.match(m[1], /buildTitlePrompt\(/);
    assert.match(m[1], /parseTitleReply\(/);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/title-quality-wiring.test.js`
Expected: the 3 new checks FAIL (nothing written yet); the Task 2 checks still pass.

- [ ] **Step 3: Add the 3 functions to `web/index.html`**

Insert immediately after `normTitle`'s closing brace (after line ~4720, before the `// Pick the member to KEEP` comment):

```js
// Exact-after-normalization title key for LIBRARY-WIDE UNIQUENESS. Deliberately
// NOT normTitle() (that's a lossy fuzzy-grouping key for the Duplicates tab —
// too aggressive for "must be unique", which needs a much lighter touch).
function normalizeTitleKey(t){ return String(t==null?"":t).toLowerCase().trim().replace(/\s+/g," "); }
// Every current title in the library (imported + saved), normalized, minus
// the card being (re)titled itself (so a card checking against its OWN
// current title doesn't spuriously collide with itself).
function allTitleKeys(excludeId){
  const keys = new Set();
  imported.forEach(c=>{ if(c && c.id!==excludeId && c.title) keys.add(normalizeTitleKey(c.title)); });
  saved.forEach(c=>{ if(c && c.id!==excludeId && c.title) keys.add(normalizeTitleKey(c.title)); });
  return keys;
}
// Generates a unique, non-generic AI title for one card (imported OR saved —
// both use .title; description is .desc for imported, .benefit for saved).
// Returns the title string, or null when generation isn't possible (no AI
// key, or there's no description AND no url — not enough signal for a
// meaningful title). extraAvoid: additional in-flight titles to avoid (the
// Library-Health "Suggest titles" batch flow passes the titles it already
// accepted earlier in the same run, so two suggestions can't collide with
// each other before either is saved).
async function generateUniqueTitle(card, extraAvoid){
  if(!IA_AI.hasAIKey()) return null;
  const description = card.desc || card.benefit || "";
  if(!description && !card.url) return null;
  const dom = domain(card.url)||"";
  const existing = allTitleKeys(card.id);
  (extraAvoid||[]).forEach(t=>existing.add(normalizeTitleKey(t)));
  let avoidTitles = [];
  for(let attempt=0; attempt<3; attempt++){
    let reply;
    try{ reply = await callAI(buildTitlePrompt({url:card.url, domain:dom, description, avoidTitles})); }
    catch(e){ console.warn("AI title generation failed", e); return null; }
    const candidate = parseTitleReply(reply);
    if(!candidate) continue;
    const key = normalizeTitleKey(candidate);
    if(!existing.has(key)) return candidate;
    avoidTitles = avoidTitles.concat([candidate]).slice(-3);
  }
  // Still colliding after 3 tries: disambiguate with the domain, then a numeric suffix.
  const last = avoidTitles[avoidTitles.length-1] || (dom || "Untitled");
  let disambiguated = dom ? (last+" — "+dom) : last;
  if(!existing.has(normalizeTitleKey(disambiguated))) return disambiguated;
  let n=2;
  while(existing.has(normalizeTitleKey(disambiguated+" ("+n+")"))) n++;
  return disambiguated+" ("+n+")";
}
```

- [ ] **Step 4: Make the identical edit in `pwa/index.html`**

Same 3 functions, inserted right after `pwa/index.html`'s own `normTitle` (line ~4794).

- [ ] **Step 5: Run the syntax gate and wiring test**

Run: `node tests/syntax-check.js && node tests/title-quality-wiring.test.js`
Expected: syntax gate `0 errors`; all checks (Task 2's + Task 4's) pass.

- [ ] **Step 6: Run the full suite**

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED`.

- [ ] **Step 7: Commit**

```bash
git add web/index.html pwa/index.html tests/title-quality-wiring.test.js
git commit -m "Add generateUniqueTitle(): library-wide uniqueness + collision retry

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Wire AI title generation into single-card refresh (`enrichOnOpen`)

**Files:**
- Modify: `tests/_extract.js` (extend `extractFn`'s regex to also match `async function`)
- Modify: `web/index.html:4003-4009` area (inside `enrichOnOpen`)
- Modify: `pwa/index.html` (mirrored, inside its `enrichOnOpen`)
- Test: `tests/title-quality-wiring.test.js` (extend)
- Test: `tests/title-quality-integration.test.js` (new — behavioral test with mocked globals)

**Interfaces:**
- Consumes: `isGenericTitle` (Task 1), `generateUniqueTitle` (Task 4).
- Produces: nothing new for later tasks (this is a leaf integration point).

- [ ] **Step 1: Extend `extractFn` to support `async function` declarations**

`generateUniqueTitle` (Task 4) is declared as `async function generateUniqueTitle(card, extraAvoid){` — but `tests/_extract.js`'s current regex only matches declarations starting with the literal text `function NAME` right after a newline, so it can't find an `async function` declaration (the word `async ` sits between the newline and `function`). Verify this is really the gap before touching anything:

```bash
node -e '
const { extractFn } = require("./tests/_extract.js");
const fs = require("fs");
const html = fs.readFileSync("web/index.html", "utf8");
console.log(extractFn(html, "restoreDupeSafetySnapshot"));   // an existing async function
'
```
Expected: prints `null` — confirming the gap (this existing async function in the codebase can't be extracted either, today).

Open `tests/_extract.js` and find:
```js
  const declRe = new RegExp("(?:^|\\n)(function " + name + "\\b[^{]*)\\{", "m");
```
Change it to:
```js
  const declRe = new RegExp("(?:^|\\n)((?:async\\s+)?function " + name + "\\b[^{]*)\\{", "m");
```
(The `(?:async\\s+)?` is optional, so every existing non-async caller of `extractFn`/`loadFns` keeps matching exactly as before — this only adds a new case, doesn't change any existing one.)

- [ ] **Step 2: Verify the fix, and that nothing existing regressed**

```bash
node -e '
const { extractFn } = require("./tests/_extract.js");
const fs = require("fs");
const html = fs.readFileSync("web/index.html", "utf8");
console.log("async fn now found:", !!extractFn(html, "restoreDupeSafetySnapshot"));
console.log("plain fn still found:", !!extractFn(html, "mergeDupeMetadata"));
'
```
Expected: both lines print `true`.

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED` (confirms `capture-wiring.test.js`, `durability.test.js`, `ext-matchkey.test.js`, `instagram-capture.test.js`, and `duplicate-review-mode.test.js` — the 5 files that depend on `_extract.js` — still pass unchanged).

- [ ] **Step 3: Commit the extractFn fix on its own**

```bash
git add tests/_extract.js
git commit -m "extractFn: also match async function declarations

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 4: Write the failing structural test**

Append to `tests/title-quality-wiring.test.js`:

```js
  t(label + ": enrichOnOpen calls generateUniqueTitle automatically when still generic", () => {
    const start = src.indexOf("async function enrichOnOpen(");
    const end = src.indexOf("\nif(changed){", start) >= 0 ? src.indexOf("\nif(changed){", start) : src.indexOf("    if(changed){", start);
    assert.ok(start >= 0 && end > start, "enrichOnOpen not found");
    const body = src.slice(start, end);
    assert.match(body, /isGenericTitle\(it\.title, ?it\.url\)/, "should re-check isGenericTitle after the free re-fetch");
    assert.match(body, /generateUniqueTitle\(it\)/, "should call generateUniqueTitle for a still-generic title");
  });
```

- [ ] **Step 5: Run it to verify it fails**

Run: `node tests/title-quality-wiring.test.js`
Expected: the new check FAILs (2 occurrences: web + pwa).

- [ ] **Step 6: Edit `web/index.html`'s `enrichOnOpen`**

Find the existing AI-description block (right before `if(changed){` near line 4009):

```js
    if(!it.desc && IA_AI.hasAIKey()){
      try{
        const text = await callAI(`Write ONE short sentence (under 20 words) describing what this saved item likely is: "${it.title}". No platform names, no filler — start with the substance. Return ONLY the sentence, no quotes.`);
        const d=text.replace(/^["'\s]+|["'\s]+$/g,"").trim();
        if(d.length>10 && d.length<250){ it.desc=d; changed=true; }
      }catch(e){ console.warn("AI desc failed",e); }
    }
    if(changed){
```

Insert a new block between them (after the desc block, before `if(changed){`), so the title generation has the freshest `.desc` to work from:

```js
    if(!it.desc && IA_AI.hasAIKey()){
      try{
        const text = await callAI(`Write ONE short sentence (under 20 words) describing what this saved item likely is: "${it.title}". No platform names, no filler — start with the substance. Return ONLY the sentence, no quotes.`);
        const d=text.replace(/^["'\s]+|["'\s]+$/g,"").trim();
        if(d.length>10 && d.length<250){ it.desc=d; changed=true; }
      }catch(e){ console.warn("AI desc failed",e); }
    }
    if(isGenericTitle(it.title, it.url)){
      try{
        const suggested = await generateUniqueTitle(it);
        if(suggested){ it.title=suggested; changed=true; }
      }catch(e){ console.warn("AI title generation failed",e); }
    }
    if(changed){
```

- [ ] **Step 7: Make the identical edit in `pwa/index.html`**

Same insertion, in `pwa/index.html`'s own `enrichOnOpen` (its desc-AI block is byte-identical to web's).

- [ ] **Step 8: Run the syntax gate and wiring test**

Run: `node tests/syntax-check.js && node tests/title-quality-wiring.test.js`
Expected: both green.

- [ ] **Step 9: Write the behavioral integration test**

Create `tests/title-quality-integration.test.js` — extracts `generateUniqueTitle` (plus its 2 small helper functions) from `web/index.html` via the existing `extractFn` utility, wires up minimal mocks for the globals it reaches into (`imported`, `saved`, `IA_AI`, `callAI`, `domain`, `buildTitlePrompt`, `parseTitleReply`), and exercises the real retry/collision/disambiguation logic end-to-end with a scripted fake AI:

```js
// tests/title-quality-integration.test.js — behavioral test of
// generateUniqueTitle()'s uniqueness/collision-retry logic, extracted from
// the real web/index.html source (not reimplemented) and run against a
// scripted fake AI provider. Mirrors the extraction technique
// tests/duplicate-review-mode.test.js already uses for self-contained
// inline-script functions.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");
const { buildTitlePrompt, parseTitleReply } = require("../web/title-ai.js");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");

function loadTitleFns(aiReplies) {
  // aiReplies: array of strings, one per callAI invocation, consumed in order.
  let callCount = 0;
  const domain = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } };
  const callAI = async () => { const r = aiReplies[callCount]; callCount++; if (r instanceof Error) throw r; return r; };
  const IA_AI = { hasAIKey: () => true };
  const sandbox = { imported: [], saved: [], buildTitlePrompt, parseTitleReply, domain, callAI, IA_AI, console };
  const src = [
    extractFn(html, "normalizeTitleKey"),
    extractFn(html, "allTitleKeys"),
    extractFn(html, "generateUniqueTitle"),
  ].join("\n");
  // eval in a function scope closed over `sandbox`'s properties as locals —
  // matches loadFns' approach (_extract.js) but with our own controlled globals.
  const factory = new Function(
    "imported", "saved", "buildTitlePrompt", "parseTitleReply", "domain", "callAI", "IA_AI",
    src + "\nreturn { normalizeTitleKey, allTitleKeys, generateUniqueTitle };"
  );
  return { fns: factory(sandbox.imported, sandbox.saved, sandbox.buildTitlePrompt, sandbox.parseTitleReply, sandbox.domain, sandbox.callAI, sandbox.IA_AI), sandbox, callCountRef: () => callCount };
}

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.stack || e)); } }

(async () => {
  await t("generateUniqueTitle returns the AI's title when it's unique on the first try", async () => {
    const { fns, sandbox } = loadTitleFns(["Backyard Pizza Oven Build Guide"]);
    sandbox.imported.push({ id: "a", title: "Some Other Existing Descriptive Title", url: "https://x.com/a" });
    const result = await fns.generateUniqueTitle({ id: "b", desc: "A guide to pizza ovens", url: "https://x.com/pizza" });
    assert.strictEqual(result, "Backyard Pizza Oven Build Guide");
  });

  await t("generateUniqueTitle retries with avoidTitles when the AI's first pick collides", async () => {
    const { fns, sandbox, callCountRef } = loadTitleFns(["Backyard Pizza Oven Guide", "Outdoor Wood-Fired Oven Plans"]);
    sandbox.imported.push({ id: "existing", title: "Backyard Pizza Oven Guide", url: "https://x.com/existing" });
    const result = await fns.generateUniqueTitle({ id: "new", desc: "pizza oven", url: "https://x.com/new" });
    assert.strictEqual(result, "Outdoor Wood-Fired Oven Plans");
    assert.strictEqual(callCountRef(), 2, "should have retried exactly once");
  });

  await t("generateUniqueTitle disambiguates with the domain after 3 straight collisions", async () => {
    const { fns, sandbox } = loadTitleFns(["Same Title Every Time", "Same Title Every Time", "Same Title Every Time"]);
    sandbox.imported.push({ id: "existing", title: "Same Title Every Time", url: "https://x.com/existing" });
    const result = await fns.generateUniqueTitle({ id: "new", desc: "d", url: "https://pizza-blog.example.com/new" });
    assert.strictEqual(result, "Same Title Every Time — pizza-blog.example.com");
  });

  await t("generateUniqueTitle appends a numeric suffix if even the disambiguated title collides", async () => {
    const { fns, sandbox } = loadTitleFns(["Same Title Every Time", "Same Title Every Time", "Same Title Every Time"]);
    sandbox.imported.push({ id: "existing1", title: "Same Title Every Time", url: "https://x.com/e1" });
    sandbox.imported.push({ id: "existing2", title: "Same Title Every Time — pizza-blog.example.com", url: "https://x.com/e2" });
    const result = await fns.generateUniqueTitle({ id: "new", desc: "d", url: "https://pizza-blog.example.com/new" });
    assert.strictEqual(result, "Same Title Every Time — pizza-blog.example.com (2)");
  });

  await t("generateUniqueTitle returns null when there's no AI key", async () => {
    const { fns, sandbox } = loadTitleFns([]);
    sandbox.IA_AI.hasAIKey = () => false;
    const result = await fns.generateUniqueTitle({ id: "new", desc: "d", url: "https://x.com/new" });
    assert.strictEqual(result, null);
  });

  await t("generateUniqueTitle returns null when there's no description AND no url", async () => {
    const { fns } = loadTitleFns([]);
    const result = await fns.generateUniqueTitle({ id: "new", desc: "", url: "" });
    assert.strictEqual(result, null);
  });

  await t("generateUniqueTitle checks extraAvoid (in-flight batch titles) alongside the library", async () => {
    const { fns } = loadTitleFns(["A Title Already Suggested This Batch", "A Genuinely Different New Title"]);
    const result = await fns.generateUniqueTitle(
      { id: "new", desc: "d", url: "https://x.com/new" },
      ["A Title Already Suggested This Batch"]
    );
    assert.strictEqual(result, "A Genuinely Different New Title");
  });

  console.log(pass + " passed, " + fail + " failed");
  process.exitCode = fail ? 1 : 0;
})();
```

- [ ] **Step 10: Run it to verify it passes**

Run: `node tests/title-quality-integration.test.js`
Expected: all 7 pass, `0 failed`. (If `extractFn` can't find one of the 3 functions, double-check Task 4's functions were inserted with the exact signatures `function normalizeTitleKey(t){`, `function allTitleKeys(excludeId){`, `async function generateUniqueTitle(card, extraAvoid){` — and that Step 1's `extractFn` fix landed, since `generateUniqueTitle` needs the `async`-aware regex.)

- [ ] **Step 11: Run the full suite**

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED`.

- [ ] **Step 12: Commit**

```bash
git add web/index.html pwa/index.html tests/title-quality-wiring.test.js tests/title-quality-integration.test.js
git commit -m "Wire AI title generation into single-card refresh (enrichOnOpen)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Bulk refresh — use `isGenericTitle` (no AI)

**Files:**
- Modify: `web/index.html:4041` (`applyCaptureResult`) and `web/index.html:5542` (`drainCaptures`)
- Modify: `pwa/index.html` (mirrored: `applyCaptureResult` line ~4108+7, `drainCaptures` line ~5618)
- Test: `tests/title-quality-wiring.test.js` (extend)

**Interfaces:**
- Consumes: `isGenericTitle` (Task 1).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing structural test**

Append to `tests/title-quality-wiring.test.js`:

```js
  t(label + ": bulk applyCaptureResult uses isGenericTitle instead of the old blank-or-domain gate", () => {
    assert.match(src, /if\(r\.title && isGenericTitle\(c\.title, ?c\.url\)\) c\.title=r\.title;/);
  });
  t(label + ": drainCaptures uses isGenericTitle instead of the 'Saved/From your' prefix gate", () => {
    assert.match(src, /if\(cap\.title && \(force \|\| isGenericTitle\(match\.title, ?match\.url\)\)\)\{ match\.title=cap\.title; changed=true; \}/);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/title-quality-wiring.test.js`
Expected: the 2 new checks FAIL (2 occurrences each: web + pwa).

- [ ] **Step 3: Edit `web/index.html`**

`applyCaptureResult` (line 4041):
```js
  const dom=domain(c.url)||"";
  if(r.title && (!c.title || c.title===dom)) c.title=r.title;
```
→
```js
  if(r.title && isGenericTitle(c.title, c.url)) c.title=r.title;
```

(`isGenericTitle` takes `c.url` directly, so the `const dom=domain(c.url)||"";` local — only ever used by the old condition — is now dead. Delete that line along with the condition it fed; confirm no other line in `applyCaptureResult` references `dom` before deleting, per this task's own Global-Constraints-level expectation of no dead code.)

`drainCaptures` (line 5542):
```js
      if(cap.title && (force || /^saved\b|^from your\b/i.test(match.title||""))){ match.title=cap.title; changed=true; }
```
→
```js
      if(cap.title && (force || isGenericTitle(match.title, match.url))){ match.title=cap.title; changed=true; }
```

- [ ] **Step 4: Make the identical edits in `pwa/index.html`**

Same 2 replacements at `pwa/index.html`'s `applyCaptureResult` (including deleting its now-dead `const dom=domain(c.url)||"";` line) and `drainCaptures`.

- [ ] **Step 5: Run the syntax gate and wiring test**

Run: `node tests/syntax-check.js && node tests/title-quality-wiring.test.js`
Expected: both green.

- [ ] **Step 6: Run the full suite**

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED`. (Confirmed during plan-writing: no existing test file asserts on the old `/^saved\b|^from your\b/i` gate text, so no other test should need updating here.)

- [ ] **Step 7: Commit**

```bash
git add web/index.html pwa/index.html tests/title-quality-wiring.test.js
git commit -m "Bulk refresh: use isGenericTitle instead of ad hoc title gates

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Library Health "Title issues" tab

**Files:**
- Modify: `web/index.html` (`HEALTH_TABS`, `_healthCounts`, `healthTabStripHTML`, `renderHealth`, + 3 new functions near `renderHealthNoLink`)
- Modify: `pwa/index.html` (mirrored)
- Test: `tests/title-quality-wiring.test.js` (extend)

**Interfaces:**
- Consumes: `isGenericTitle` (Task 1), `generateUniqueTitle` (Task 4), existing `dupeThumb`, `attachCardImages`, `esc`, `domain`, `showBusyOverlay`/`updateBusyOverlay`/`hideBusyOverlay`, `IA_AI.hasAIKey`, `PROVIDERS`, `persistCards`, `Store.putSaved`.
- Produces: nothing new for later tasks (this is the feature's UI surface).

- [ ] **Step 1: Write the failing structural test**

Append to `tests/title-quality-wiring.test.js`:

```js
  t(label + ": HEALTH_TABS includes the Title issues tab", () => {
    assert.match(src, /\{\s*id:"titles",\s*label:"Title issues"\s*\}/);
  });
  t(label + ": _healthCounts reports a titles count from both imported and saved", () => {
    const m = /function _healthCounts\(\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "_healthCounts not found");
    assert.match(m[1], /isGenericTitle\(i\.title,\s*i\.url\)/);
    assert.match(m[1], /saved\.filter/);
    assert.match(m[1], /titles:/);
  });
  t(label + ": renderHealth dispatches the titles tab", () => {
    assert.match(src, /if\(tab==="titles"\) return renderHealthTitles\(list\);/);
  });
  t(label + ": renderHealthTitles lists flagged imported AND saved cards", () => {
    const m = /function flaggedTitleCards\(\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "flaggedTitleCards not found");
    assert.match(m[1], /imported\.forEach/);
    assert.match(m[1], /saved\.forEach/);
  });
  t(label + ": suggestTitlesForFlagged generates sequentially and tracks accepted titles to avoid within the batch", () => {
    const m = /async function suggestTitlesForFlagged\(\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "suggestTitlesForFlagged not found");
    assert.match(m[1], /generateUniqueTitle\(m\.card, ?acceptedThisBatch\)/);
  });
  t(label + ": applyTitleSuggestions persists via persistCards/Store.putSaved (not {confirm:true} — an edit, not a removal)", () => {
    const m = /function applyTitleSuggestions\(\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "applyTitleSuggestions not found");
    assert.match(m[1], /persistCards\(\);/);
    assert.match(m[1], /Store\.putSaved\(saved\);/);
    assert.doesNotMatch(m[1], /\{confirm:\s*true\}/);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node tests/title-quality-wiring.test.js`
Expected: the 6 new checks FAIL (2 occurrences each).

- [ ] **Step 3: Edit `web/index.html` — `HEALTH_TABS`**

```js
const HEALTH_TABS = [
  { id:"dupes",  label:"Duplicates" },
  { id:"dead",   label:"Dead & unsafe" },
  { id:"failed", label:"Failed captures" },
  { id:"nolink", label:"No link" },
];
```
→
```js
const HEALTH_TABS = [
  { id:"dupes",  label:"Duplicates" },
  { id:"dead",   label:"Dead & unsafe" },
  { id:"failed", label:"Failed captures" },
  { id:"nolink", label:"No link" },
  { id:"titles", label:"Title issues" },
];
```

- [ ] **Step 4: Edit `web/index.html` — `_healthCounts` and `healthTabStripHTML`**

```js
function _healthCounts(){
  const nolink = imported.filter(i=>!i.url).length;
  const failed = imported.filter(needsRetry).length;
  return { nolink, failed };
}
function healthTabStripHTML(){
  const c = _healthCounts();
  const badge = { failed:c.failed, nolink:c.nolink };
```
→
```js
function _healthCounts(){
  const nolink = imported.filter(i=>!i.url).length;
  const failed = imported.filter(needsRetry).length;
  const titles = imported.filter(i=>isGenericTitle(i.title,i.url)).length + saved.filter(i=>isGenericTitle(i.title,i.url)).length;
  return { nolink, failed, titles };
}
function healthTabStripHTML(){
  const c = _healthCounts();
  const badge = { failed:c.failed, nolink:c.nolink, titles:c.titles };
```

- [ ] **Step 5: Edit `web/index.html` — `renderHealth` dispatcher**

```js
  if(tab==="dupes")  return renderHealthDupes(list);
  if(tab==="dead")   return renderHealthDead(list);
  if(tab==="failed") return renderHealthFailed(list);
  if(tab==="nolink") return renderHealthNoLink(list);
}
```
→
```js
  if(tab==="dupes")  return renderHealthDupes(list);
  if(tab==="dead")   return renderHealthDead(list);
  if(tab==="failed") return renderHealthFailed(list);
  if(tab==="nolink") return renderHealthNoLink(list);
  if(tab==="titles") return renderHealthTitles(list);
}
```

- [ ] **Step 6: Add the 4 new functions to `web/index.html`, right after `renderHealthNoLink`/`groomNoLink`**

`renderHealthNoLink` ends at (was) line 5002 with `attachCardImages();\n}`. Insert immediately after that closing brace (i.e. between `renderHealthNoLink` and the `// Find duplicate groups` comment that precedes `scanDuplicates`):

```js
// ---- Title issues tab ----
// Every card (imported OR saved) whose title is missing/generic/platform-only.
function flaggedTitleCards(){
  const out=[];
  imported.forEach(c=>{ if(c && isGenericTitle(c.title,c.url)) out.push({scope:"imported", card:c}); });
  saved.forEach(c=>{ if(c && isGenericTitle(c.title,c.url)) out.push({scope:"saved", card:c}); });
  return out;
}
// {scope:id -> suggested title string} for cards awaiting review after
// "Suggest titles". Cleared on Apply, Cancel, or leaving the tab.
let _titleSuggestions = {};
function renderHealthTitles(list){
  const flagged = flaggedTitleCards();
  if(!flagged.length){ list.innerHTML = `<div class="s" style="padding:14px 4px">Every card has a clear, descriptive title. Nothing to fix.</div>`; _titleSuggestions={}; return; }
  const hasSuggestions = Object.keys(_titleSuggestions).length>0;
  list.innerHTML = `
    <div class="s" style="opacity:.75;padding:2px 4px 10px">${flagged.length} card${flagged.length>1?"s have":" has"} a missing, generic, or platform-only title.${hasSuggestions?" Review the suggested titles below, uncheck any you don't want, then Apply.":" Check the ones to fix, then Suggest titles."}</div>
    ${flagged.map(m=>{
      const it=m.card, dom=domain(it.url)||"";
      const key=m.scope+":"+it.id;
      const suggestion=_titleSuggestions[key];
      return `<div class="dupe-row" data-title-key="${esc(key)}">${dupeThumb(m)}
        <div class="meta"><div class="t">${esc(it.title||"(untitled)")}</div>
          <div class="s">${esc(dom||"no link")} · <span class="dupe-badge">${m.scope==="saved"?"Saved":"Imported"}</span></div>
          ${suggestion!=null ? `<input type="text" class="title-suggest-input" value="${esc(suggestion)}" style="margin-top:6px;width:100%">` : ""}
        </div>
        ${suggestion==null
          ? `<label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" data-title-sel checked style="width:auto"> include</label>`
          : `<label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" data-title-apply checked style="width:auto"> apply</label>`}
      </div>`;
    }).join("")}
    <div class="dupe-foot" style="justify-content:flex-start;border-top:0;padding-top:4px;gap:8px">
      ${hasSuggestions
        ? `<button class="btn btn-primary" onclick="applyTitleSuggestions()">Apply</button><button class="btn btn-ghost" onclick="_titleSuggestions={};renderHealthTitles(document.getElementById('healthList'));">Cancel</button>`
        : `<button class="btn btn-primary" onclick="suggestTitlesForFlagged()">Suggest titles</button>`}
    </div>`;
  attachCardImages();
}
async function suggestTitlesForFlagged(){
  const rows = document.querySelectorAll('#healthBody .dupe-row[data-title-key]');
  const checkedRows = Array.prototype.filter.call(rows, row=>{ const cb=row.querySelector('input[data-title-sel]'); return cb && cb.checked; });
  if(!checkedRows.length){ toast("Select at least one card"); return; }
  if(!IA_AI.hasAIKey()){ toast("Add your "+PROVIDERS[S.provider].keyName+" in Settings first"); return; }
  const ids = new Set(checkedRows.map(row=>row.getAttribute("data-title-key")));
  const flagged = flaggedTitleCards().filter(m=>ids.has(m.scope+":"+m.card.id));
  showBusyOverlay("Suggesting titles… 0/"+flagged.length);
  await new Promise(resolve=>requestAnimationFrame(resolve));
  const acceptedThisBatch=[];
  let done=0;
  for(const m of flagged){
    updateBusyOverlay("Suggesting titles… "+done+"/"+flagged.length);
    try{
      const suggestion = await generateUniqueTitle(m.card, acceptedThisBatch);
      if(suggestion){ _titleSuggestions[m.scope+":"+m.card.id]=suggestion; acceptedThisBatch.push(suggestion); }
    }catch(e){ console.warn("title suggestion failed", e); }
    done++;
  }
  hideBusyOverlay();
  if(_healthTab==="titles") renderHealthTitles(document.getElementById("healthList"));
  toast(acceptedThisBatch.length ? "Suggested "+acceptedThisBatch.length+" title"+(acceptedThisBatch.length===1?"":"s")+" — review below" : "Couldn't suggest any titles (check your AI key/credits)", 6000);
}
function applyTitleSuggestions(){
  const rows = document.querySelectorAll('#healthBody .dupe-row[data-title-key]');
  const byImported={}, bySaved={};
  imported.forEach(c=>{ if(c) byImported[c.id]=c; });
  saved.forEach(c=>{ if(c) bySaved[c.id]=c; });
  let applied=0;
  rows.forEach(row=>{
    const input=row.querySelector('input.title-suggest-input');
    const checkbox=row.querySelector('input[data-title-apply]');
    if(!input || !checkbox || !checkbox.checked) return;
    const key=row.getAttribute("data-title-key");
    const i=key.indexOf(":"); const scope=key.slice(0,i), id=key.slice(i+1);
    const val=input.value.trim(); if(!val) return;
    const card=scope==="saved"?bySaved[id]:byImported[id];
    if(!card) return;
    card.title=val.slice(0,250);
    applied++;
  });
  _titleSuggestions={};
  if(applied){ persistCards(); Store.putSaved(saved); toast("Updated "+applied+" title"+(applied===1?"":"s")); }
  if(_healthTab==="titles") renderHealthTitles(document.getElementById("healthList"));
}
```

- [ ] **Step 7: Also clear `_titleSuggestions` in `closeHealth()` and `healthSwitch()`**

So stale in-progress suggestions from a previous open don't leak into a later session. Find `closeHealth`:
```js
function closeHealth(){
  _dupeFullScreen = false;
  document.getElementById("healthModal").classList.remove("open","dupe-fullscreen");
  _dupeGroups = []; _deadList = []; _failModalList = []; _failStatus = {}; _healthScanned = {};
}
```
→
```js
function closeHealth(){
  _dupeFullScreen = false;
  document.getElementById("healthModal").classList.remove("open","dupe-fullscreen");
  _dupeGroups = []; _deadList = []; _failModalList = []; _failStatus = {}; _healthScanned = {}; _titleSuggestions = {};
}
```

And `healthSwitch`:
```js
function healthSwitch(tab){ if(tab===_healthTab) return; if(tab!=="dupes") dupeSetFullscreen(false); _healthTab = tab; renderHealth(); }
```
→
```js
function healthSwitch(tab){ if(tab===_healthTab) return; if(tab!=="dupes") dupeSetFullscreen(false); _titleSuggestions = {}; _healthTab = tab; renderHealth(); }
```

- [ ] **Step 8: Make all of Steps 3-7's edits identically in `pwa/index.html`**

Same `HEALTH_TABS` entry, `_healthCounts`/`healthTabStripHTML` changes, `renderHealth` dispatch line, the 4 new functions (inserted after `pwa/index.html`'s own `renderHealthNoLink`), and the `closeHealth`/`healthSwitch` clears.

- [ ] **Step 9: Run the syntax gate and wiring test**

Run: `node tests/syntax-check.js && node tests/title-quality-wiring.test.js`
Expected: both green — all checks from Tasks 2, 4, 5, 6, and 7 pass.

- [ ] **Step 10: Bump the PWA shell cache**

Find the current version in `pwa/sw.js`:
```bash
grep -n "SHELL_CACHE" pwa/sw.js
```
Increment it by 1 (e.g. if it's currently `interests-pwa-shell-v47`, change to `v48`) in `pwa/sw.js`:
```js
const SHELL_CACHE = "interests-pwa-shell-v48"; // bump on ANY edit to an already-cached
```
And update the matching assertion in `tests/duplicate-review-mode.test.js`:
```js
assert.match(sw, /SHELL_CACHE = "interests-pwa-shell-v48"/, "PWA cache must be bumped for the cached index edit");
```
(Use whatever the actual next version number is — check the current value first, don't assume v48.)

- [ ] **Step 11: Run the full suite**

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED`.

- [ ] **Step 12: Commit**

```bash
git add web/index.html pwa/index.html pwa/sw.js tests/title-quality-wiring.test.js tests/duplicate-review-mode.test.js
git commit -m "Add Library Health 'Title issues' tab: flag, suggest, review, apply

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Manual browser verification

**Files:** none (verification only)

**Interfaces:** none

- [ ] **Step 1: Start a sandboxed preview Core service**

Find your scratchpad directory path (the "Scratchpad Directory" section of your system prompt gives it verbatim). Write this file there as `preview-title-quality.js`, replacing `<REPO>` with this repo's absolute path (e.g. `D:\\Dropbox\\Documents\\Claude\\Projects\\Interests App`) and `<SCRATCHPAD>` with your scratchpad path:

```js
// Throwaway standalone Core service for browser preview only — pins backupDir
// to a throwaway folder so nothing ever touches the real Dropbox backups
// folder (see the 2026-07-23 incident earlier in this project's history for
// why that matters). Seeds cards with deliberately bad titles plus one
// control card with a good title.
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "ia-preview-ad-"));

const REPO = "<REPO>";
const { createServer } = require(path.join(REPO, "core", "server.js"));
const { buildContext } = require(path.join(REPO, "core", "appctx.js"));
const { upsertCard } = require(path.join(REPO, "core", "db.js"));

const previewBackupDir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-preview-backups-"));
fs.mkdirSync(path.join(process.env.APPDATA, "Interests App"), { recursive: true });
fs.writeFileSync(path.join(process.env.APPDATA, "Interests App", "config.json"), JSON.stringify({ backupDir: previewBackupDir }));

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ia-preview-store-"));
fs.mkdirSync(path.join(storeDir, "images"), { recursive: true });
const ctx = buildContext(storeDir);

const seeds = [
  { id: "c1", url: "https://example.test/blank", title: "", cat: "Saved", ts: 1 },
  { id: "c2", url: "https://facebook.com/somepage/posts/123", title: "Facebook", cat: "Saved", ts: 2 },
  { id: "c3", url: "https://www.instagram.com/reel/xyz/", title: "instagram.com", cat: "Saved", ts: 3 },
  { id: "c4", url: "https://example.test/short", title: "Short title", cat: "Saved", ts: 4 },
  { id: "c5", url: "https://example.test/good", title: "How to Build a Backyard Pizza Oven This Weekend", cat: "Saved", ts: 5 },
];
seeds.forEach(function (s) {
  upsertCard(ctx.db, { id: s.id, url: s.url, platform: "web", cat: s.cat, ts: s.ts, img: "", title: s.title, desc: "A page about " + s.id });
});

const app = createServer(ctx);
app.listen(3457, "127.0.0.1", () => console.log("preview Core service on http://127.0.0.1:3457 — " + seeds.length + " seed cards"));
```

Run it via `preview_start` with a `.claude/launch.json` config named e.g. `"title-quality-preview"` pointing `runtimeExecutable: "node"`, `runtimeArgs: ["<SCRATCHPAD>/preview-title-quality.js"]`, `port: 3457` (add this as a new entry alongside the repo's existing `interests-app` config, then remove it again after this task — it's a throwaway verification aid, not a permanent part of the repo).

If you want to test the AI-generation path (Steps 4), also configure a real provider key: after the server starts, `PUT /api/kv/ia_settings` with a JSON body containing at minimum `{"provider":"gemini","keys":{"gemini":"<a real key>"},"models":{"gemini":"gemini-2.5-flash"}}` (Gemini's free tier is the cheapest to test with) — or just skip straight to Step 5 if you don't have a key handy.

- [ ] **Step 2: Open it in the Browser pane and navigate to the Imported tab**

Use `preview_start`/`navigate` against `http://localhost:3457`. Confirm the seeded cards render.

- [ ] **Step 3: Open Library Health → Title issues**

Click into the Library Health modal, switch to the new "Title issues" tab. Confirm:
- the tab shows a count badge matching the number of deliberately-bad-titled seed cards
- the real 40-char descriptive-title control card does NOT appear in the list
- each flagged row shows the thumbnail, current (bad) title, and an "include" checkbox

- [ ] **Step 4: Click "Suggest titles" (requires a real AI key in the preview's seeded settings, or skip to Step 5 if none available)**

If an AI key is configured, confirm: a busy overlay appears with progress text, each flagged row gets an editable text input with a suggested title, and no two suggested titles are identical. Edit one suggestion, uncheck another, click Apply. Confirm: the edited title was saved as typed, the unchecked card's title is unchanged, and both cards drop off the Title issues list on the next render (since their titles no longer flag as generic — assuming your typed edit is >=25 chars and not on the blocklist).

- [ ] **Step 5: If no AI key is available, verify the free-refresh path instead**

Go to the Imported tab, find a card with a bad title, click its ⟳ refresh button. Confirm no errors in the console (`read_console_messages`) and that `enrichOnOpen` runs without throwing (title generation should no-op cleanly via the `!IA_AI.hasAIKey()` early return in `generateUniqueTitle`).

- [ ] **Step 6: Stop the preview server**

Use `preview_stop`.

- [ ] **Step 7: Report findings**

No commit for this task — it's verification only. If any issue is found, go back to the relevant earlier task, fix it there (with its own test update if the bug reveals a test gap), and re-run that task's steps 5 onward before returning here.

---

## Self-Review Notes

**Spec coverage:**
- §1 Detection → Task 1
- §2 AI generation → Task 3
- §3 Uniqueness → Task 4
- §4 Refresh integration (single-card automatic, bulk AI-free) → Tasks 5, 6
- §5 Library Health tab → Task 7
- Testing section → covered across every task (unit tests in 1/3, structural wiring tests accumulating in `title-quality-wiring.test.js` across 2/4/5/6/7, one dedicated behavioral integration test in Task 5, manual browser verification in Task 8)

**Plan-writing-time discovery:** verified empirically (not assumed) that `tests/_extract.js`'s `extractFn` couldn't match `async function` declarations — confirmed by running it against an existing async function in the codebase before writing Task 5's integration test. Task 5 now fixes this (Steps 1-3) before depending on it, with its own regression check against a known-working non-async case.

**Type/signature consistency check:** `isGenericTitle(title, url)` — same parameter order used in every call site across Tasks 2, 4 (inside `generateUniqueTitle`'s caller context via Task 5), 6, and 7. `generateUniqueTitle(card, extraAvoid)` — same signature in Task 4's definition, Task 5's single-card call (`generateUniqueTitle(it)`, `extraAvoid` omitted/undefined — matches `(extraAvoid||[])` handling `undefined` in Task 4's implementation), and Task 7's batch call (`generateUniqueTitle(m.card, acceptedThisBatch)`). `buildTitlePrompt`/`parseTitleReply` — same names and shapes in Task 3's module and Task 4's usage.
