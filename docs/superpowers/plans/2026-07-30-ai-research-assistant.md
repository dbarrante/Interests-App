# AI Research Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the reserved 🤖 AI tab's research features — a one-click AI-drafted article per card, and a per-card "ask a question" Q&A thread, both with cited sources — per the approved design spec. This is Plan 3 of 3 (Plan 1, tag editing on Saved, and Plan 2, Custom Tabs core, are both already merged to `master`).

**Architecture:** The reserved AI tab (`AI_TAB_TAG = "__ai_research__"`, `bootstrapAiTab()`, the tab-detail view via `renderTabsView()`) already exists from Plan 2 — flagging a card into it is just adding that tag, already fully working via the tag picker's pinned Tabs section and the bulk Add-to-tab flow. This plan adds ONLY the research UI shown per-card *inside* that one reserved tab: a new optional `research` field on the card/saved-item object (`{ article: {text, sources, generatedAt} | null, qa: [{question, answer, sources, answeredAt}] }`), a small deterministic parser for the AI's plain-text-plus-sources response shape (not the app's existing `parseItems` JSON-list schema), and a `researchPanelHTML(scope, it)` renderer appended below each card's normal markup — but only when the open tab is the reserved one (`t.reserved`). No `core/` (backend), `core/db.js`, or sync/backup changes — `research` round-trips through the same free-form JSON blob every other non-core-column field already uses.

**Tech Stack:** Vanilla JS inside `web/index.html` / `pwa/index.html` (no framework, no build step). Tests are plain `assert` scripts using `tests/_extract.js`'s function-extraction technique, following the pattern Plan 2 established (`tests/tabs-*.test.js`).

## Global Constraints

- Single-file HTML apps (`web/index.html`, `pwa/index.html`) must stay parseable — every change must pass `node tests/syntax-check.js`.
- Every new **pure-logic function** this plan introduces (`hasResearchProvider`, `_researchCard`, `buildArticlePrompt`, `buildQuestionPrompt`, `parseResearchResponse`) and every new **UI function** (`generateArticle`, `askQuestion`, `deleteQaEntry`, `toggleArticleEdit`, `saveArticleEdit`, `toggleArticleExpanded`, `copyArticleText`, `researchPanelHTML`) must be byte-identical between `web/index.html` and `pwa/index.html` — verified by a dedicated parity test (Task 5), following the exact precedent Plan 2 set (`tests/tabs-parity.test.js`).
- **Provider capability gate:** the feature requires a web-search-capable provider. Per the approved design spec plus a since-added provider not covered by the original spec text: `anthropic`, `openai`, `gemini`, and `openrouter` are capable (Anthropic/OpenAI/Gemini's callers in `web/ai.js` always run web search unconditionally; OpenRouter's caller supports it via an opt-in `opts.webSearch` flag, confirmed in `web/ai.js:103-129`). `groq` and `local` are NOT capable (their callers have no web-search tool at all). When the configured `S.provider` isn't capable, both "Research & draft article" and "Ask a question" must show a toast pointing at Settings — never run an ungrounded call.
- Every AI call in this plan must be invoked as `callAI(prompt, {webSearch:true})` — the `webSearch` flag is read only by `callOpenRouter`; the other three capable callers ignore it (harmless) since they always search regardless.
- No `core/` (backend), `core/db.js` schema, or sync/backup-format changes. `research` is a plain field inside the existing card/saved-item object, written through the existing `Store.putCards(imported)` / `Store.putSaved(saved)` calls every tag/title edit already uses.
- A card resolved by `scope`+`id` before an `await callAI(...)` gap must be **re-resolved by id, not reused by reference**, immediately before the response is written — the card may have been deleted (✕) or untagged (Remove from tab) while the AI call was in flight. Discard the result silently (no write, no error toast) if the card is gone by the time the response lands; this is the same stale-async-reference class Plan 2's final review found and fixed repeatedly (`openTabSuggest`'s `suggTabId` guard, the `_tabSug`/`tabSelPicks` id-based identity fix) — do not reintroduce it here.
- `researchPanelHTML`'s buttons are reachable ONLY from inside the reserved AI tab's card grid (gated by `t.reserved` in `renderTabsView`), so every handler it wires (`generateArticle`, `askQuestion`, `deleteQaEntry`, `toggleArticleEdit`, `saveArticleEdit`, `toggleArticleExpanded`, `copyArticleText`) re-renders by calling `renderTabsView()` directly — **not** `refreshTabsViewIfShowing()`, which exists for handlers also reachable from Imported/Saved's own direct views (`impDrop`, `impSave`, etc.). These handlers have no such dual reachability; matching Plan 2's own `openTabSuggest`/`tabSugAccept`/`removeTabPicksFromTab` precedent, which all call `renderTabsView()` directly for the same reason.
- `pwa/sw.js`'s `SHELL_CACHE` must be bumped once this plan's `pwa/index.html` edits are complete (Task 5) — every task from 1 through 4 touches `pwa/index.html`, and an unbumped `SHELL_CACHE` leaves already-installed PWAs silently serving the old shell indefinitely.
- Follow the project's `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` commit trailer convention.

---

### Task 1: Data model, response parser, prompt builders, and the provider capability gate

**Files:**
- Modify: `web/index.html` (new pure-logic block, placed directly after `tabCardWrapper()` at `web/index.html:3573-3576` — before `removeTabPicksFromTab()`)
- Modify: `pwa/index.html` (same edit, located by content — search for `function tabCardWrapper`)
- Test: `tests/research-core.test.js` (new)

**Interfaces:**
- Consumes: `S` (existing global settings object, `S.provider`), `saved`/`imported` (existing globals).
- Produces: `RESEARCH_PROVIDERS` (a `Set` of capable provider keys), `hasResearchProvider()` (returns boolean, checks `S.provider`), `_researchCard(scope, id)` (returns the live card object or `undefined`), `buildArticlePrompt(it)`, `buildQuestionPrompt(it, question)` (both return a prompt string), `parseResearchResponse(text)` (returns `{text, sources}` or throws). Every later task consumes these by these exact names/signatures.

- [ ] **Step 1: Write the failing test**

Create `tests/research-core.test.js`:

```js
// tests/research-core.test.js — Task 1: the AI research assistant's pure logic
// (provider capability gate, card resolver, prompt builders, and the plain-text
// article/answer parser). No DOM, no async — these are the building blocks every
// later task's UI orchestration calls into.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }
function fn(src, name) { const m = extractFn(src, name); assert.ok(m, name + " not found in source"); return m; }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": RESEARCH_PROVIDERS is exactly {anthropic, openai, gemini, openrouter}", () => {
    const factory = new Function(src.match(/const RESEARCH_PROVIDERS[^;]+;/)[0] + "\nreturn RESEARCH_PROVIDERS;");
    const set = factory();
    assert.deepStrictEqual([...set].sort(), ["anthropic", "gemini", "openai", "openrouter"]);
  });

  t(label + ": hasResearchProvider is true for anthropic/openai/gemini/openrouter, false for groq/local", () => {
    const body = [src.match(/const RESEARCH_PROVIDERS[^;]+;/)[0], fn(src, "hasResearchProvider")].join("\n");
    for (const provider of ["anthropic", "openai", "gemini", "openrouter"]) {
      const factory = new Function("S", body + "\nreturn hasResearchProvider;");
      assert.strictEqual(factory({ provider })(), true, provider + " should be capable");
    }
    for (const provider of ["groq", "local"]) {
      const factory = new Function("S", body + "\nreturn hasResearchProvider;");
      assert.strictEqual(factory({ provider })(), false, provider + " should NOT be capable");
    }
  });

  t(label + ": _researchCard resolves by scope+id from imported or saved, undefined if missing", () => {
    const factory = new Function(
      "imported", "saved",
      fn(src, "_researchCard") + "\nreturn _researchCard;"
    );
    const impArr = [{ id: "i0", title: "A" }];
    const savArr = [{ id: "s0", title: "B" }];
    const _researchCard = factory(impArr, savArr);
    assert.strictEqual(_researchCard("imported", "i0"), impArr[0]);
    assert.strictEqual(_researchCard("saved", "s0"), savArr[0]);
    assert.strictEqual(_researchCard("imported", "nope"), undefined);
    assert.strictEqual(_researchCard("saved", "nope"), undefined);
  });

  t(label + ": buildArticlePrompt includes the card's title, and desc/url only when present", () => {
    const factory = new Function(fn(src, "buildArticlePrompt") + "\nreturn buildArticlePrompt;");
    const buildArticlePrompt = factory();
    const bare = buildArticlePrompt({ title: "Ferrofluid displays" });
    assert.match(bare, /Ferrofluid displays/);
    assert.doesNotMatch(bare, /Context:/);
    assert.doesNotMatch(bare, /Original link:/);
    const full = buildArticlePrompt({ title: "Ferrofluid displays", desc: "A kinetic art piece", url: "https://example.com/x" });
    assert.match(full, /Context: A kinetic art piece/);
    assert.match(full, /Original link: https:\/\/example\.com\/x/);
    assert.match(full, /SOURCES/i);
  });

  t(label + ": buildQuestionPrompt includes the card's title and the literal question text", () => {
    const factory = new Function(fn(src, "buildQuestionPrompt") + "\nreturn buildQuestionPrompt;");
    const buildQuestionPrompt = factory();
    const p = buildQuestionPrompt({ title: "Ferrofluid displays" }, "How much does one cost?");
    assert.match(p, /Ferrofluid displays/);
    assert.match(p, /How much does one cost\?/);
    assert.match(p, /SOURCES/i);
  });

  t(label + ": parseResearchResponse splits body text from a SOURCES: block and extracts URLs", () => {
    const factory = new Function(fn(src, "parseResearchResponse") + "\nreturn parseResearchResponse;");
    const parseResearchResponse = factory();
    const out = parseResearchResponse("Ferrofluid displays use magnetic nanoparticles.\n\nSOURCES:\nhttps://example.com/a\nhttps://example.com/b (great overview)\n");
    assert.strictEqual(out.text, "Ferrofluid displays use magnetic nanoparticles.");
    assert.deepStrictEqual(out.sources, ["https://example.com/a", "https://example.com/b"]);
  });

  t(label + ": parseResearchResponse tolerates lowercase 'sources:' and no trailing newline", () => {
    const factory = new Function(fn(src, "parseResearchResponse") + "\nreturn parseResearchResponse;");
    const parseResearchResponse = factory();
    const out = parseResearchResponse("Body text here.\nsources:\nhttps://example.com/z");
    assert.strictEqual(out.text, "Body text here.");
    assert.deepStrictEqual(out.sources, ["https://example.com/z"]);
  });

  t(label + ": parseResearchResponse returns an empty sources array when no SOURCES: block is present", () => {
    const factory = new Function(fn(src, "parseResearchResponse") + "\nreturn parseResearchResponse;");
    const parseResearchResponse = factory();
    const out = parseResearchResponse("Just plain article text, no citations given.");
    assert.strictEqual(out.text, "Just plain article text, no citations given.");
    assert.deepStrictEqual(out.sources, []);
  });

  t(label + ": parseResearchResponse dedupes sources and caps at 10", () => {
    const factory = new Function(fn(src, "parseResearchResponse") + "\nreturn parseResearchResponse;");
    const parseResearchResponse = factory();
    const many = Array.from({ length: 15 }, (_, i) => "https://example.com/" + i).join("\n");
    const out = parseResearchResponse("Body.\n\nSOURCES:\nhttps://example.com/0\n" + many);
    assert.strictEqual(out.sources.length, 10);
    assert.strictEqual(new Set(out.sources).size, 10);
  });

  t(label + ": parseResearchResponse throws on an empty response", () => {
    const factory = new Function(fn(src, "parseResearchResponse") + "\nreturn parseResearchResponse;");
    const parseResearchResponse = factory();
    assert.throws(() => parseResearchResponse(""));
    assert.throws(() => parseResearchResponse("   "));
  });

  t(label + ": parseResearchResponse throws when the body is empty even if a SOURCES: block follows", () => {
    const factory = new Function(fn(src, "parseResearchResponse") + "\nreturn parseResearchResponse;");
    const parseResearchResponse = factory();
    assert.throws(() => parseResearchResponse("\nSOURCES:\nhttps://example.com/a"));
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/research-core.test.js`
Expected: FAIL — every `fn(src, "...")` call throws `"... not found in source"` (none of these functions exist yet).

- [ ] **Step 3: Write the implementation**

In `web/index.html`, immediately after `tabCardWrapper()`'s closing `}` (currently `web/index.html:3576`, right before `function removeTabPicksFromTab(){`), insert:

```js
/* ---- AI research assistant (Plan 3): article + Q&A on the reserved AI tab ---- */
// Anthropic/OpenAI/Gemini's callers in web/ai.js always run web search
// unconditionally; OpenRouter's caller supports it opt-in via opts.webSearch.
// Groq/Local have no web-search tool at all — never run an ungrounded "research" call.
const RESEARCH_PROVIDERS = new Set(["anthropic", "openai", "gemini", "openrouter"]);
function hasResearchProvider(){ return RESEARCH_PROVIDERS.has(S.provider); }
function _researchCard(scope, id){
  return scope==="saved" ? saved.find(c=>c&&c.id===id) : imported.find(c=>c&&c.id===id);
}
function buildArticlePrompt(it){
  return `Research and write a well-organized, factual article about the following topic, using web search to find current, accurate information. Write 3-6 paragraphs of plain text — no markdown headers, no bullet lists unless truly necessary. After the article, on its own line write "SOURCES:" followed by one URL per line for the sources you used.\n\nTopic: "${it.title}"${it.desc?"\nContext: "+it.desc:""}${it.url?"\nOriginal link: "+it.url:""}`;
}
function buildQuestionPrompt(it, question){
  return `You are answering a question about the following saved item, using web search to find current, accurate information. Write a clear, well-researched answer in plain text — a few sentences to a couple of short paragraphs. After the answer, on its own line write "SOURCES:" followed by one URL per line for the sources you used.\n\nItem: "${it.title}"${it.desc?"\nContext: "+it.desc:""}${it.url?"\nOriginal link: "+it.url:""}\n\nQuestion: ${question}`;
}
// Deterministic parser for the AI's plain-text-plus-sources shape — NOT parseItems'
// JSON-list schema. Splits on the LAST "sources:"/"source:" line marker (case-
// insensitive); everything before is the body, everything after is scanned for
// URLs. No marker found -> whole text is the body, sources is []. Trailing
// punctuation stripped so a sentence-embedded URL doesn't carry a period/paren
// into the stored link. Deduped, capped at 10.
function parseResearchResponse(text){
  if(!text || !text.trim()) throw new Error("Empty response from model");
  const marker = /\n\s*sources?:\s*\n?/i;
  const m = text.match(marker);
  const body = (m ? text.slice(0, m.index) : text).trim();
  if(!body) throw new Error("No article text in model response");
  const urlRe = /https?:\/\/[^\s)\]}"'<>]+/g;
  const scanFrom = m ? text.slice(m.index + m[0].length) : text;
  const found = scanFrom.match(urlRe) || [];
  const seen = new Set(); const sources = [];
  for(let u of found){
    u = u.replace(/[.,;:)\]}>"']+$/, "");
    if(u && !seen.has(u)){ seen.add(u); sources.push(u); if(sources.length>=10) break; }
  }
  return { text: body, sources: sources };
}
```

Apply the **exact same block** to `pwa/index.html` at the same location (immediately after its own `tabCardWrapper()`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/research-core.test.js`
Expected: PASS — all assertions green for both `web` and `pwa`.

- [ ] **Step 5: Run the full suite and syntax gate before committing**

Run: `node tests/syntax-check.js && npm test`
Expected: both green. This plan builds on Plan 2's `tabCardWrapper`/`renderTabsView` — confirm nothing in the existing suite broke.

- [ ] **Step 6: Commit**

```bash
git add web/index.html pwa/index.html tests/research-core.test.js
git commit -m "AI research: data model, response parser, prompt builders, provider gate

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Article generation — button, AI call, view rendering, Regenerate, Copy

**Files:**
- Modify: `web/index.html` (new state + functions after Task 1's block; `renderTabsView()`'s card-mapping loop at `web/index.html:3463-3474`; new CSS near `web/index.html:465`)
- Modify: `pwa/index.html` (same edits, located by content)
- Test: `tests/research-article.test.js` (new)

**Interfaces:**
- Consumes: `hasResearchProvider()`, `_researchCard(scope,id)`, `buildArticlePrompt(it)`, `parseResearchResponse(text)` (Task 1); `callAI(prompt, opts)`, `toast(msg, ms)`, `esc(s)`, `domain(url)`, `Store.putCards`/`Store.putSaved` (existing); `renderTabsView()`, `tabCardWrapper`, `impCardHTML`, `cardHTML` (Plan 2).
- Produces: `_researchBusy` (module-level `Set` of `"scope:id"` keys currently mid AI-call — Task 4 also reads/writes this), `generateArticle(scope, id)` (async), `copyArticleText(scope, id)`, `researchPanelHTML(scope, it)` (returns an HTML string; Task 3 and Task 4 extend this SAME function's body, not a new one). `renderTabsView` wires `researchPanelHTML` into the card loop, gated on `t.reserved`.

- [ ] **Step 1: Write the failing test**

Create `tests/research-article.test.js`:

```js
// tests/research-article.test.js — Task 2: generateArticle's AI-call orchestration
// (provider gate, busy-state guard against double-submit, the stale-reference
// re-resolve-by-id guard for a card deleted mid-flight, error posture) and
// researchPanelHTML's article-section rendering (initial button, loading,
// generated view, Regenerate, Copy). Uses the queued async-runner pattern (see
// tests/ai-module.test.js / tests/tabs-ai-suggest.test.js) since generateArticle
// is async — a plain synchronous t() never awaits a returned Promise.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let passed = 0, failed = 0;
const queue = [];
function t(n, fn) { queue.push([n, fn]); }
function fn(src, name) { const m = extractFn(src, name); assert.ok(m, name + " not found in source"); return m; }

function loadGenerateArticle(src, state, callAI) {
  const body = [
    src.match(/const RESEARCH_PROVIDERS[^;]+;/)[0],
    fn(src, "hasResearchProvider"), fn(src, "_researchCard"), fn(src, "buildArticlePrompt"),
    fn(src, "parseResearchResponse"), fn(src, "generateArticle"),
  ].join("\n");
  const factory = new Function(
    "S", "imported", "saved", "callAI", "toast", "renderTabsView", "Store",
    body + "\nreturn { generateArticle, getBusy: function(){ return _researchBusy; } };"
  );
  return factory(
    state.S || { provider: "anthropic" }, state.imported || [], state.saved || [],
    callAI, state.toast || (()=>{}), state.renderTabsView || (()=>{}),
    state.Store || { putCards: ()=>{}, putSaved: ()=>{} }
  );
}

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": generateArticle writes research.article from a parsed AI response", async () => {
    const impArr = [{ id: "i0", title: "Ferrofluid displays" }];
    const calls = [];
    const api = loadGenerateArticle(src, {
      imported: impArr,
      renderTabsView: () => calls.push("render"),
      Store: { putCards: (arr) => calls.push(["putCards", arr]), putSaved: () => {} },
    }, async () => "Article body.\n\nSOURCES:\nhttps://example.com/a");
    await api.generateArticle("imported", "i0");
    assert.deepStrictEqual(impArr[0].research.article, { text: "Article body.", sources: ["https://example.com/a"], generatedAt: impArr[0].research.article.generatedAt });
    assert.ok(typeof impArr[0].research.article.generatedAt === "number");
    assert.deepStrictEqual(impArr[0].research.qa, []);
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === "putCards"));
    assert.ok(calls.includes("render"));
  });

  t(label + ": generateArticle refuses when the configured provider isn't web-search-capable", async () => {
    const impArr = [{ id: "i0", title: "X" }];
    let aiCalled = false;
    const toasts = [];
    const api = loadGenerateArticle(src, { S: { provider: "groq" }, imported: impArr, toast: (m)=>toasts.push(m) }, async () => { aiCalled = true; return ""; });
    await api.generateArticle("imported", "i0");
    assert.strictEqual(aiCalled, false);
    assert.strictEqual(impArr[0].research, undefined);
    assert.ok(toasts.length && /provider/i.test(toasts[0]));
  });

  t(label + ": generateArticle is a no-op for an unknown card id", async () => {
    let aiCalled = false;
    const api = loadGenerateArticle(src, { imported: [] }, async () => { aiCalled = true; return ""; });
    await api.generateArticle("imported", "nope");
    assert.strictEqual(aiCalled, false);
  });

  t(label + ": generateArticle guards against a double-submit while already busy", async () => {
    const impArr = [{ id: "i0", title: "X" }];
    let callCount = 0;
    let resolveFirst;
    const first = new Promise(r => { resolveFirst = r; });
    const api = loadGenerateArticle(src, { imported: impArr }, async () => { callCount++; return first; });
    const p1 = api.generateArticle("imported", "i0");
    const p2 = api.generateArticle("imported", "i0");   // fired while p1 is still in flight
    resolveFirst("Body.\n\nSOURCES:\nhttps://example.com/a");
    await Promise.all([p1, p2]);
    assert.strictEqual(callCount, 1, "the second call must be dropped while the first is in flight");
  });

  t(label + ": generateArticle discards its result if the card was deleted while the AI call was in flight", async () => {
    const impArr = [{ id: "i0", title: "X" }];
    const calls = [];
    let resolveAi;
    const api = loadGenerateArticle(src, {
      imported: impArr,
      renderTabsView: () => calls.push("render"),
      Store: { putCards: () => calls.push("putCards"), putSaved: () => {} },
    }, () => new Promise(r => { resolveAi = r; }));
    const p = api.generateArticle("imported", "i0");
    impArr.length = 0;   // simulate impDrop/removeCardFromTab deleting/untagging the card mid-flight
    resolveAi("Body.\n\nSOURCES:\nhttps://example.com/a");
    await p;
    assert.ok(!calls.includes("putCards"), "must not write research onto a card that no longer resolves");
    assert.ok(calls.includes("render"), "must still clear the busy state and re-render");
  });

  t(label + ": generateArticle toasts and writes nothing on a thrown AI call", async () => {
    const impArr = [{ id: "i0", title: "X" }];
    const toasts = [];
    const api = loadGenerateArticle(src, { imported: impArr, toast: (m)=>toasts.push(m) }, async () => { throw new Error("network down"); });
    await api.generateArticle("imported", "i0");
    assert.strictEqual(impArr[0].research, undefined);
    assert.ok(toasts.some(m => /network down/.test(m)));
    assert.strictEqual(api.getBusy().size, 0, "busy flag must clear even on failure");
  });

  t(label + ": researchPanelHTML shows the initial button when no article exists yet", () => {
    const factory = new Function(
      "_researchBusy", "_articleEditing", "_articleExpanded", "esc", "domain",
      fn(src, "researchPanelHTML") + "\nreturn researchPanelHTML;"
    );
    const researchPanelHTML = factory(new Set(), new Set(), new Set(), (s)=>s, ()=>"");
    const out = researchPanelHTML("imported", { id: "i0" });
    assert.match(out, /generateArticle\('imported','i0'\)/);
    assert.match(out, /Research/);
  });

  t(label + ": researchPanelHTML shows a loading state while busy and no article exists yet", () => {
    const factory = new Function(
      "_researchBusy", "_articleEditing", "_articleExpanded", "esc", "domain",
      fn(src, "researchPanelHTML") + "\nreturn researchPanelHTML;"
    );
    const researchPanelHTML = factory(new Set(["imported:i0"]), new Set(), new Set(), (s)=>s, ()=>"");
    const out = researchPanelHTML("imported", { id: "i0" });
    assert.doesNotMatch(out, /generateArticle\('imported','i0'\)/);
    assert.match(out, /esearching/);
  });

  t(label + ": researchPanelHTML shows the article, its sources, and a Regenerate/Copy row once generated", () => {
    const factory = new Function(
      "_researchBusy", "_articleEditing", "_articleExpanded", "esc", "domain",
      fn(src, "researchPanelHTML") + "\nreturn researchPanelHTML;"
    );
    const researchPanelHTML = factory(new Set(), new Set(), new Set(), (s)=>s, (u)=>u.replace(/^https?:\/\//,"").split("/")[0]);
    const it = { id: "i0", research: { article: { text: "Short article body.", sources: ["https://example.com/a"], generatedAt: 1 }, qa: [] } };
    const out = researchPanelHTML("imported", it);
    assert.match(out, /Short article body\./);
    assert.match(out, /example\.com/);
    assert.match(out, /copyArticleText\('imported','i0'\)/);
    assert.match(out, /generateArticle\('imported','i0'\)/);   // Regenerate reuses generateArticle
    assert.match(out, /Regenerate/);
  });
}

(async () => {
  for (const [n, fn] of queue) {
    try { await fn(); passed++; console.log("  ok  " + n); }
    catch (e) { failed++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); }
  }
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/research-article.test.js`
Expected: FAIL — `generateArticle`, `_researchBusy`, `copyArticleText`, `researchPanelHTML` don't exist yet.

- [ ] **Step 3: Write the implementation**

In `web/index.html`, immediately after Task 1's block (after `parseResearchResponse`'s closing `}`, still before `removeTabPicksFromTab()`), insert:

```js
let _researchBusy = new Set();   // "scope:id" keys currently mid an AI call (article gen/regen or Q&A — Task 4)
let _articleExpanded = new Set();   // "scope:id" keys with the full article shown (vs. a truncated preview)
async function generateArticle(scope, id){
  if(!_researchCard(scope, id)) return;
  if(!hasResearchProvider()){ toast("Article research needs a web-search-capable provider (Claude, ChatGPT, Gemini, or OpenRouter) — switch in Settings", 6000); return; }
  const key = scope+":"+id;
  if(_researchBusy.has(key)) return;
  const promptIt = _researchCard(scope, id);
  _researchBusy.add(key);
  renderTabsView();
  try{
    const text = await callAI(buildArticlePrompt(promptIt), {webSearch:true});
    const parsed = parseResearchResponse(text);
    // Re-resolve by id, not the captured `promptIt` reference — the card may have
    // been deleted (✕) or untagged (Remove from tab) while this call was in flight.
    const it = _researchCard(scope, id);
    if(it){
      if(!it.research) it.research = {article:null, qa:[]};
      it.research.article = {text:parsed.text, sources:parsed.sources, generatedAt:Date.now()};
      if(scope==="saved") Store.putSaved(saved); else Store.putCards(imported);
      toast("Article generated");
    }
  }catch(e){
    toast("Couldn't generate article: "+(e&&e.message||e));
  }finally{
    _researchBusy.delete(key);
    renderTabsView();
  }
}
function copyArticleText(scope, id){
  const it = _researchCard(scope, id); if(!it || !it.research || !it.research.article) return;
  navigator.clipboard.writeText(it.research.article.text).then(
    ()=>toast("Article copied"),
    ()=>toast("Couldn't copy — clipboard access denied")
  );
}
// Appended below a card's own markup inside the reserved AI tab ONLY
// (renderTabsView gates this on t.reserved) — every button here is therefore only
// ever reachable while curTab==="tabs", so handlers re-render via renderTabsView()
// directly, same as openTabSuggest/tabSugAccept/removeTabPicksFromTab (Plan 2).
function researchPanelHTML(scope, it){
  const key = scope+":"+it.id;
  const busy = _researchBusy.has(key);
  const art = it.research && it.research.article;
  let articleHtml;
  if(!art){
    articleHtml = busy
      ? `<div class="hint">Researching…</div>`
      : `<button onclick="generateArticle('${scope}','${it.id}')">&#128221; Research &amp; draft article</button>`;
  } else {
    const expanded = _articleExpanded.has(key);
    const long = art.text.length>240;
    const preview = long && !expanded ? art.text.slice(0,240)+"…" : art.text;
    articleHtml = `<div class="research-article">
      <div class="research-article-text">${esc(preview)}</div>
      ${long?`<button class="btn-ghost" onclick="toggleArticleExpanded('${scope}','${it.id}')">${expanded?"Show less":"Show full article"}</button>`:""}
      ${art.sources.length?`<div class="hint">Sources: ${art.sources.map(u=>`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(domain(u)||u)}</a>`).join(", ")}</div>`:""}
      <div style="display:flex;gap:8px;margin-top:6px">
        <button class="btn-ghost" onclick="copyArticleText('${scope}','${it.id}')">Copy</button>
        <button class="btn-ghost" ${busy?"disabled":""} onclick="generateArticle('${scope}','${it.id}')">${busy?"Regenerating…":"&#8635; Regenerate"}</button>
      </div>
    </div>`;
  }
  return `<div class="research-panel">${articleHtml}</div>`;
}
function toggleArticleExpanded(scope, id){
  const key = scope+":"+id;
  _articleExpanded.has(key) ? _articleExpanded.delete(key) : _articleExpanded.add(key);
  renderTabsView();
}
```

Apply the same block to `pwa/index.html` at the same location.

Then wire `researchPanelHTML` into `renderTabsView`'s card-mapping loop. In `web/index.html:3463-3474`, change:

```js
      : `<div class="${gridClass()}">${list.map(r=>{
          // Imported identity is the card's stable id, NOT its array index — a pick
          // made now must still resolve to the right card even if something else
          // (a delete, a background capture-drain) splices `imported` before the
          // pick is acted on, which would silently shift every later index. Assign
          // BEFORE rendering the card, or impCardHTML bakes in a blank data-id/
          // _hoverCardId for this pass (self-heals next render, but no reason to).
          if(r.kind==="imported" && !r.it.id){ r.it.id=newId(); Store.putCards(imported); }
          const inner = r.kind==="saved" ? cardHTML(r.it,"saved",t.tag) : impCardHTML(r.it,r.idx,t.tag);
          const identity = r.it.id;
          return tabCardWrapper(inner, r.kind, identity, tabSelPicks.has(r.kind+":"+identity));
        }).join("")}</div>`;
```

to:

```js
      : `<div class="${gridClass()}">${list.map(r=>{
          // Imported identity is the card's stable id, NOT its array index — a pick
          // made now must still resolve to the right card even if something else
          // (a delete, a background capture-drain) splices `imported` before the
          // pick is acted on, which would silently shift every later index. Assign
          // BEFORE rendering the card, or impCardHTML bakes in a blank data-id/
          // _hoverCardId for this pass (self-heals next render, but no reason to).
          if(r.kind==="imported" && !r.it.id){ r.it.id=newId(); Store.putCards(imported); }
          let inner = r.kind==="saved" ? cardHTML(r.it,"saved",t.tag) : impCardHTML(r.it,r.idx,t.tag);
          if(t.reserved) inner += researchPanelHTML(r.kind, r.it);
          const identity = r.it.id;
          return tabCardWrapper(inner, r.kind, identity, tabSelPicks.has(r.kind+":"+identity));
        }).join("")}</div>`;
```

Apply the identical change to `pwa/index.html`'s copy of this block.

Add CSS near the other tab-feature rules (`web/index.html:465`, right after `.addtab-menu`'s rule):

```css
.research-panel{margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}
.research-article-text{white-space:pre-wrap;font-size:13.5px;line-height:1.5}
```

Apply the same two rules to `pwa/index.html` at the equivalent CSS location.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/research-article.test.js`
Expected: PASS for both `web` and `pwa`.

- [ ] **Step 5: Run the full suite and syntax gate**

Run: `node tests/syntax-check.js && npm test`
Expected: both green — specifically re-check `tests/tabs-view.test.js`/`tests/tabs-parity.test.js` didn't break from the `renderTabsView` edit (the same cross-task test-fragility class Plan 2 hit repeatedly — if a pre-existing test's `new Function(...)` factory extracts `renderTabsView` and doesn't inject `researchPanelHTML`/`t.reserved`-reachable globals it now references, it will throw `ReferenceError`; fix by injecting the new dependency with a safe default, same pattern as every prior instance this session).

- [ ] **Step 6: Commit**

```bash
git add web/index.html pwa/index.html tests/research-article.test.js
git commit -m "AI research: article generation, view, Regenerate, Copy

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Article editing

**Files:**
- Modify: `web/index.html` (new state + functions after Task 2's block; extend `researchPanelHTML`'s article-exists branch)
- Modify: `pwa/index.html` (same edits)
- Test: `tests/research-edit.test.js` (new)

**Interfaces:**
- Consumes: `_researchCard(scope,id)` (Task 1); `_researchBusy`, `researchPanelHTML` (Task 2, extended in place — same function name, not a new one).
- Produces: `_articleEditing` (module-level `Set` of `"scope:id"` keys with the article's textarea open), `toggleArticleEdit(scope, id)`, `saveArticleEdit(scope, id)`.

- [ ] **Step 1: Write the failing test**

Create `tests/research-edit.test.js`:

```js
// tests/research-edit.test.js — Task 3: editing an already-generated article's text
// in place (a plain textarea over research.article.text, per the design spec — no
// version history, no regeneration involved). Mirrors impEditSave's edit-toggle
// shape but scoped to just the article field.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }
function fn(src, name) { const m = extractFn(src, name); assert.ok(m, name + " not found in source"); return m; }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": toggleArticleEdit adds/removes the scope:id key and re-renders", () => {
    const calls = [];
    const factory = new Function(
      "_articleEditing", "renderTabsView",
      fn(src, "toggleArticleEdit") + "\nreturn toggleArticleEdit;"
    );
    const editing = new Set();
    const toggleArticleEdit = factory(editing, ()=>calls.push("render"));
    toggleArticleEdit("imported", "i0");
    assert.ok(editing.has("imported:i0"));
    toggleArticleEdit("imported", "i0");
    assert.ok(!editing.has("imported:i0"));
    assert.strictEqual(calls.length, 2);
  });

  t(label + ": saveArticleEdit writes the textarea's trimmed value, persists, exits edit mode", () => {
    const impArr = [{ id: "i0", research: { article: { text: "old text", sources: [], generatedAt: 1 }, qa: [] } }];
    const calls = [];
    const editing = new Set(["imported:i0"]);
    const factory = new Function(
      "imported", "saved", "_articleEditing", "Store", "renderTabsView", "toast", "document",
      fn(src, "_researchCard") + "\n" + fn(src, "saveArticleEdit") + "\nreturn saveArticleEdit;"
    );
    const fakeTextarea = { value: "  new edited text  " };
    const fakeDocument = { getElementById: (id) => id === "artEdit_imported_i0" ? fakeTextarea : null };
    const saveArticleEdit = factory(
      impArr, [], editing,
      { putCards: (arr)=>calls.push(["putCards",arr]), putSaved: ()=>{} },
      ()=>calls.push("render"), ()=>calls.push("toast"), fakeDocument
    );
    saveArticleEdit("imported", "i0");
    assert.strictEqual(impArr[0].research.article.text, "new edited text");
    assert.strictEqual(impArr[0].research.article.sources.length, 0);   // untouched
    assert.ok(!editing.has("imported:i0"));
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === "putCards"));
    assert.ok(calls.includes("render"));
  });

  t(label + ": saveArticleEdit refuses an empty/whitespace-only edit and leaves the article untouched", () => {
    const impArr = [{ id: "i0", research: { article: { text: "old text", sources: [], generatedAt: 1 }, qa: [] } }];
    const editing = new Set(["imported:i0"]);
    const factory = new Function(
      "imported", "saved", "_articleEditing", "Store", "renderTabsView", "toast", "document",
      fn(src, "_researchCard") + "\n" + fn(src, "saveArticleEdit") + "\nreturn saveArticleEdit;"
    );
    const fakeDocument = { getElementById: () => ({ value: "   " }) };
    const saveArticleEdit = factory(impArr, [], editing, { putCards: ()=>{}, putSaved: ()=>{} }, ()=>{}, ()=>{}, fakeDocument);
    saveArticleEdit("imported", "i0");
    assert.strictEqual(impArr[0].research.article.text, "old text");
    assert.ok(editing.has("imported:i0"), "edit mode must stay open on a rejected save");
  });

  t(label + ": researchPanelHTML renders a textarea and Save/Cancel when editing", () => {
    const factory = new Function(
      "_researchBusy", "_articleEditing", "_articleExpanded", "esc", "domain",
      fn(src, "researchPanelHTML") + "\nreturn researchPanelHTML;"
    );
    const researchPanelHTML = factory(new Set(), new Set(["imported:i0"]), new Set(), (s)=>s, ()=>"");
    const it = { id: "i0", research: { article: { text: "Editable body.", sources: [], generatedAt: 1 }, qa: [] } };
    const out = researchPanelHTML("imported", it);
    assert.match(out, /<textarea id="artEdit_imported_i0">Editable body\.<\/textarea>/);
    assert.match(out, /saveArticleEdit\('imported','i0'\)/);
    assert.match(out, /toggleArticleEdit\('imported','i0'\)/);
    assert.doesNotMatch(out, /Regenerate/);   // view-mode-only actions must not also render
  });

  t(label + ": researchPanelHTML's view mode (not editing) offers an Edit button alongside Copy/Regenerate", () => {
    const factory = new Function(
      "_researchBusy", "_articleEditing", "_articleExpanded", "esc", "domain",
      fn(src, "researchPanelHTML") + "\nreturn researchPanelHTML;"
    );
    const researchPanelHTML = factory(new Set(), new Set(), new Set(), (s)=>s, ()=>"");
    const it = { id: "i0", research: { article: { text: "Body.", sources: [], generatedAt: 1 }, qa: [] } };
    const out = researchPanelHTML("imported", it);
    assert.match(out, /toggleArticleEdit\('imported','i0'\)/);
    assert.match(out, />Edit</);
    assert.doesNotMatch(out, /<textarea/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/research-edit.test.js`
Expected: FAIL — `_articleEditing`, `toggleArticleEdit`, `saveArticleEdit` don't exist; `researchPanelHTML`'s edit-mode branch and Edit button don't exist yet.

- [ ] **Step 3: Write the implementation**

In `web/index.html`, immediately after Task 2's block (after `toggleArticleExpanded`'s closing `}`), insert:

```js
let _articleEditing = new Set();   // "scope:id" keys with the article's textarea open
function toggleArticleEdit(scope, id){
  const key = scope+":"+id;
  _articleEditing.has(key) ? _articleEditing.delete(key) : _articleEditing.add(key);
  renderTabsView();
}
function saveArticleEdit(scope, id){
  const it = _researchCard(scope, id); if(!it || !it.research || !it.research.article) return;
  const ta = document.getElementById("artEdit_"+scope+"_"+id); if(!ta) return;
  const text = ta.value.trim();
  if(!text){ toast("Article text can't be empty"); return; }
  it.research.article.text = text;
  if(scope==="saved") Store.putSaved(saved); else Store.putCards(imported);
  _articleEditing.delete(scope+":"+id);
  renderTabsView();
  toast("Article updated");
}
```

Then replace `researchPanelHTML`'s article-exists (`else`) branch — the one written in Task 2 — with an edit-mode-aware version:

```js
  } else {
    const editing = _articleEditing.has(key);
    if(editing){
      articleHtml = `<div class="research-article">
        <textarea id="artEdit_${scope}_${it.id}">${esc(art.text)}</textarea>
        <div style="display:flex;gap:8px;margin-top:6px">
          <button onclick="saveArticleEdit('${scope}','${it.id}')">Save</button>
          <button class="btn-ghost" onclick="toggleArticleEdit('${scope}','${it.id}')">Cancel</button>
        </div>
      </div>`;
    } else {
      const expanded = _articleExpanded.has(key);
      const long = art.text.length>240;
      const preview = long && !expanded ? art.text.slice(0,240)+"…" : art.text;
      articleHtml = `<div class="research-article">
        <div class="research-article-text">${esc(preview)}</div>
        ${long?`<button class="btn-ghost" onclick="toggleArticleExpanded('${scope}','${it.id}')">${expanded?"Show less":"Show full article"}</button>`:""}
        ${art.sources.length?`<div class="hint">Sources: ${art.sources.map(u=>`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(domain(u)||u)}</a>`).join(", ")}</div>`:""}
        <div style="display:flex;gap:8px;margin-top:6px">
          <button class="btn-ghost" onclick="copyArticleText('${scope}','${it.id}')">Copy</button>
          <button class="btn-ghost" onclick="toggleArticleEdit('${scope}','${it.id}')">Edit</button>
          <button class="btn-ghost" ${busy?"disabled":""} onclick="generateArticle('${scope}','${it.id}')">${busy?"Regenerating…":"&#8635; Regenerate"}</button>
        </div>
      </div>`;
    }
  }
```

(This replaces the single `articleHtml = ...` assignment Task 2 wrote for the `art` truthy case — the `if(!art){...} else {...}` outer shape stays, only the `else` body's content changes to add the `editing` branch.)

Apply the identical changes to `pwa/index.html`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/research-edit.test.js`
Expected: PASS for both `web` and `pwa`.

- [ ] **Step 5: Run the full suite and syntax gate**

Run: `node tests/syntax-check.js && npm test`
Expected: both green, including Task 2's `research-article.test.js` (its view-mode assertions must still hold now that the `else` branch has an inner `editing` conditional).

- [ ] **Step 6: Commit**

```bash
git add web/index.html pwa/index.html tests/research-edit.test.js
git commit -m "AI research: article editing (textarea, save, cancel)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Q&A — ask a question, growing answer list, delete an entry

**Files:**
- Modify: `web/index.html` (new functions after Task 3's block; extend `researchPanelHTML` to append the Q&A section; new CSS near Task 2's rules)
- Modify: `pwa/index.html` (same edits)
- Test: `tests/research-qa.test.js` (new)

**Interfaces:**
- Consumes: `hasResearchProvider()`, `_researchCard(scope,id)`, `buildQuestionPrompt(it,question)`, `parseResearchResponse(text)` (Task 1); `_researchBusy` (Task 2); `researchPanelHTML` (Task 2/3, extended in place).
- Produces: `askQuestion(scope, id)` (async), `deleteQaEntry(scope, id, idx)`. `researchPanelHTML` now also renders the question input and the `research.qa` list.

- [ ] **Step 1: Write the failing test**

Create `tests/research-qa.test.js`:

```js
// tests/research-qa.test.js — Task 4: per-card Q&A. Same AI-call orchestration
// shape as generateArticle (provider gate, busy guard, stale-reference re-resolve)
// but APPENDS to research.qa rather than replacing research.article — per the
// design spec, "entries are not edited in place, only added — deleting an entry
// is the only mutation." Uses the queued async-runner pattern (async test bodies).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let passed = 0, failed = 0;
const queue = [];
function t(n, fn) { queue.push([n, fn]); }
function fn(src, name) { const m = extractFn(src, name); assert.ok(m, name + " not found in source"); return m; }

function loadAskQuestion(src, state, callAI) {
  const body = [
    src.match(/const RESEARCH_PROVIDERS[^;]+;/)[0],
    fn(src, "hasResearchProvider"), fn(src, "_researchCard"), fn(src, "buildQuestionPrompt"),
    fn(src, "parseResearchResponse"), fn(src, "askQuestion"),
  ].join("\n");
  const factory = new Function(
    "S", "imported", "saved", "callAI", "toast", "renderTabsView", "Store", "document",
    body + "\nreturn { askQuestion: askQuestion, getBusy: function(){ return _researchBusy; } };"
  );
  return factory(
    state.S || { provider: "anthropic" }, state.imported || [], state.saved || [],
    callAI, state.toast || (()=>{}), state.renderTabsView || (()=>{}),
    state.Store || { putCards: ()=>{}, putSaved: ()=>{} },
    state.document || { getElementById: () => ({ value: state.question != null ? state.question : "How much does it cost?" }) }
  );
}

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": askQuestion appends a parsed answer to research.qa, never replacing prior entries", async () => {
    const impArr = [{ id: "i0", title: "Ferrofluid displays", research: { article: null, qa: [{ question: "Old Q", answer: "Old A", sources: [], answeredAt: 1 }] } }];
    const calls = [];
    const api = loadAskQuestion(src, {
      imported: impArr,
      renderTabsView: () => calls.push("render"),
      Store: { putCards: (arr) => calls.push(["putCards", arr]), putSaved: () => {} },
    }, async () => "It costs about $200.\n\nSOURCES:\nhttps://example.com/price");
    await api.askQuestion("imported", "i0");
    assert.strictEqual(impArr[0].research.qa.length, 2);
    assert.deepStrictEqual(impArr[0].research.qa[0], { question: "Old Q", answer: "Old A", sources: [], answeredAt: 1 });
    assert.strictEqual(impArr[0].research.qa[1].question, "How much does it cost?");
    assert.strictEqual(impArr[0].research.qa[1].answer, "It costs about $200.");
    assert.deepStrictEqual(impArr[0].research.qa[1].sources, ["https://example.com/price"]);
    assert.ok(typeof impArr[0].research.qa[1].answeredAt === "number");
  });

  t(label + ": askQuestion initializes research/research.qa on a card that has neither yet", async () => {
    const impArr = [{ id: "i0", title: "X" }];
    const api = loadAskQuestion(src, { imported: impArr }, async () => "An answer.\n\nSOURCES:\nhttps://example.com/a");
    await api.askQuestion("imported", "i0");
    assert.strictEqual(impArr[0].research.article, undefined === impArr[0].research.article ? impArr[0].research.article : impArr[0].research.article);
    assert.strictEqual(impArr[0].research.qa.length, 1);
  });

  t(label + ": askQuestion is a no-op when the input is empty/whitespace-only", async () => {
    const impArr = [{ id: "i0", title: "X" }];
    let aiCalled = false;
    const api = loadAskQuestion(src, { imported: impArr, question: "   " }, async () => { aiCalled = true; return ""; });
    await api.askQuestion("imported", "i0");
    assert.strictEqual(aiCalled, false);
    assert.strictEqual(impArr[0].research, undefined);
  });

  t(label + ": askQuestion refuses when the configured provider isn't web-search-capable", async () => {
    const impArr = [{ id: "i0", title: "X" }];
    let aiCalled = false;
    const toasts = [];
    const api = loadAskQuestion(src, { S: { provider: "local" }, imported: impArr, toast: (m)=>toasts.push(m) }, async () => { aiCalled = true; return ""; });
    await api.askQuestion("imported", "i0");
    assert.strictEqual(aiCalled, false);
    assert.ok(toasts.length && /provider/i.test(toasts[0]));
  });

  t(label + ": askQuestion discards its result if the card was deleted while the AI call was in flight", async () => {
    const impArr = [{ id: "i0", title: "X" }];
    const calls = [];
    let resolveAi;
    const api = loadAskQuestion(src, {
      imported: impArr,
      renderTabsView: () => calls.push("render"),
      Store: { putCards: () => calls.push("putCards"), putSaved: () => {} },
    }, () => new Promise(r => { resolveAi = r; }));
    const p = api.askQuestion("imported", "i0");
    impArr.length = 0;
    resolveAi("An answer.\n\nSOURCES:\nhttps://example.com/a");
    await p;
    assert.ok(!calls.includes("putCards"));
    assert.ok(calls.includes("render"));
  });

  t(label + ": askQuestion toasts and appends nothing on a thrown AI call", async () => {
    const impArr = [{ id: "i0", title: "X" }];
    const toasts = [];
    const api = loadAskQuestion(src, { imported: impArr, toast: (m)=>toasts.push(m) }, async () => { throw new Error("rate limited"); });
    await api.askQuestion("imported", "i0");
    assert.strictEqual(impArr[0].research, undefined);
    assert.ok(toasts.some(m => /rate limited/.test(m)));
  });

  t(label + ": deleteQaEntry splices exactly the given index, persists, re-renders", () => {
    const impArr = [{ id: "i0", research: { article: null, qa: [{ question: "A" }, { question: "B" }, { question: "C" }] } }];
    const calls = [];
    const factory = new Function(
      "imported", "saved", "Store", "renderTabsView",
      fn(src, "_researchCard") + "\n" + fn(src, "deleteQaEntry") + "\nreturn deleteQaEntry;"
    );
    const deleteQaEntry = factory(impArr, [], { putCards: (arr)=>calls.push(["putCards",arr]), putSaved: ()=>{} }, ()=>calls.push("render"));
    deleteQaEntry("imported", "i0", 1);
    assert.deepStrictEqual(impArr[0].research.qa.map(q=>q.question), ["A", "C"]);
    assert.ok(calls.some(c => Array.isArray(c) && c[0] === "putCards"));
    assert.ok(calls.includes("render"));
  });

  t(label + ": researchPanelHTML renders the ask input and every existing Q&A entry with a Delete button", () => {
    const factory = new Function(
      "_researchBusy", "_articleEditing", "_articleExpanded", "esc", "domain",
      fn(src, "researchPanelHTML") + "\nreturn researchPanelHTML;"
    );
    const researchPanelHTML = factory(new Set(), new Set(), new Set(), (s)=>s, ()=>"");
    const it = { id: "i0", research: { article: null, qa: [{ question: "How much?", answer: "$200", sources: [], answeredAt: 1 }] } };
    const out = researchPanelHTML("imported", it);
    assert.match(out, /id="qaInput_imported_i0"/);
    assert.match(out, /askQuestion\('imported','i0'\)/);
    assert.match(out, /How much\?/);
    assert.match(out, /\$200/);
    assert.match(out, /deleteQaEntry\('imported','i0',0\)/);
  });

  t(label + ": researchPanelHTML disables the ask input/button while busy", () => {
    const factory = new Function(
      "_researchBusy", "_articleEditing", "_articleExpanded", "esc", "domain",
      fn(src, "researchPanelHTML") + "\nreturn researchPanelHTML;"
    );
    const researchPanelHTML = factory(new Set(["imported:i0"]), new Set(), new Set(), (s)=>s, ()=>"");
    const it = { id: "i0", research: { article: null, qa: [] } };
    const out = researchPanelHTML("imported", it);
    assert.match(out, /id="qaInput_imported_i0"[^>]*disabled/);
  });
}

(async () => {
  for (const [n, fn] of queue) {
    try { await fn(); passed++; console.log("  ok  " + n); }
    catch (e) { failed++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); }
  }
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/research-qa.test.js`
Expected: FAIL — `askQuestion`, `deleteQaEntry` don't exist; `researchPanelHTML` doesn't render the ask input or Q&A list yet.

- [ ] **Step 3: Write the implementation**

In `web/index.html`, immediately after Task 3's block (after `saveArticleEdit`'s closing `}`), insert:

```js
async function askQuestion(scope, id){
  if(!_researchCard(scope, id)) return;
  if(!hasResearchProvider()){ toast("Asking a question needs a web-search-capable provider (Claude, ChatGPT, Gemini, or OpenRouter) — switch in Settings", 6000); return; }
  const inp = document.getElementById("qaInput_"+scope+"_"+id); if(!inp) return;
  const question = inp.value.trim();
  if(!question) return;
  const key = scope+":"+id;
  if(_researchBusy.has(key)) return;
  const promptIt = _researchCard(scope, id);
  _researchBusy.add(key);
  renderTabsView();
  try{
    const text = await callAI(buildQuestionPrompt(promptIt, question), {webSearch:true});
    const parsed = parseResearchResponse(text);
    // Re-resolve by id — same stale-reference guard as generateArticle (Task 2).
    const it = _researchCard(scope, id);
    if(it){
      if(!it.research) it.research = {article:null, qa:[]};
      if(!it.research.qa) it.research.qa = [];
      it.research.qa.push({question:question, answer:parsed.text, sources:parsed.sources, answeredAt:Date.now()});
      if(scope==="saved") Store.putSaved(saved); else Store.putCards(imported);
      toast("Answered");
    }
  }catch(e){
    toast("Couldn't answer: "+(e&&e.message||e));
  }finally{
    _researchBusy.delete(key);
    renderTabsView();
  }
}
function deleteQaEntry(scope, id, idx){
  const it = _researchCard(scope, id); if(!it || !it.research || !it.research.qa) return;
  it.research.qa.splice(idx,1);
  if(scope==="saved") Store.putSaved(saved); else Store.putCards(imported);
  renderTabsView();
}
```

Then extend `researchPanelHTML`'s final `return` statement — replace:

```js
  return `<div class="research-panel">${articleHtml}</div>`;
}
```

with:

```js
  const qaList = ((it.research && it.research.qa) || []).map((qa,i)=>`
    <div class="research-qa">
      <div class="research-q"><b>Q:</b> ${esc(qa.question)}</div>
      <div class="research-a"><b>A:</b> ${esc(qa.answer)}</div>
      ${qa.sources.length?`<div class="hint">Sources: ${qa.sources.map(u=>`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(domain(u)||u)}</a>`).join(", ")}</div>`:""}
      <button class="btn-ghost" onclick="deleteQaEntry('${scope}','${it.id}',${i})">Delete</button>
    </div>`).join("");
  return `<div class="research-panel">
    ${articleHtml}
    <div class="research-qa-ask" style="display:flex;gap:8px;margin-top:10px">
      <input id="qaInput_${scope}_${it.id}" type="text" placeholder="Ask a question about this…" ${busy?"disabled":""}>
      <button ${busy?"disabled":""} onclick="askQuestion('${scope}','${it.id}')">${busy?"…":"Ask"}</button>
    </div>
    ${qaList}
  </div>`;
}
```

Apply the identical changes to `pwa/index.html`.

Add CSS near Task 2's `.research-*` rules:

```css
.research-qa{margin-top:10px;padding-top:8px;border-top:1px dashed var(--line);font-size:13.5px}
.research-q{margin-bottom:4px}
.research-a{white-space:pre-wrap}
```

Apply the same rules to `pwa/index.html`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/research-qa.test.js`
Expected: PASS for both `web` and `pwa`.

- [ ] **Step 5: Run the full suite and syntax gate**

Run: `node tests/syntax-check.js && npm test`
Expected: both green — including Tasks 2/3's `research-article.test.js`/`research-edit.test.js`, whose `researchPanelHTML` assertions must still hold now that its return statement has grown the Q&A section.

- [ ] **Step 6: Commit**

```bash
git add web/index.html pwa/index.html tests/research-qa.test.js
git commit -m "AI research: per-card Q&A (ask, growing answer list, delete)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Parity test, SHELL_CACHE bump, final regression

**Files:**
- Create: `tests/research-parity.test.js`
- Modify: `pwa/sw.js` (SHELL_CACHE bump)
- Modify: `web/index.html` / `pwa/index.html` only if the parity test finds a drift (none expected — every prior task already edited both files identically)

**Interfaces:**
- Consumes: every function this plan introduced across Tasks 1-4.
- Produces: nothing new — this task is verification + the required cache bump.

- [ ] **Step 1: Write the failing test**

Create `tests/research-parity.test.js`:

```js
// tests/research-parity.test.js — Task 5: every pure-logic and UI function this
// plan introduced (Tasks 1-4) must be byte-identical between web/index.html and
// pwa/index.html. Same technique as tests/tabs-parity.test.js (Plan 2).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

const FNS = [
  "hasResearchProvider", "_researchCard", "buildArticlePrompt", "buildQuestionPrompt", "parseResearchResponse",
  "generateArticle", "copyArticleText", "toggleArticleExpanded",
  "toggleArticleEdit", "saveArticleEdit",
  "askQuestion", "deleteQaEntry",
  "researchPanelHTML",
];

for (const name of FNS) {
  t(name + " is byte-identical between web and pwa", () => {
    const a = extractFn(html, name), b = extractFn(pwaHtml, name);
    assert.ok(a, name + " not found in web/index.html");
    assert.ok(b, name + " not found in pwa/index.html");
    assert.strictEqual(a, b);
  });
}

t("RESEARCH_PROVIDERS declaration is byte-identical between web and pwa", () => {
  const a = html.match(/const RESEARCH_PROVIDERS[^;]+;/);
  const b = pwaHtml.match(/const RESEARCH_PROVIDERS[^;]+;/);
  assert.ok(a && b);
  assert.strictEqual(a[0], b[0]);
});

t("renderTabsView's card loop wires researchPanelHTML gated on t.reserved", () => {
  const a = extractFn(html, "renderTabsView"), b = extractFn(pwaHtml, "renderTabsView");
  assert.match(a, /if\(t\.reserved\)\s*inner\s*\+=\s*researchPanelHTML\(r\.kind,\s*r\.it\)/);
  assert.strictEqual(a, b);
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/research-parity.test.js`
Expected: PASS already, if Tasks 1-4 were applied identically to both files as specified — this step exists to catch any drift, not because failure is expected. If it fails, diff the two files at the named function and fix the divergence before proceeding.

- [ ] **Step 3: Bump SHELL_CACHE**

In `pwa/sw.js`, find the current `SHELL_CACHE` version string (search for `const SHELL_CACHE =`) and increment its trailing version number by one (e.g. `"interests-pwa-shell-v80"` → `"interests-pwa-shell-v81"` — read the actual current value at implementation time; Tasks 1-4 do not touch `pwa/sw.js`, so whatever the value is when Task 5 starts is the one to increment).

- [ ] **Step 4: Run the full suite and syntax gate**

Run: `node tests/syntax-check.js && npm test`
Expected: `ALL TEST FILES PASSED`, 0 failures, including every test file from Tasks 1-4 plus this task's own `research-parity.test.js`.

- [ ] **Step 5: Commit**

```bash
git add tests/research-parity.test.js pwa/sw.js
git commit -m "AI research: parity test, SHELL_CACHE bump

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 6: Manual smoke check (reserved for after the final whole-branch review)**

Not part of automated testing — do this together with the user on the real desktop app, same precedent as Plans 1 and 2:
1. Open the 🤖 AI tab, flag a card into it (via the tag picker's pinned Tabs section or bulk Add-to-tab).
2. Click "Research & draft article" — confirm an article with sources appears (or, if the configured provider is Groq/Local, confirm the toast fires and no call is made — check Settings first if testing the happy path).
3. Click Edit, change the text, Save — confirm it persists across a reload.
4. Click Regenerate — confirm the article is replaced.
5. Type a question, click Ask — confirm an answer with sources is appended below the article, and a second question adds a second entry without disturbing the first.
6. Delete a Q&A entry — confirm only that one entry disappears.
7. Click Copy — confirm the article text lands on the clipboard (paste somewhere to check).
8. Switch to a non-capable provider (Groq or Local) in Settings, return to the AI tab — confirm both "Research & draft article" (on a fresh, un-researched card) and "Ask a question" show the toast instead of running.
