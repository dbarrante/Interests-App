# "Analyze my library" → interest profile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Settings button that aggregates all cards, has the AI infer interest topics + an "About you" draft, lets the user review (checkbox chips + editable draft), and non-destructively populates `S.interests`/`S.about` — which the existing feed already consumes.

**Architecture:** A new pure, dual browser/Node module `web/profile-analyze.js` (aggregate → prompt → parse → merge) plus UI wiring in `web/index.html` (button + inline review panel) that reuses the existing AI provider dispatch and the Discover-style chips. No Core, endpoint, storage, or feed changes — one AI call, client-side.

**Tech Stack:** Plain JS (UMD module like `web/route-capture.js`); inline renderer JS. Tests: `tests/*.test.js` via `tests/run.js`; `tests/syntax-check.js`.

## Global Constraints

- Non-destructive: interests are append-only (case-insensitive de-dupe, never removed); About you is set only to the content the user reviewed/edited in the panel (pre-filled with their existing text). No card-store writes/deletes.
- One AI call regardless of library size (local aggregation caps the prompt). Key required → toast + return if missing.
- Reuse existing: provider dispatch `{anthropic:callAnthropic, openai:callOpenAI, gemini:callGemini, groq:callGroq, openrouter:callOpenRouter, local:callLocal}[S.provider]`; `esc`, `toast`, `save`, `S`, `imported`, `saved`, `PROVIDERS`.
- UMD pattern for the new module; `process.exitCode` (not `process.exit()`) in tests.
- `buildProfilePrompt` takes an optional `extraSources` arg (default `[]`) — the seam for a future Notion connector. Built but unused here.
- No new Core/endpoint/network/IPC/key surface → the heavy data-safety/electron-security reviews are NOT required for this feature.

---

### Task 1: Pure analysis module — `web/profile-analyze.js`

**Files:**
- Create: `web/profile-analyze.js`
- Test: `tests/profile-analyze.test.js`

**Interfaces produced** (on `module.exports` and the browser global):
- `summarizeLibrary(cards, opts?) -> { total, categories:[{name,count}], domains:[{name,count}], keywords:[{name,count}], tags:[{name,count}] }`
- `buildProfilePrompt(summary, { about, interests }, extraSources?) -> string`
- `parseProfileResult(text) -> { interests: string[], about: string }`
- `mergeInterests(existingCsv, picked) -> string`

- [ ] **Step 1: Write the failing test** — create `tests/profile-analyze.test.js`:

```js
const assert = require("assert");
const p = require("../web/profile-analyze");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("summarizeLibrary counts categories, domains, title keywords; tolerant of missing fields", () => {
  const s = p.summarizeLibrary([
    { title:"Best MIG welding tips", url:"https://weldingweb.com/x", category:"welding" },
    { title:"MIG welding for beginners", url:"https://youtube.com/y", category:"welding" },
    { title:"Drip irrigation guide", url:"https://gardenista.com/z", category:"gardening" },
    { /* junk */ },
    null
  ]);
  assert.strictEqual(s.total, 5);
  assert.strictEqual(s.categories[0].name, "welding");
  assert.strictEqual(s.categories[0].count, 2);
  assert.ok(s.domains.some(d => d.name === "weldingweb.com"));
  // "welding" appears in 2 titles -> top keyword; stopwords ("best","for","tips") excluded
  assert.ok(s.keywords.some(k => k.name === "welding" && k.count === 2));
  assert.ok(!s.keywords.some(k => k.name === "for" || k.name === "best"));
});
t("summarizeLibrary caps each list to top-N", () => {
  const cards = []; for (let i=0;i<100;i++) cards.push({ title:"t"+i, url:"https://d"+i+".com/", category:"c"+i });
  const s = p.summarizeLibrary(cards, { maxCategories:5, maxDomains:5, maxKeywords:5 });
  assert.strictEqual(s.categories.length, 5);
  assert.strictEqual(s.domains.length, 5);
});
t("summarizeLibrary counts tags when present, empty when absent", () => {
  const s = p.summarizeLibrary([{ title:"x", url:"https://a.com/", tags:["diy","tools"] }, { title:"y", url:"https://a.com/", tags:["diy"] }]);
  assert.ok(s.tags.some(g => g.name === "diy" && g.count === 2));
  const s2 = p.summarizeLibrary([{ title:"x", url:"https://a.com/" }]);
  assert.deepStrictEqual(s2.tags, []);
});
t("buildProfilePrompt embeds summary + asks for {interests,about} JSON; extraSources optional", () => {
  const prompt = p.buildProfilePrompt({ total:3, categories:[{name:"welding",count:2}], domains:[], keywords:[], tags:[] }, { about:"I tinker", interests:"welding" });
  assert.ok(prompt.indexOf("welding") >= 0);
  assert.ok(/interests/i.test(prompt) && prompt.indexOf('"about"') >= 0);
  assert.ok(prompt.indexOf("I tinker") >= 0);
});
t("buildProfilePrompt includes extra sources when given", () => {
  const prompt = p.buildProfilePrompt({ total:0 }, {}, [{ label:"Notion", text:"machine learning notes" }]);
  assert.ok(prompt.indexOf("Notion") >= 0 && prompt.indexOf("machine learning notes") >= 0);
});
t("parseProfileResult: plain JSON", () => {
  assert.deepStrictEqual(p.parseProfileResult('{"interests":["a","b"],"about":"hi"}'), { interests:["a","b"], about:"hi" });
});
t("parseProfileResult: fenced + prose, filters non-strings", () => {
  const r = p.parseProfileResult("Sure:\n```json\n{ \"interests\": [\"x\", 3, \" y \"], \"about\": \" me \" }\n```\n");
  assert.deepStrictEqual(r.interests, ["x","y"]);
  assert.strictEqual(r.about, "me");
});
t("parseProfileResult: garbage -> safe empty", () => {
  assert.deepStrictEqual(p.parseProfileResult("no json here"), { interests:[], about:"" });
});
t("mergeInterests appends, case-insensitive de-dupe, preserves existing", () => {
  assert.strictEqual(p.mergeInterests("welding, gardening", ["Welding", "drip irrigation"]), "welding, gardening, drip irrigation");
  assert.strictEqual(p.mergeInterests("", ["a","a","b"]), "a, b");
  assert.strictEqual(p.mergeInterests("x", []), "x");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/profile-analyze.test.js`
Expected: FAIL — `Cannot find module '../web/profile-analyze'`.

- [ ] **Step 3: Write minimal implementation** — create `web/profile-analyze.js`:

```js
// Pure helpers for "Analyze my library" (dual browser/Node, like web/route-capture.js):
// aggregate cards locally → build one AI prompt → parse the result → merge interests.
// No network, no DOM. buildProfilePrompt takes optional extraSources (the seam a future
// Notion connector plugs into); unused for now.
(function (root) {
  "use strict";

  var STOP = {};
  ("the a an and or of to in for on with how your you my is are was were this that these those best top vs from what why when where who which will can their his her its our about into over under more most just like get make made use using guide tips ideas ways things review reviews new howto").split(/\s+/).forEach(function (w) { STOP[w] = 1; });

  function topN(map, n) {
    var arr = Object.keys(map).map(function (k) { return { name: k, count: map[k] }; });
    arr.sort(function (a, b) { return b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
    return arr.slice(0, n);
  }
  function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch (e) { return ""; } }

  function summarizeLibrary(cards, opts) {
    opts = opts || {};
    var list = Array.isArray(cards) ? cards : [];
    var cat = {}, dom = {}, kw = {}, tag = {};
    for (var i = 0; i < list.length; i++) {
      var c = list[i]; if (!c) continue;
      var category = (typeof c.category === "string") ? c.category.trim() : "";
      if (category) cat[category] = (cat[category] || 0) + 1;
      var h = hostOf(c.url); if (h) dom[h] = (dom[h] || 0) + 1;
      var title = (typeof c.title === "string") ? c.title.toLowerCase() : "";
      var toks = title.split(/[^a-z0-9]+/);
      for (var j = 0; j < toks.length; j++) {
        var w = toks[j];
        if (w.length >= 3 && !STOP[w] && !/^\d+$/.test(w)) kw[w] = (kw[w] || 0) + 1;
      }
      if (Array.isArray(c.tags)) for (var k = 0; k < c.tags.length; k++) {
        var tg = (typeof c.tags[k] === "string") ? c.tags[k].trim() : "";
        if (tg) tag[tg] = (tag[tg] || 0) + 1;
      }
    }
    return {
      total: list.length,
      categories: topN(cat, opts.maxCategories || 40),
      domains: topN(dom, opts.maxDomains || 40),
      keywords: topN(kw, opts.maxKeywords || 60),
      tags: topN(tag, opts.maxTags || 40)
    };
  }

  function _fmt(arr) { return (arr || []).map(function (x) { return x.name + " (" + x.count + ")"; }).join(", "); }

  function buildProfilePrompt(summary, profile, extraSources) {
    summary = summary || {}; profile = profile || {};
    extraSources = Array.isArray(extraSources) ? extraSources : [];
    var lines = [
      "Analyze this person's saved-content library to infer what they're into, then propose an interest profile.",
      "",
      "LIBRARY SUMMARY (aggregated from " + (summary.total || 0) + " saved items):",
      "Top categories: " + _fmt(summary.categories),
      "Top sites: " + _fmt(summary.domains),
      "Common title keywords: " + _fmt(summary.keywords),
      "Top tags: " + _fmt(summary.tags)
    ];
    for (var i = 0; i < extraSources.length; i++) {
      var s = extraSources[i] || {};
      lines.push("", "ADDITIONAL SOURCE — " + (s.label || "source") + ":", String(s.text || "").slice(0, 4000));
    }
    lines.push(
      "",
      "Their CURRENT profile (build on it, do not just repeat it):",
      "About: " + (profile.about || "(empty)"),
      "Interests: " + (profile.interests || "(empty)"),
      "",
      'Return ONLY a JSON object: {"interests": [15-25 short topic strings, 2-5 words each, feed-able for finding articles/projects, drawn PRIMARILY from the library above with a FEW clearly-adjacent stretch topics, no duplicates], "about": "a 2-4 sentence first-person about-me describing their taste"}'
    );
    return lines.join("\n");
  }

  function parseProfileResult(text) {
    var s = String(text == null ? "" : text);
    var m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        var o = JSON.parse(m[0]);
        var interests = Array.isArray(o.interests)
          ? o.interests.filter(function (x) { return typeof x === "string" && x.trim(); }).map(function (x) { return x.trim(); })
          : [];
        var about = (typeof o.about === "string") ? o.about.trim() : "";
        return { interests: interests, about: about };
      } catch (e) { /* fall through */ }
    }
    return { interests: [], about: "" };
  }

  function mergeInterests(existingCsv, picked) {
    var existing = String(existingCsv == null ? "" : existingCsv).split(",").map(function (x) { return x.trim(); }).filter(Boolean);
    var seen = {}; existing.forEach(function (x) { seen[x.toLowerCase()] = 1; });
    var out = existing.slice();
    (Array.isArray(picked) ? picked : []).forEach(function (pp) {
      var v = String(pp == null ? "" : pp).trim(); if (!v) return;
      if (!seen[v.toLowerCase()]) { seen[v.toLowerCase()] = 1; out.push(v); }
    });
    return out.join(", ");
  }

  var api = { summarizeLibrary: summarizeLibrary, buildProfilePrompt: buildProfilePrompt, parseProfileResult: parseProfileResult, mergeInterests: mergeInterests };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) { root.summarizeLibrary = summarizeLibrary; root.buildProfilePrompt = buildProfilePrompt; root.parseProfileResult = parseProfileResult; root.mergeInterests = mergeInterests; }
})(typeof self !== "undefined" ? self : this);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/profile-analyze.test.js`
Expected: PASS — `10 passed, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add web/profile-analyze.js tests/profile-analyze.test.js
git commit -m "feat(profile): pure library-aggregation + prompt/parse/merge helpers"
```

---

### Task 2: UI wiring — `web/index.html`

**Files:**
- Modify: `web/index.html` (load script; button + review panel markup; handlers)
- Test: `tests/profile-wiring.test.js`

**Interfaces:**
- Consumes: `summarizeLibrary`, `buildProfilePrompt`, `parseProfileResult`, `mergeInterests` (Task 1); existing provider dispatch, `S`, `imported`, `saved`, `esc`, `toast`, `save`, `PROVIDERS`.
- Produces: `analyzeLibrary()`, `renderProfileChips()`, `toggleProfileTag(i)`, `acceptProfile()`, `cancelProfile()`; module vars `_profileTags`; DOM `analyzeLibBtn`, `profileReview`, `profileChips`, `profileAbout`.

- [ ] **Step 1: Write the failing test** — create `tests/profile-wiring.test.js`:

```js
const assert = require("assert");
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("loads profile-analyze.js and has the Analyze button + handler", () => {
  assert.ok(html.indexOf('src="profile-analyze.js"') >= 0);
  assert.ok(html.indexOf("function analyzeLibrary") >= 0);
  assert.ok(html.indexOf("summarizeLibrary(") >= 0);
  assert.ok(html.indexOf('id="profileReview"') >= 0);
});
t("accept writes interests + about via mergeInterests", () => {
  assert.ok(html.indexOf("function acceptProfile") >= 0);
  assert.ok(html.indexOf("mergeInterests(") >= 0);
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/profile-wiring.test.js`
Expected: FAIL — `src="profile-analyze.js"` not found.

- [ ] **Step 3a: Load the helper script**

Find this exact line in `web/index.html`:
```html
<script src="deadcheck-ai.js"></script>
```
Add immediately AFTER it:
```html
<script src="profile-analyze.js"></script>
```

- [ ] **Step 3b: Add the button + review panel**

Find this exact line (the interests textarea in the *Your interest profile* section):
```html
        <textarea id="interestList" style="min-height:120px"></textarea>
```
Add immediately AFTER it:
```html
        <div style="margin-top:12px">
          <button class="btn btn-ghost" id="analyzeLibBtn" onclick="analyzeLibrary()" title="Let your AI read your whole library and suggest interests + an About-you draft">&#129504; Analyze my library</button>
          <div id="profileReview" style="display:none;margin-top:12px;border:1px solid var(--line);border-radius:11px;padding:12px">
            <div class="s" style="opacity:.7;margin-bottom:8px">Topics from your library — uncheck any you don't want, edit the About-you draft, then Accept.</div>
            <div id="profileChips" class="tagwrap"></div>
            <label style="font-weight:600;display:block;margin-top:12px">About you (draft)</label>
            <textarea id="profileAbout" style="min-height:110px;width:100%"></textarea>
            <div style="display:flex;gap:8px;margin-top:10px">
              <button class="btn btn-primary" onclick="acceptProfile()">Accept</button>
              <button class="btn btn-ghost" onclick="cancelProfile()">Cancel</button>
            </div>
          </div>
        </div>
```

- [ ] **Step 3c: Add the handlers**

Find this exact line (end of the Discover feature's `addDiscovered`):
```js
  toast(add.length+" interest"+(add.length>1?"s":"")+" added to your profile");
}
```
Add immediately AFTER it (the closing `}` of `addDiscovered`):
```js
// ---- Analyze my library → interest profile (reuses the provider dispatch; chips like Discover;
// non-destructive: interests appended de-duped, About you = the reviewed/edited box) ----
let _profileTags = [];
async function analyzeLibrary(){
  if(!S.keys[S.provider] && S.provider!=="local"){ toast("Add your "+PROVIDERS[S.provider].keyName+" first"); showTab("settings"); return; }
  const all = imported.concat(saved);
  if(!all.length){ toast("No cards to analyze yet"); return; }
  const btn=document.getElementById("analyzeLibBtn");
  btn.disabled=true; btn.innerHTML='<span class="spin" style="border-color:#d8d2c8;border-top-color:var(--accent)"></span> Analyzing…';
  try{
    const summary = summarizeLibrary(all);
    const prompt = buildProfilePrompt(summary, { about:S.about, interests:S.interests }, []);
    const call = {anthropic:callAnthropic, openai:callOpenAI, gemini:callGemini, groq:callGroq, openrouter:callOpenRouter, local:callLocal}[S.provider];
    const res = parseProfileResult(await call(prompt));
    if(!res.interests.length && !res.about){ toast("The AI didn't return usable results — try again", 6000); return; }
    _profileTags = res.interests.map(name=>({ name, sel:true }));
    document.getElementById("profileAbout").value = (S.about ? S.about.trim()+"\n\n" : "") + res.about;
    renderProfileChips();
    document.getElementById("profileReview").style.display = "";
  }catch(e){ console.error(e); toast("Hmm: "+e.message, 6000); }
  finally{ btn.disabled=false; btn.innerHTML="&#129504; Analyze my library"; }
}
function renderProfileChips(){
  document.getElementById("profileChips").innerHTML = _profileTags.map((tg,i)=>
    `<button class="tagchip${tg.sel?" sel":""}" onclick="toggleProfileTag(${i})">${tg.sel?"&#10003; ":""}${esc(tg.name)}</button>`).join("");
}
function toggleProfileTag(i){ _profileTags[i].sel=!_profileTags[i].sel; renderProfileChips(); }
function acceptProfile(){
  const picked = _profileTags.filter(tg=>tg.sel).map(tg=>tg.name);
  S.interests = mergeInterests(S.interests, picked);
  S.about = document.getElementById("profileAbout").value.trim();
  document.getElementById("interestList").value = S.interests;
  document.getElementById("aboutMe").value = S.about;
  save("settings", S);
  document.getElementById("profileReview").style.display = "none";
  _profileTags = [];
  toast("Profile updated — "+picked.length+" interest"+(picked.length===1?"":"s")+" added");
}
function cancelProfile(){ document.getElementById("profileReview").style.display="none"; _profileTags=[]; }
```

- [ ] **Step 4: Run wiring test + syntax + full gate**

Run: `node tests/profile-wiring.test.js` (expect `2 passed`)
Run: `node tests/syntax-check.js` (expect `0 error(s)`)
Run: `node tests/run.js` (expect `ALL TEST FILES PASSED`)

- [ ] **Step 5: Commit**

```bash
git add web/index.html tests/profile-wiring.test.js
git commit -m "feat(ui): Analyze my library button + review panel (interests + About you)"
```

---

### Task 3: Version bump + installer

**Files:**
- Modify: `package.json`

(No data-safety/electron-security review required — no Core/endpoint/network/IPC/key surface; reads cards, writes settings non-destructively via the existing path.)

- [ ] **Step 1: Full gate**

Run: `node tests/run.js`
Expected: `ALL TEST FILES PASSED`.

- [ ] **Step 2: Version bump**

In `package.json`, change `"version": "1.3.2"` to `"version": "1.4.0"` (new feature → minor bump).

```bash
git add package.json
git commit -m "chore: bump version to 1.4.0 (Analyze my library -> interest profile)"
```

- [ ] **Step 3: Rebuild installer**

Run: `npm run dist`
Expected: `dist/Interests-App-Setup-1.4.0.exe` produced (exit 0; unsigned is normal).

- [ ] **Step 4: Summarize for Dave**

Report: where the button is (Settings → Your interest profile → 🧠 Analyze my library), the flow (analyze → review chips + edit About draft → Accept), that the feed already uses the result, and that the Notion connector is the queued next feature. Do NOT offer merge/PR — build is on master.

---

## Self-Review

**Spec coverage:**
- Button in Settings → interest profile → Task 2. ✓
- Aggregate ALL cards locally → one AI call → Task 1 (`summarizeLibrary`) + Task 2 (`analyzeLibrary`). ✓
- AI returns interest topics + About draft → Task 1 (`buildProfilePrompt`/`parseProfileResult`), ~15-25 + primarily-library + few-stretch in the prompt. ✓
- Review: checkbox chips + editable About box → Task 2 (`renderProfileChips`/`profileAbout`). ✓
- Non-destructive accept (append de-duped interests; About = existing+draft, edited) → Task 1 (`mergeInterests`) + Task 2 (`acceptProfile`, prefilled box). ✓
- Feed already consumes profile → no change (noted). ✓
- `extraSources` seam for future Notion → Task 1 (`buildProfilePrompt` arg + test). ✓
- No Core/endpoint changes; privacy = aggregated summary to AI → web-only (noted). ✓
- Version bump + installer → Task 3. ✓

**Placeholder scan:** none — complete code + anchors in every step.

**Type consistency:** all four lists use `{name,count}` (incl. keywords) — tests assert `{name,count}`; `summarizeLibrary` returns `{total,categories,domains,keywords,tags}`; `analyzeLibrary` calls `summarizeLibrary(imported.concat(saved))` then `buildProfilePrompt(summary,{about,interests},[])` → `parseProfileResult` → `{interests,about}`; `acceptProfile` uses `mergeInterests(S.interests, picked)`. `_profileTags` shape `{name,sel}` matches `renderProfileChips`/`toggleProfileTag`/`acceptProfile`. Consistent.
