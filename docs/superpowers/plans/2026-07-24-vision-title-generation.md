# Vision-based title generation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `generateUniqueTitle()` a tiered fallback pipeline (OCR → vision LLM → deterministic collection-name label) so cards with no real text description can still get an accurate title, instead of always declining — while never reintroducing the hallucination bug the 2026-07-24 fix corrected.

**Architecture:** Every tier funnels through the *same* uniqueness/collision-retry/disambiguation logic that exists today (extracted into a shared `titleFromSignal()` helper), so the only thing that changes per tier is what grounding gets fed into the AI prompt (or, for Tier 3, no AI call at all). `web/ai.js` and `web/title-ai.js` gain small, backward-compatible optional-field extensions; `web/index.html`/`pwa/index.html` gain new browser-only helpers (image resolve/downscale, OCR, the vision model+cost picker) and a rewritten `generateUniqueTitle()`.

**Tech Stack:** Vanilla JS, `node:sqlite`-backed Core service (unchanged), Tesseract.js (loaded on demand from a CDN, no bundling — matches the existing JSZip lazy-load pattern), OpenRouter's public `/api/v1/models` endpoint.

## Global Constraints

- `web/index.html` and `pwa/index.html` changes must be applied to **both** files. Some existing tests in this codebase require byte-identical mirroring for specific regions (`tests/duplicate-review-mode.test.js`'s `featureSlice`); the title-quality feature region is **not** one of those — it's checked structurally per-file (see `tests/title-quality-wiring.test.js`), so both files must satisfy the same structural assertions, not be byte-identical, though in practice the code should be identical since there's no reason for it to differ.
- No tier may hand weak/unverified context (a bare collection name, a page slug) to an AI as if it were enough to invent specific post content — this is the one hard rule carried over from the 2026-07-24 hallucination-bug fix. Tier 3 is a plain deterministic label, never an AI call, for exactly this reason.
- Every new pure function gets a real Node `assert` test (no framework, `node tests/<name>.test.js`, matching existing convention). Browser-only helpers (image fetch/downscale, OCR) are structurally tested (function exists, correct constants/thresholds) plus manually verified in-browser — consistent with `dHashFromDataUrl` and friends already being untested-in-Node.
- Reuse `esc()` for any new HTML, `toast()` for user notifications, existing CSS variables for any new UI — no new build tooling, no bundler, no npm dependency (Tesseract.js loads from a CDN `<script>` tag at runtime, same as JSZip).

---

### Task 1: Tier 0 — `extractWeakContext()` + Tier 3's `composeFallbackTitle()`

**Files:**
- Modify: `web/title-ai.js`
- Test: `tests/title-ai.test.js`

**Interfaces:**
- Produces: `extractWeakContext(card) -> {collection: string, pageSlug: string}` (both `""` when not found). `composeFallbackTitle(collection) -> string`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/title-ai.test.js` (check the existing file's structure first — it already requires `../web/title-ai.js` directly; add these in the same style):

```js
const { extractWeakContext, composeFallbackTitle } = require("../web/title-ai.js");

// ---- extractWeakContext ----
t("extractWeakContext: extracts the collection name from the exact boilerplate string", () => {
  const r = extractWeakContext({ desc: "From your 'VR Stuff' Facebook collection", url: "https://facebook.com/x/posts/1" });
  assert.strictEqual(r.collection, "VR Stuff");
});
t("extractWeakContext: no match -> empty collection", () => {
  const r = extractWeakContext({ desc: "Saved from Facebook", url: "https://facebook.com/x/posts/1" });
  assert.strictEqual(r.collection, "");
});
t("extractWeakContext: missing desc -> empty collection, no throw", () => {
  const r = extractWeakContext({ url: "https://facebook.com/x/posts/1" });
  assert.strictEqual(r.collection, "");
});
t("extractWeakContext: extracts the page slug from a facebook.com URL", () => {
  const r = extractWeakContext({ desc: "", url: "https://www.facebook.com/uploadvr/posts/pfbid0abc" });
  assert.strictEqual(r.pageSlug, "uploadvr");
});
t("extractWeakContext: reel/permalink.php/etc are not page slugs", () => {
  assert.strictEqual(extractWeakContext({ url: "https://www.facebook.com/reel/12345/" }).pageSlug, "");
  assert.strictEqual(extractWeakContext({ url: "https://www.facebook.com/permalink.php?story_fbid=1&id=2" }).pageSlug, "");
  assert.strictEqual(extractWeakContext({ url: "https://www.facebook.com/watch/?v=1" }).pageSlug, "");
});
t("extractWeakContext: non-Facebook URL -> empty pageSlug", () => {
  assert.strictEqual(extractWeakContext({ url: "https://example.com/whatever" }).pageSlug, "");
});
t("extractWeakContext: missing/invalid url -> no throw, empty pageSlug", () => {
  assert.strictEqual(extractWeakContext({}).pageSlug, "");
  assert.strictEqual(extractWeakContext({ url: "not a url" }).pageSlug, "");
});

// ---- composeFallbackTitle ----
t("composeFallbackTitle: composes a factual, non-fabricated label", () => {
  assert.strictEqual(composeFallbackTitle("VR Stuff"), "VR Stuff — saved from a Facebook collection");
});
t("composeFallbackTitle: even a 1-character collection name produces a >=25-char result", () => {
  const out = composeFallbackTitle("X");
  assert.ok(out.length >= 25, "must clear isGenericTitle's length floor: " + out.length);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/title-ai.test.js`
Expected: FAIL — `extractWeakContext`/`composeFallbackTitle` are not exported/not defined.

- [ ] **Step 3: Implement in `web/title-ai.js`**

Add above the `var api = { ... }` line at the bottom of the IIFE:

```js
  // extractWeakContext(card) — the ONE genuine signal inside otherwise-inert
  // capture-time boilerplate: the user's own Facebook collection/list name.
  // Never enough alone for a confident title (see generateUniqueTitle's Tier
  // 3 in index.html) — only ever used as supplementary AI-prompt context, or
  // as the sole input to the deterministic (non-AI) fallback label.
  var FB_COLLECTION_RE = /^From your '(.+)' Facebook collection$/;
  var FB_NON_PAGE_SEGMENTS = { "reel": 1, "permalink.php": 1, "photo.php": 1, "watch": 1, "groups": 1, "story.php": 1, "share": 1, "p": 1 };
  function extractWeakContext(card) {
    var desc = String((card && card.desc) || "");
    var m = FB_COLLECTION_RE.exec(desc.trim());
    var collection = m ? m[1] : "";
    var pageSlug = "";
    try {
      var u = new URL(String((card && card.url) || ""));
      if (/(^|\.)facebook\.com$/i.test(u.hostname) || /(^|\.)fb\.watch$/i.test(u.hostname)) {
        var seg = (u.pathname.split("/").filter(Boolean)[0] || "");
        if (seg && !FB_NON_PAGE_SEGMENTS[seg.toLowerCase()]) pageSlug = seg;
      }
    } catch (e) {}
    return { collection: collection, pageSlug: pageSlug };
  }

  // composeFallbackTitle(collection) — Tier 3's deterministic, non-AI label
  // (generateUniqueTitle in index.html/pwa). Padding text is fixed so even a
  // 1-character collection name clears isGenericTitle()'s 25-char floor;
  // callers still re-check isGenericTitle() themselves as a backstop.
  function composeFallbackTitle(collection) {
    return String(collection || "").trim() + " — saved from a Facebook collection";
  }
```

Update the exports at the bottom:
```js
  var api = { buildTitlePrompt: buildTitlePrompt, parseTitleReply: parseTitleReply, extractWeakContext: extractWeakContext, composeFallbackTitle: composeFallbackTitle };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) { root.buildTitlePrompt = buildTitlePrompt; root.parseTitleReply = parseTitleReply; root.extractWeakContext = extractWeakContext; root.composeFallbackTitle = composeFallbackTitle; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/title-ai.test.js`
Expected: PASS, all tests including the new ones.

- [ ] **Step 5: Commit**

```bash
git add web/title-ai.js tests/title-ai.test.js
git commit -m "Add extractWeakContext + composeFallbackTitle for tiered title generation"
```

---

### Task 2: `web/ai.js` — model override (`opts.model`) for every provider caller

**Files:**
- Modify: `web/ai.js`
- Test: `tests/ai-module.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: every `callXxx(prompt, opts)` now honors `opts.model` (falls back to `s.models[provider]` exactly as before when absent). `callLocal` gains an `opts` parameter it didn't have before (previously `callLocal(prompt)` only).

- [ ] **Step 1: Write the failing tests**

Add to `tests/ai-module.test.js`:

```js
t("callAI opts.model overrides the configured model (gemini)", async () => {
  const settings = { provider:"gemini", keys:{ gemini:"KEY" }, models:{ gemini:"gemini-2.5-flash" }, localUrl:"" };
  IA_AI.configure(() => settings);
  let seenUrl;
  global.fetch = async (url) => { seenUrl = url; return { ok:true, json: async () => ({ candidates:[{ content:{ parts:[{ text:"hi" }] } }] }) }; };
  try {
    await IA_AI.callAI("P", { model: "gemini-2.5-pro" });
    assert.ok(seenUrl.indexOf("/models/gemini-2.5-pro:") >= 0, "used the override model, not the configured one: " + seenUrl);
  } finally { delete global.fetch; }
});
t("callAI opts.model overrides the configured model (anthropic)", async () => {
  IA_AI.configure(() => ({ provider:"anthropic", keys:{ anthropic:"K" }, models:{ anthropic:"claude-default" }, localUrl:"" }));
  let seenBody;
  global.fetch = async (_url, init) => { seenBody = JSON.parse(init.body); return { ok:true, json: async () => ({ content:[{ type:"text", text:"hi" }] }) }; };
  try {
    await IA_AI.callAI("P", { model: "claude-override" });
    assert.strictEqual(seenBody.model, "claude-override");
  } finally { delete global.fetch; }
});
t("callAI opts.model overrides the configured model (openai)", async () => {
  IA_AI.configure(() => ({ provider:"openai", keys:{ openai:"K" }, models:{ openai:"gpt-default" }, localUrl:"" }));
  let seenBody;
  global.fetch = async (_url, init) => { seenBody = JSON.parse(init.body); return { ok:true, json: async () => ({ output_text:"hi" }) }; };
  try {
    await IA_AI.callAI("P", { model: "gpt-override" });
    assert.strictEqual(seenBody.model, "gpt-override");
  } finally { delete global.fetch; }
});
t("callAI opts.model overrides the configured model (groq)", async () => {
  IA_AI.configure(() => ({ provider:"groq", keys:{ groq:"K" }, models:{ groq:"groq-default" }, localUrl:"" }));
  let seenBody;
  global.fetch = async (_url, init) => { seenBody = JSON.parse(init.body); return { ok:true, json: async () => ({ choices:[{ message:{ content:"hi" } }] }) }; };
  try {
    await IA_AI.callAI("P", { model: "groq-override" });
    assert.strictEqual(seenBody.model, "groq-override");
  } finally { delete global.fetch; }
});
t("callAI opts.model overrides the configured model (openrouter)", async () => {
  IA_AI.configure(() => ({ provider:"openrouter", keys:{ openrouter:"K" }, models:{ openrouter:"or-default" }, localUrl:"" }));
  let seenBody;
  global.fetch = async (_url, init) => { seenBody = JSON.parse(init.body); return { ok:true, json: async () => ({ choices:[{ message:{ content:"hi" } }] }) }; };
  try {
    await IA_AI.callAI("P", { model: "or-override" });
    assert.strictEqual(seenBody.model, "or-override");
  } finally { delete global.fetch; }
});
t("callAI opts.model overrides the configured model (local)", async () => {
  IA_AI.configure(() => ({ provider:"local", keys:{}, models:{ local:"local-default" }, localUrl:"http://x" }));
  let seenBody;
  global.fetch = async (_url, init) => { seenBody = JSON.parse(init.body); return { ok:true, json: async () => ({ choices:[{ message:{ content:"hi" } }] }) }; };
  try {
    await IA_AI.callAI("P", { model: "local-override" });
    assert.strictEqual(seenBody.model, "local-override");
  } finally { delete global.fetch; }
});
t("callAI without opts.model still uses the configured model (regression guard, all providers)", async () => {
  const cases = [
    ["gemini", (b, u) => u.indexOf("/models/gem-default:") >= 0],
    ["anthropic", (b) => b.model === "claude-default"],
    ["openai", (b) => b.model === "gpt-default"],
    ["groq", (b) => b.model === "groq-default"],
    ["openrouter", (b) => b.model === "or-default"],
  ];
  for (const [provider, check] of cases) {
    IA_AI.configure(() => ({ provider, keys:{ [provider]:"K" }, models:{ [provider]: provider==="gemini"?"gem-default":(provider+"-default") }, localUrl:"" }));
    let seenBody, seenUrl;
    global.fetch = async (url, init) => { seenUrl = url; seenBody = init && init.body ? JSON.parse(init.body) : null; return { ok:true, json: async () => ({ candidates:[{content:{parts:[{text:"hi"}]}}], content:[{type:"text",text:"hi"}], output_text:"hi", choices:[{message:{content:"hi"}}] }) }; };
    try {
      await IA_AI.callAI("P");
      assert.ok(check(seenBody, seenUrl), provider + " should use its configured default model when opts.model is absent");
    } finally { delete global.fetch; }
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/ai-module.test.js`
Expected: FAIL — `opts.model` is currently ignored by every provider caller (they all use `s.models.<provider>` unconditionally), and `callLocal` doesn't even accept a second parameter yet.

- [ ] **Step 3: Implement in `web/ai.js`**

Change each provider caller's signature and model line:

```js
  async function callAnthropic(prompt, opts) {
    opts = opts || {};
    var s = S();
    var r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": s.keys.anthropic,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: opts.model || s.models.anthropic, max_tokens: 6000,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
        messages: [{ role: "user", content: prompt }]
      })
    });
    if (!r.ok) throw new Error("Anthropic API error " + r.status + ": " + (await r.text()).slice(0, 300));
    var d = await r.json();
    return (d.content || []).filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join("\n");
  }
  async function callOpenAI(prompt, opts) {
    opts = opts || {};
    var s = S();
    var r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + s.keys.openai },
      body: JSON.stringify({ model: opts.model || s.models.openai, tools: [{ type: "web_search" }], input: prompt })
    });
    if (!r.ok) throw new Error("OpenAI API error " + r.status + ": " + (await r.text()).slice(0, 300));
    var d = await r.json();
    var out = "";
    (d.output || []).forEach(function (o) { if (o.type === "message") (o.content || []).forEach(function (c) { if (c.type === "output_text") out += c.text; }); });
    return out || d.output_text || "";
  }
  async function callGemini(prompt, opts) {
    opts = opts || {};
    var s = S();
    var url = "https://generativelanguage.googleapis.com/v1beta/models/" + (opts.model || s.models.gemini) + ":generateContent?key=" + s.keys.gemini;
    var r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }] })
    });
    if (!r.ok) throw new Error("Gemini API error " + r.status + ": " + (await r.text()).slice(0, 300));
    var d = await r.json();
    var parts = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
    return parts.map(function (p) { return p.text || ""; }).join("\n");
  }
  async function callGroq(prompt, opts) {
    opts = opts || {};
    var s = S();
    var r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + s.keys.groq },
      body: JSON.stringify({ model: opts.model || s.models.groq, temperature: 0.8, messages: [{ role: "user", content: prompt }] })
    });
    if (!r.ok) throw new Error("Groq API error " + r.status + ": " + (await r.text()).slice(0, 300));
    var d = await r.json();
    return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "";
  }
  async function callOpenRouter(prompt, opts) {
    var s = S();
    opts = opts || {};
    var body = { model: opts.model || s.models.openrouter, temperature: 0.8, messages: [{ role: "user", content: prompt }] };
    if (opts.webSearch) {
      body.max_tokens = 2500;
      body.tools = [{
        type: "openrouter:web_search",
        parameters: { max_results: 6, max_total_results: 6, search_context_size: "low" }
      }];
    }
    var r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json", "Authorization": "Bearer " + s.keys.openrouter,
        "HTTP-Referer": "http://localhost:3456", "X-Title": "Interests App"
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error("OpenRouter API error " + r.status + ": " + (await r.text()).slice(0, 300));
    var d = await r.json();
    return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "";
  }
  async function callLocal(prompt, opts) {
    opts = opts || {};
    var s = S();
    var headers = { "Content-Type": "application/json" };
    if (s.keys.local) headers["Authorization"] = "Bearer " + s.keys.local;
    var r = await fetch(s.localUrl + "/chat/completions", {
      method: "POST", headers: headers,
      body: JSON.stringify({ model: opts.model || s.models.local, temperature: 0.8, messages: [{ role: "user", content: prompt }] })
    }).catch(function () { throw new Error("Can't reach " + s.localUrl + ". If using Ollama, start it with OLLAMA_ORIGINS=* set."); });
    if (!r.ok) throw new Error("Endpoint error " + r.status + ": " + (await r.text()).slice(0, 300));
    var d = await r.json();
    return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "";
  }
```

(Only the signature line and the `model:`/URL line change per function — everything else is unchanged. `callOpenRouter` already took `opts`; the others are gaining it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/ai-module.test.js`
Expected: PASS, all tests including the new ones. Also run `node tests/run.js` once at the end of this task to confirm nothing else regressed (other callers of these functions never pass a 2nd arg today, so this is purely additive).

- [ ] **Step 5: Commit**

```bash
git add web/ai.js tests/ai-module.test.js
git commit -m "web/ai.js: support an opts.model override on every provider caller"
```

---

### Task 3: `web/ai.js` — multimodal image support (`opts.image`) for every provider caller

**Files:**
- Modify: `web/ai.js`
- Test: `tests/ai-module.test.js`

**Interfaces:**
- Consumes: `opts.image = {mediaType, base64}` (produced by `resolveCardImageForAI()` in Task 6).
- Produces: every `callXxx` builds the correct multimodal payload for its provider when `opts.image` is present; payload is byte-for-byte unchanged from Task 2 when absent.

- [ ] **Step 1: Write the failing tests**

Add to `tests/ai-module.test.js`:

```js
const SAMPLE_IMAGE = { mediaType: "image/jpeg", base64: "ZmFrZWJ5dGVz" };   // "fakebytes"

t("callAI opts.image builds an Anthropic image content block", async () => {
  IA_AI.configure(() => ({ provider:"anthropic", keys:{ anthropic:"K" }, models:{ anthropic:"m" }, localUrl:"" }));
  let seenBody;
  global.fetch = async (_url, init) => { seenBody = JSON.parse(init.body); return { ok:true, json: async () => ({ content:[{ type:"text", text:"hi" }] }) }; };
  try {
    await IA_AI.callAI("PROMPT", { image: SAMPLE_IMAGE });
    const content = seenBody.messages[0].content;
    assert.ok(Array.isArray(content), "content becomes an array when an image is attached");
    const img = content.find(b => b.type === "image");
    assert.deepStrictEqual(img.source, { type:"base64", media_type:"image/jpeg", data:"ZmFrZWJ5dGVz" });
    assert.ok(content.some(b => b.type === "text" && b.text === "PROMPT"));
  } finally { delete global.fetch; }
});
t("callAI opts.image builds an OpenAI input_image part", async () => {
  IA_AI.configure(() => ({ provider:"openai", keys:{ openai:"K" }, models:{ openai:"m" }, localUrl:"" }));
  let seenBody;
  global.fetch = async (_url, init) => { seenBody = JSON.parse(init.body); return { ok:true, json: async () => ({ output_text:"hi" }) }; };
  try {
    await IA_AI.callAI("PROMPT", { image: SAMPLE_IMAGE });
    const content = seenBody.input[0].content;
    assert.ok(content.some(c => c.type === "input_text" && c.text === "PROMPT"));
    assert.ok(content.some(c => c.type === "input_image" && c.image_url === "data:image/jpeg;base64,ZmFrZWJ5dGVz"));
  } finally { delete global.fetch; }
});
t("callAI opts.image builds a Gemini inline_data part", async () => {
  IA_AI.configure(() => ({ provider:"gemini", keys:{ gemini:"K" }, models:{ gemini:"m" }, localUrl:"" }));
  let seenBody;
  global.fetch = async (_url, init) => { seenBody = JSON.parse(init.body); return { ok:true, json: async () => ({ candidates:[{content:{parts:[{text:"hi"}]}}] }) }; };
  try {
    await IA_AI.callAI("PROMPT", { image: SAMPLE_IMAGE });
    const parts = seenBody.contents[0].parts;
    assert.ok(parts.some(p => p.text === "PROMPT"));
    assert.ok(parts.some(p => p.inline_data && p.inline_data.mime_type === "image/jpeg" && p.inline_data.data === "ZmFrZWJ5dGVz"));
  } finally { delete global.fetch; }
});
for (const [provider, urlKeyword] of [["groq", "api.groq.com"], ["openrouter", "openrouter.ai"]]) {
  t("callAI opts.image builds an image_url content part (" + provider + ")", async () => {
    IA_AI.configure(() => ({ provider, keys:{ [provider]:"K" }, models:{ [provider]:"m" }, localUrl:"" }));
    let seenBody;
    global.fetch = async (_url, init) => { seenBody = JSON.parse(init.body); return { ok:true, json: async () => ({ choices:[{message:{content:"hi"}}] }) }; };
    try {
      await IA_AI.callAI("PROMPT", { image: SAMPLE_IMAGE });
      const content = seenBody.messages[0].content;
      assert.ok(content.some(c => c.type === "text" && c.text === "PROMPT"));
      assert.ok(content.some(c => c.type === "image_url" && c.image_url.url === "data:image/jpeg;base64,ZmFrZWJ5dGVz"));
    } finally { delete global.fetch; }
  });
}
t("callAI opts.image builds an image_url content part (local)", async () => {
  IA_AI.configure(() => ({ provider:"local", keys:{}, models:{ local:"m" }, localUrl:"http://x" }));
  let seenBody;
  global.fetch = async (_url, init) => { seenBody = JSON.parse(init.body); return { ok:true, json: async () => ({ choices:[{message:{content:"hi"}}] }) }; };
  try {
    await IA_AI.callAI("PROMPT", { image: SAMPLE_IMAGE });
    const content = seenBody.messages[0].content;
    assert.ok(content.some(c => c.type === "image_url" && c.image_url.url === "data:image/jpeg;base64,ZmFrZWJ5dGVz"));
  } finally { delete global.fetch; }
});
t("callAI without opts.image sends plain string content (regression guard, all providers)", async () => {
  const cases = [
    ["anthropic", (b) => b.messages[0].content === "P"],
    ["openai", (b) => b.input === "P"],
    ["gemini", (b) => b.contents[0].parts[0].text === "P" && b.contents[0].parts.length === 1],
    ["groq", (b) => b.messages[0].content === "P"],
    ["openrouter", (b) => b.messages[0].content === "P"],
  ];
  for (const [provider, check] of cases) {
    IA_AI.configure(() => ({ provider, keys:{ [provider]:"K" }, models:{ [provider]:"m" }, localUrl:"" }));
    let seenBody;
    global.fetch = async (_url, init) => { seenBody = JSON.parse(init.body); return { ok:true, json: async () => ({ candidates:[{content:{parts:[{text:"hi"}]}}], content:[{type:"text",text:"hi"}], output_text:"hi", choices:[{message:{content:"hi"}}] }) }; };
    try {
      await IA_AI.callAI("P");
      assert.ok(check(seenBody), provider + " must keep sending a plain string content when no image is attached");
    } finally { delete global.fetch; }
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/ai-module.test.js`
Expected: FAIL — `opts.image` is currently ignored everywhere.

- [ ] **Step 3: Implement in `web/ai.js`**

Change the `content`/`input`/`parts` construction in each caller (everything else from Task 2 stays):

```js
  // callAnthropic: messages[0].content
  content: opts.image ? [
    { type: "image", source: { type: "base64", media_type: opts.image.mediaType, data: opts.image.base64 } },
    { type: "text", text: prompt }
  ] : prompt
```
```js
  // callOpenAI: replaces `input: prompt`
  input: opts.image ? [{
    role: "user",
    content: [
      { type: "input_text", text: prompt },
      { type: "input_image", image_url: "data:" + opts.image.mediaType + ";base64," + opts.image.base64 }
    ]
  }] : prompt
```
```js
  // callGemini: replaces `parts: [{ text: prompt }]`
  var parts = [{ text: prompt }];
  if (opts.image) parts.push({ inline_data: { mime_type: opts.image.mediaType, data: opts.image.base64 } });
  // ...body: JSON.stringify({ contents: [{ parts: parts }], tools: [{ google_search: {} }] })
```
```js
  // callGroq / callOpenRouter / callLocal: messages[0].content
  content: opts.image ? [
    { type: "text", text: prompt },
    { type: "image_url", image_url: { url: "data:" + opts.image.mediaType + ";base64," + opts.image.base64 } }
  ] : prompt
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/ai-module.test.js`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add web/ai.js tests/ai-module.test.js
git commit -m "web/ai.js: support an opts.image multimodal payload on every provider caller"
```

---

### Task 4: `web/ai.js` — `listVisionModels()` (OpenRouter model + cost discovery)

**Files:**
- Modify: `web/ai.js`
- Test: `tests/ai-module.test.js`

**Interfaces:**
- Produces: `IA_AI.listVisionModels() -> Promise<Array<{id, name, estCostPerCard}>>`, sorted cheapest-first.

- [ ] **Step 1: Write the failing test**

Add to `tests/ai-module.test.js` (the sample response shape below is a trimmed real capture from `GET https://openrouter.ai/api/v1/models`, 2026-07-24):

```js
t("listVisionModels: filters to image-capable models, sorts by estimated cost", async () => {
  global.fetch = async (url) => {
    assert.strictEqual(url, "https://openrouter.ai/api/v1/models");
    return { ok:true, json: async () => ({ data: [
      { id:"openai/gpt-4o-mini", name:"OpenAI: GPT-4o-mini", architecture:{ input_modalities:["text","image","file"] }, pricing:{ prompt:"0.00000015", completion:"0.0000006" } },
      { id:"meta-llama/llama-3.3-70b-instruct:free", name:"Llama 3.3 70B", architecture:{ input_modalities:["text"] }, pricing:{ prompt:"0", completion:"0" } },
      { id:"anthropic/claude-sonnet-4", name:"Claude Sonnet 4", architecture:{ input_modalities:["text","image"] }, pricing:{ prompt:"0.000003", completion:"0.000015" } },
    ] }) };
  };
  try {
    const models = await IA_AI.listVisionModels();
    assert.deepStrictEqual(models.map(m => m.id), ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4"], "text-only model excluded; cheapest first");
    assert.ok(models[0].estCostPerCard > 0);
    assert.ok(models[0].estCostPerCard < models[1].estCostPerCard);
    assert.strictEqual(models[0].name, "OpenAI: GPT-4o-mini");
  } finally { delete global.fetch; }
});
t("listVisionModels: throws a clear error on a non-ok response", async () => {
  global.fetch = async () => ({ ok:false, status:503 });
  try {
    await assert.rejects(IA_AI.listVisionModels(), /OpenRouter models API error 503/);
  } finally { delete global.fetch; }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node tests/ai-module.test.js`
Expected: FAIL — `IA_AI.listVisionModels` is not a function.

- [ ] **Step 3: Implement in `web/ai.js`**

Add near the other provider functions (after `callLocal`, before `var PROVIDER_CALLERS = ...`):

```js
  // listVisionModels() — OpenRouter only (see design doc's Research section:
  // Gemini's models.list API exposes neither modality nor pricing fields).
  // Public, unauthenticated endpoint. estCostPerCard is an ESTIMATE: a fixed
  // image-token budget for our ~1024px downscaled JPEG (see
  // resolveCardImageForAI) plus the prompt/completion tokens a title call
  // actually uses, priced at the model's published per-token rate. Different
  // providers tile images differently, so this is a ballpark for picking a
  // model, not an exact bill.
  var VISION_EST_IMAGE_TOKENS = 1500, VISION_EST_PROMPT_TOKENS = 250, VISION_EST_COMPLETION_TOKENS = 20;
  async function listVisionModels() {
    var r = await fetch("https://openrouter.ai/api/v1/models");
    if (!r.ok) throw new Error("OpenRouter models API error " + r.status);
    var d = await r.json();
    return (d.data || [])
      .filter(function (m) { return m.architecture && Array.isArray(m.architecture.input_modalities) && m.architecture.input_modalities.indexOf("image") >= 0; })
      .map(function (m) {
        var promptPrice = Number(m.pricing && m.pricing.prompt) || 0;
        var completionPrice = Number(m.pricing && m.pricing.completion) || 0;
        var estCostPerCard = (VISION_EST_IMAGE_TOKENS + VISION_EST_PROMPT_TOKENS) * promptPrice + VISION_EST_COMPLETION_TOKENS * completionPrice;
        return { id: m.id, name: m.name || m.id, estCostPerCard: estCostPerCard };
      })
      .sort(function (a, b) { return a.estCostPerCard - b.estCostPerCard; });
  }
```

Add `listVisionModels: listVisionModels,` to the `var IA_AI = { ... }` export object.

- [ ] **Step 4: Run test to verify it passes**

Run: `node tests/ai-module.test.js`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add web/ai.js tests/ai-module.test.js
git commit -m "web/ai.js: add listVisionModels() for OpenRouter model+cost discovery"
```

---

### Task 5: `web/title-ai.js` — `buildTitlePrompt()` gains `ocr`/`hasImage`/`collection` context

**Files:**
- Modify: `web/title-ai.js`
- Test: `tests/title-ai.test.js`

**Interfaces:**
- Consumes: nothing new externally.
- Produces: `buildTitlePrompt({url, domain, description, avoidTitles, hasImage, ocr, collection})` — all four new fields optional; omitting them reproduces today's exact prompt text.

- [ ] **Step 1: Write the failing tests**

Add to `tests/title-ai.test.js`:

```js
t("buildTitlePrompt: unchanged output when no new flags are passed (regression guard)", () => {
  const before = buildTitlePrompt({ url:"https://x.com/a", domain:"x.com", description:"d" });
  assert.ok(!/attached/i.test(before));
  assert.ok(!/OCR/i.test(before));
  assert.ok(!/collection/i.test(before));
});
t("buildTitlePrompt: hasImage adds an image-grounding instruction", () => {
  const p = buildTitlePrompt({ url:"u", domain:"d", description:"", hasImage:true });
  assert.match(p, /image of the actual saved content is attached/i);
});
t("buildTitlePrompt: ocr adds an approximate-text caveat", () => {
  const p = buildTitlePrompt({ url:"u", domain:"d", description:"extracted text", ocr:true });
  assert.match(p, /OCR/i);
  assert.match(p, /approximate/i);
});
t("buildTitlePrompt: collection is included as supplementary context, not a standalone claim", () => {
  const p = buildTitlePrompt({ url:"u", domain:"d", description:"d", collection:"VR Stuff" });
  assert.match(p, /VR Stuff/);
  assert.match(p, /context only/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/title-ai.test.js`
Expected: FAIL — the new flags are silently ignored today.

- [ ] **Step 3: Implement in `web/title-ai.js`**

Replace `buildTitlePrompt`:

```js
  function buildTitlePrompt(info) {
    info = info || {};
    var url = String(info.url || "");
    var domain = String(info.domain || "");
    var description = String(info.description || "").slice(0, 1000);
    var avoidTitles = Array.isArray(info.avoidTitles) ? info.avoidTitles.filter(Boolean) : [];
    var hasImage = !!info.hasImage;
    var ocr = !!info.ocr;
    var collection = String(info.collection || "");
    var lines = [
      "Write ONE short, descriptive, specific title for this saved web page, 8 words or fewer.",
      "No platform names (Facebook/Instagram/Pinterest/etc), no generic filler like \"Post\" or \"Video\" — describe the actual subject."
    ];
    if (hasImage) {
      lines.push("An image of the actual saved content is attached — base the title on what's shown. If the image contains legible text (e.g. a quote), use that as the primary basis. Otherwise describe what's depicted.");
    }
    if (ocr) {
      lines.push("The description below was extracted via OCR from an image and may contain minor recognition errors — treat it as approximate, not verbatim-perfect.");
    }
    lines.push("", "URL: " + url, "Domain: " + domain, "Description: " + description);
    if (collection) {
      lines.push("This was saved from the user's '" + collection + "' collection (context only — do not assume this describes the specific content).");
    }
    if (avoidTitles.length) {
      lines.push("");
      lines.push("Do not reuse any of these exact titles (already used elsewhere in the library):");
      avoidTitles.forEach(function (a) { lines.push("- " + String(a)); });
    }
    lines.push("");
    lines.push("Return ONLY the title, no quotes, no explanation.");
    return lines.join("\n");
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node tests/title-ai.test.js`
Expected: PASS, all tests including the existing pre-Task-5 ones (regression guard covers this).

- [ ] **Step 5: Commit**

```bash
git add web/title-ai.js tests/title-ai.test.js
git commit -m "web/title-ai.js: buildTitlePrompt gains hasImage/ocr/collection context"
```

---

### Task 6: `web/index.html` + `pwa/index.html` — `resolveCardImageForAI()` (image resolve + downscale)

**Files:**
- Modify: `web/index.html`, `pwa/index.html`
- Test: `tests/title-tiers-structural.test.js` (new file)

**Interfaces:**
- Produces: `async resolveCardImageForAI(card) -> {mediaType:"image/jpeg", base64} | null`.

- [ ] **Step 1: Write the failing structural test**

Create `tests/title-tiers-structural.test.js` (this file grows across Tasks 6-9; write the whole skeleton now):

```js
// tests/title-tiers-structural.test.js — structural checks (regex against the
// actual shipped source, no build step) for the browser-only pieces of the
// tiered title-generation pipeline that can't run in Node (canvas/fetch/OCR).
// Mirrors tests/title-quality-wiring.test.js's per-file convention.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": resolveCardImageForAI exists and downscales to a bounded edge", () => {
    const m = /async function resolveCardImageForAI\(card\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "resolveCardImageForAI not found");
    assert.match(m[1], /maxEdge\s*=\s*1024/);
    assert.match(m[1], /image\/jpeg/);
    assert.match(m[1], /quality\s*:\s*0\.7/);
    assert.match(m[1], /idb:/, "must handle idb:-backed images");
    assert.match(m[1], /Store\.ensureImage/);
  });
  t(label + ": resolveCardImageForAI returns null on failure, never throws to its caller", () => {
    const m = /async function resolveCardImageForAI\(card\)\{([\s\S]*?)\n\}/.exec(src);
    assert.match(m[1], /catch\s*\(e\)\{[^}]*return null;/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/title-tiers-structural.test.js`
Expected: FAIL — `resolveCardImageForAI` doesn't exist yet in either file.

- [ ] **Step 3: Implement in `web/index.html`**

Add immediately after the `allTitleKeys` function (after line 4738, before the `generateUniqueTitle` comment block at line 4739):

```js
// Resolves a card's image to downscaled JPEG bytes for an AI vision/OCR call
// (spec: docs/superpowers/specs/2026-07-24-vision-title-generation-design.md
// §3). Shared by the OCR tier and the vision tier — same downscale budget
// (1024px longest edge, ~0.7 JPEG quality) keeps payload/cost bounded for
// both. Returns null on ANY failure (no image, fetch/decode error) — callers
// treat null as "this tier can't run," never as an error to surface.
async function resolveCardImageForAI(card){
  try{
    const img = card && card.img;
    if(!img) return null;
    let srcUrl;
    if(String(img).indexOf("idb:")===0){
      const id = String(img).slice(4);
      await Store.ensureImage(id);
      srcUrl = Store.imgUrl(id);
    } else if(/^https?:\/\//i.test(img)){
      srcUrl = img;
    } else {
      return null;
    }
    const blob = await (await fetch(srcUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const maxEdge = 1024;
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width*scale)), h = Math.max(1, Math.round(bitmap.height*scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, w, h);
    const outBlob = await canvas.convertToBlob({type:"image/jpeg", quality:0.7});
    const buf = await outBlob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    for(let i=0;i<bytes.length;i++) binary += String.fromCharCode(bytes[i]);
    return { mediaType:"image/jpeg", base64: btoa(binary) };
  }catch(e){ console.warn("resolveCardImageForAI failed", e); return null; }
}
```

- [ ] **Step 4: Apply the identical addition to `pwa/index.html`**

Find the same `allTitleKeys` function in `pwa/index.html` (same content, different line number) and insert the identical block immediately after it, in the same position relative to `generateUniqueTitle`.

- [ ] **Step 5: Run the structural test and the syntax gate**

Run: `node tests/title-tiers-structural.test.js` — Expected: PASS.
Run: `node tests/syntax-check.js` — Expected: PASS (confirms both files still parse).

- [ ] **Step 6: Commit**

```bash
git add web/index.html pwa/index.html tests/title-tiers-structural.test.js
git commit -m "Add resolveCardImageForAI: shared image resolve+downscale for OCR/vision tiers"
```

---

### Task 7: `web/index.html` + `pwa/index.html` — OCR tier (`ocrExtractText`, Tesseract.js on demand)

**Files:**
- Modify: `web/index.html`, `pwa/index.html`
- Test: `tests/title-tiers-structural.test.js`

**Interfaces:**
- Consumes: `resolveCardImageForAI(card)` (Task 6).
- Produces: `async ocrExtractText(card) -> string | null`.

- [ ] **Step 1: Write the failing structural test**

Add to `tests/title-tiers-structural.test.js`, inside the existing `for (const [label, src] ...)` loop:

```js
  t(label + ": ocrExtractText loads Tesseract.js on demand and applies a confidence/length bar", () => {
    const m = /async function ocrExtractText\(card\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "ocrExtractText not found");
    assert.match(m[1], /resolveCardImageForAI\(card\)/);
    assert.match(m[1], /loadTesseract\(/);
    assert.match(m[1], /OCR_MIN_CHARS/);
    assert.match(m[1], /OCR_MIN_CONFIDENCE/);
  });
  t(label + ": OCR thresholds match the design spec (>=15 chars, >=60% confidence)", () => {
    assert.match(src, /const OCR_MIN_CHARS\s*=\s*15;/);
    assert.match(src, /const OCR_MIN_CONFIDENCE\s*=\s*60;/);
  });
  t(label + ": loadTesseract lazy-loads from a CDN, cached after first load", () => {
    const m = /function loadTesseract\(\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "loadTesseract not found");
    assert.match(m[1], /cdnjs\.cloudflare\.com|jsdelivr\.net|unpkg\.com/, "must load from a CDN, not bundle the library");
    assert.match(m[1], /window\.Tesseract/);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node tests/title-tiers-structural.test.js`
Expected: FAIL — none of `ocrExtractText`/`loadTesseract`/`OCR_MIN_CHARS`/`OCR_MIN_CONFIDENCE` exist yet.

- [ ] **Step 3: Implement in `web/index.html`**

Add immediately after `resolveCardImageForAI` (from Task 6):

```js
// Tier 1 of tiered title generation (spec §1): OCR the card's image via
// Tesseract.js, loaded on demand from a CDN the first time it's needed —
// same lazy-load pattern already used for JSZip (see CLAUDE.md's External
// Services list) — never bundled, zero cost for cards that never reach this
// tier. Cached after first load so repeated calls in one bulk-suggest run
// don't re-fetch the library.
const OCR_MIN_CHARS = 15;
const OCR_MIN_CONFIDENCE = 60;
let _tesseractLoad = null;
function loadTesseract(){
  if(window.Tesseract) return Promise.resolve(window.Tesseract);
  if(_tesseractLoad) return _tesseractLoad;
  _tesseractLoad = new Promise((resolve, reject)=>{
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js";
    s.onload = ()=>resolve(window.Tesseract);
    s.onerror = ()=>reject(new Error("Failed to load Tesseract.js"));
    document.head.appendChild(s);
  });
  return _tesseractLoad;
}
// Accept the OCR result only if it clears a real bar: garbage/noise text
// from plain photos (no actual overlaid text) routinely scores low
// confidence and must not be handed to the AI as if it were real content.
async function ocrExtractText(card){
  try{
    const image = await resolveCardImageForAI(card);
    if(!image) return null;
    const Tesseract = await loadTesseract();
    const dataUrl = "data:"+image.mediaType+";base64,"+image.base64;
    const result = await Tesseract.recognize(dataUrl, "eng");
    const words = (result && result.data && result.data.words) || [];
    const good = words.filter(w=>w.confidence>=OCR_MIN_CONFIDENCE).map(w=>w.text).join(" ").trim().replace(/\s+/g," ");
    return good.length>=OCR_MIN_CHARS ? good : null;
  }catch(e){ console.warn("ocrExtractText failed", e); return null; }
}
```

- [ ] **Step 4: Apply the identical addition to `pwa/index.html`**

Same block, immediately after `resolveCardImageForAI` in `pwa/index.html`.

- [ ] **Step 5: Run the structural test and the syntax gate**

Run: `node tests/title-tiers-structural.test.js` — Expected: PASS.
Run: `node tests/syntax-check.js` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/index.html pwa/index.html tests/title-tiers-structural.test.js
git commit -m "Add OCR tier: ocrExtractText via on-demand Tesseract.js"
```

---

### Task 8: `web/index.html` + `pwa/index.html` — rewrite `generateUniqueTitle()` as a tier dispatcher

This is the task that ties Tiers 0–3 together and is the most important to get
right — re-read the design spec's §1 before starting.

**Files:**
- Modify: `web/index.html`, `pwa/index.html`
- Test: `tests/title-quality-integration.test.js` (extend the existing harness), `tests/title-quality-wiring.test.js` (extend structural checks)

**Interfaces:**
- Consumes: `extractWeakContext`, `composeFallbackTitle` (Task 1, from `web/title-ai.js`), `ocrExtractText`, `resolveCardImageForAI` (Tasks 6-7), `buildTitlePrompt` (Task 5), `callAI` with `opts.image`/`opts.model` (Tasks 2-3).
- Produces: `generateUniqueTitle(card, extraAvoid) -> Promise<string|null>` — same signature and same external contract as today (callers in `enrichOnOpen` and `suggestTitlesForFlagged` need zero changes), but now runs the full tiered pipeline internally. Also produces `titleFromSignal(card, opts)` and `fallbackCollectionTitle(card, collection, extraAvoid)` as separate named functions (needed for isolated testing, per the design spec's testing section).
- A new module-level `let _titleVisionModel = "";` (empty = use the provider's configured default model) — set by Task 9's picker UI, read here.

- [ ] **Step 1: Write the failing tests**

Extend `tests/title-quality-integration.test.js`. First, update `loadTitleFns` to extract the new functions and inject fake `ocrExtractText`/`resolveCardImageForAI` (mirroring how `callAI` is already injected — these two are browser-only in the real app, so tests always supply a scripted fake):

```js
const { extractWeakContext, composeFallbackTitle } = require("../web/title-ai.js");

function loadTitleFns(aiReplies, opts) {
  opts = opts || {};
  let callCount = 0;
  const domain = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } };
  const callAI = async (prompt, callOpts) => { const r = aiReplies[callCount]; callCount++; if (r instanceof Error) throw r; return r; };
  const IA_AI = { hasAIKey: () => true };
  // Fakes for the browser-only tiers — real behavior is manually verified
  // (Task 10); these let the ORDERING/short-circuit logic be tested here.
  const ocrExtractText = opts.ocrExtractText || (async () => null);
  const resolveCardImageForAI = opts.resolveCardImageForAI || (async () => null);
  const sandbox = { imported: [], saved: [], buildTitlePrompt, parseTitleReply, domain, callAI, IA_AI, isGenericTitle, extractWeakContext, composeFallbackTitle, ocrExtractText, resolveCardImageForAI, console };
  const src = [
    extractFn(html, "normalizeTitleKey"),
    extractFn(html, "allTitleKeys"),
    extractFn(html, "titleFromSignal"),
    extractFn(html, "fallbackCollectionTitle"),
    extractFn(html, "generateUniqueTitle"),
  ].join("\n");
  const factory = new Function(
    "imported", "saved", "buildTitlePrompt", "parseTitleReply", "domain", "callAI", "IA_AI", "isGenericTitle",
    "extractWeakContext", "composeFallbackTitle", "ocrExtractText", "resolveCardImageForAI",
    src + "\nreturn { normalizeTitleKey, allTitleKeys, titleFromSignal, fallbackCollectionTitle, generateUniqueTitle };"
  );
  return {
    fns: factory(sandbox.imported, sandbox.saved, sandbox.buildTitlePrompt, sandbox.parseTitleReply, sandbox.domain, sandbox.callAI, sandbox.IA_AI, sandbox.isGenericTitle, sandbox.extractWeakContext, sandbox.composeFallbackTitle, sandbox.ocrExtractText, sandbox.resolveCardImageForAI),
    sandbox, callCountRef: () => callCount
  };
}
```

Then add new test cases (after the existing ones, before the final `console.log`):

```js
  await t("generateUniqueTitle Tier 1: uses OCR'd text as the description when there's no real desc", async () => {
    const { fns } = loadTitleFns(["A Title From OCR Text"], { ocrExtractText: async () => "some legible quote text" });
    const result = await fns.generateUniqueTitle({ id:"new", desc:"Saved from Facebook", url:"https://facebook.com/x/posts/1" });
    assert.strictEqual(result, "A Title From OCR Text");
  });

  await t("generateUniqueTitle Tier 2: falls back to vision when OCR finds nothing", async () => {
    const { fns } = loadTitleFns(["A Title From Vision"], {
      ocrExtractText: async () => null,
      resolveCardImageForAI: async () => ({ mediaType:"image/jpeg", base64:"xyz" }),
    });
    const result = await fns.generateUniqueTitle({ id:"new", desc:"Saved from Facebook", url:"https://facebook.com/x/posts/1", img:"idb:new" });
    assert.strictEqual(result, "A Title From Vision");
  });

  await t("generateUniqueTitle Tier 3: deterministic collection fallback when OCR and vision both fail", async () => {
    const { fns, callCountRef } = loadTitleFns([], {
      ocrExtractText: async () => null,
      resolveCardImageForAI: async () => null,
    });
    const result = await fns.generateUniqueTitle({ id:"new", desc:"From your 'VR Stuff' Facebook collection", url:"https://facebook.com/x/posts/1" });
    assert.strictEqual(result, "VR Stuff — saved from a Facebook collection");
    assert.strictEqual(callCountRef(), 0, "Tier 3 must never call the AI");
  });

  await t("generateUniqueTitle: declines when OCR, vision, AND collection are all unavailable", async () => {
    const { fns } = loadTitleFns([], { ocrExtractText: async () => null, resolveCardImageForAI: async () => null });
    const result = await fns.generateUniqueTitle({ id:"new", desc:"Saved from Facebook", url:"https://facebook.com/x/posts/1" });
    assert.strictEqual(result, null);
  });

  await t("generateUniqueTitle: a real description skips OCR/vision/fallback entirely (cheapest path first)", async () => {
    let ocrCalled = false, visionCalled = false;
    const { fns } = loadTitleFns(["A Real Title"], {
      ocrExtractText: async () => { ocrCalled = true; return null; },
      resolveCardImageForAI: async () => { visionCalled = true; return null; },
    });
    const result = await fns.generateUniqueTitle({ id:"new", desc:"A genuinely real description of the content", url:"https://x.com/new" });
    assert.strictEqual(result, "A Real Title");
    assert.strictEqual(ocrCalled, false);
    assert.strictEqual(visionCalled, false);
  });

  await t("fallbackCollectionTitle: respects uniqueness (disambiguates on collision)", async () => {
    const { fns, sandbox } = loadTitleFns([]);
    sandbox.imported.push({ id:"existing", title:"VR Stuff — saved from a Facebook collection", url:"https://x.com/e" });
    const result = await fns.fallbackCollectionTitle({ id:"new", url:"https://facebook.com/x" }, "VR Stuff", []);
    assert.strictEqual(result, "VR Stuff — saved from a Facebook collection (2)");
  });
```

Note: the pre-existing test "generateUniqueTitle returns null when desc is empty but a url is present" and "treats a 'Saved from X' placeholder desc as no real description" tests (added in the earlier 2026-07-24 fix) must still pass — with the default `loadTitleFns` fakes (`ocrExtractText`/`resolveCardImageForAI` both resolving to `null`/`no-op`), Tiers 1–2 contribute nothing and Tier 3 has no collection to work with either, so the pipeline still declines exactly as before. Confirm this rather than assuming — if either test needs its `loadTitleFns` call updated to pass explicit no-op tier fakes, do that as part of this task, not silently.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/title-quality-integration.test.js`
Expected: FAIL — `titleFromSignal`/`fallbackCollectionTitle` don't exist, and `generateUniqueTitle` doesn't yet call the new tiers.

- [ ] **Step 3: Implement in `web/index.html`**

Replace the entire current `generateUniqueTitle` function (the block starting `async function generateUniqueTitle(card, extraAvoid){` through its closing `}`, currently ~30 lines) with:

```js
// Vision model override for the Title Issues tab's "Suggest titles" flow
// (spec §2) — set by the picker UI, "" means "use the provider's configured
// default model." Only ever consulted by Tier 2 (vision); OCR/text tiers
// never need a model override. enrichOnOpen's single-card automatic refresh
// has no picker context and always uses "" (the default model).
let _titleVisionModel = "";

// Shared "ask the AI for one unique, non-generic title" loop. Used for every
// AI-backed tier (a real description, OCR'd text, or an attached image) —
// they differ only in what grounding is fed in; the uniqueness/retry/
// disambiguation logic below is identical either way.
async function titleFromSignal(card, opts){
  opts = opts || {};
  const description = opts.description || "";
  const dom = domain(card.url)||"";
  const existing = allTitleKeys(card.id);
  (opts.extraAvoid||[]).forEach(t=>existing.add(normalizeTitleKey(t)));
  let avoidTitles = [];
  const callOpts = {};
  if(opts.image) callOpts.image = opts.image;
  if(opts.model) callOpts.model = opts.model;
  for(let attempt=0; attempt<3; attempt++){
    let reply;
    try{
      reply = await callAI(buildTitlePrompt({url:card.url, domain:dom, description, avoidTitles, ocr:!!opts.ocr, hasImage:!!opts.image, collection:opts.collection}), callOpts);
    }
    catch(e){ console.warn("AI title generation failed", e); return null; }
    const candidate = parseTitleReply(reply);
    if(!candidate || isGenericTitle(candidate, card.url)){ if(candidate) avoidTitles = avoidTitles.concat([candidate]).slice(-3); continue; }
    const key = normalizeTitleKey(candidate);
    if(!existing.has(key)) return candidate;
    avoidTitles = avoidTitles.concat([candidate]).slice(-3);
  }
  // Still colliding/generic after 3 tries: disambiguate with the domain, then a numeric suffix.
  // If even the disambiguated title would still read as generic (e.g. no domain and every
  // candidate was too short), give up rather than apply a title the detector will just re-flag.
  const last = avoidTitles[avoidTitles.length-1] || (dom || "Untitled");
  let disambiguated = dom ? (last+" — "+dom) : last;
  if(isGenericTitle(disambiguated, card.url)) return null;
  if(!existing.has(normalizeTitleKey(disambiguated))) return disambiguated;
  let n=2;
  while(existing.has(normalizeTitleKey(disambiguated+" ("+n+")"))) n++;
  return disambiguated+" ("+n+")";
}

// Tier 3 (spec §1): deterministic, non-AI fallback — stating the user's true
// collection name is not a hallucination the way inventing what a specific
// post says would be. Still runs the same uniqueness/disambiguation as every
// other tier, just without any AI call or retry loop.
async function fallbackCollectionTitle(card, collection, extraAvoid){
  const candidate = composeFallbackTitle(collection);
  if(isGenericTitle(candidate, card.url)) return null;   // defensive backstop, see design spec §1 Tier 3
  const existing = allTitleKeys(card.id);
  (extraAvoid||[]).forEach(t=>existing.add(normalizeTitleKey(t)));
  if(!existing.has(normalizeTitleKey(candidate))) return candidate;
  let n=2;
  while(existing.has(normalizeTitleKey(candidate+" ("+n+")"))) n++;
  return candidate+" ("+n+")";
}

// Generates a unique, non-generic AI title for one card (imported OR saved —
// both use .title; description is .desc for imported, .benefit for saved).
// Tiered pipeline (spec: docs/superpowers/specs/2026-07-24-vision-title-
// generation-design.md), cheapest/most-certain first:
//   0. a real (non-boilerplate) description -> straight to the AI loop
//   1. OCR the card's image; if it finds legible text, treat that as the
//      description (cheaper AND more accurate than vision for quote cards)
//   2. no legible text -> a vision LLM call on the actual image
//   3. everything above failed/unavailable -> a plain, true, non-AI label
//      from the card's Facebook collection name, if it has one
// Returns null when NONE of the above produced anything (no AI key, or no
// signal of any kind). extraAvoid: additional in-flight titles to avoid
// (the Library-Health "Suggest titles" batch flow passes titles it already
// accepted earlier in the same run).
async function generateUniqueTitle(card, extraAvoid){
  if(!IA_AI.hasAIKey()) return null;
  const rawDesc = card.desc || card.benefit || "";
  // "Saved from Facebook"/"From your <list>" is placeholder boilerplate set at capture
  // time (see enrichOnOpen), not real content — treat it as no description, same as
  // the "is this a real description" check elsewhere in this file.
  const description = (rawDesc && !rawDesc.startsWith("Saved from") && !rawDesc.startsWith("From your")) ? rawDesc : "";
  const weak = extractWeakContext(card);
  if(description) return titleFromSignal(card, {description, extraAvoid, collection:weak.collection});

  const ocrText = await ocrExtractText(card);
  if(ocrText) return titleFromSignal(card, {description:ocrText, ocr:true, extraAvoid, collection:weak.collection});

  const image = await resolveCardImageForAI(card);
  if(image){
    const title = await titleFromSignal(card, {image, extraAvoid, collection:weak.collection, model:_titleVisionModel||undefined});
    if(title) return title;
  }

  if(weak.collection) return fallbackCollectionTitle(card, weak.collection, extraAvoid);
  return null;
}
```

- [ ] **Step 4: Apply the identical replacement to `pwa/index.html`**

Find the current `generateUniqueTitle` in `pwa/index.html` (same content as `web/index.html` had before this task) and replace it with the identical set of functions above, in the same position.

- [ ] **Step 5: Update `tests/title-quality-wiring.test.js`**

The existing assertion:
```js
t(label + ": generateUniqueTitle retries up to 3 times on collision, then disambiguates", () => {
  const m = /async function generateUniqueTitle\(card, ?extraAvoid\)\{([\s\S]*?)\n\}/.exec(src);
  ...
  assert.match(m[1], /attempt\s*<\s*3/, "should retry up to 3 times");
  assert.match(m[1], /buildTitlePrompt\(/);
  assert.match(m[1], /parseTitleReply\(/);
});
```
now looks inside the (much shorter) `generateUniqueTitle` body, which no longer directly contains the retry loop (that moved to `titleFromSignal`). Update it to:
```js
  t(label + ": generateUniqueTitle runs the tiered pipeline in order (desc -> OCR -> vision -> collection fallback)", () => {
    const m = /async function generateUniqueTitle\(card, ?extraAvoid\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "generateUniqueTitle not found");
    const body = m[1];
    const iDesc = body.indexOf("if(description)");
    const iOcr = body.indexOf("ocrExtractText(card)");
    const iVision = body.indexOf("resolveCardImageForAI(card)");
    const iFallback = body.indexOf("fallbackCollectionTitle(");
    assert.ok(iDesc >= 0 && iOcr > iDesc && iVision > iOcr && iFallback > iVision, "tiers must run in cost/certainty order");
  });
  t(label + ": titleFromSignal retries up to 3 times on collision, then disambiguates", () => {
    const m = /async function titleFromSignal\(card, ?opts\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "titleFromSignal not found");
    assert.match(m[1], /attempt\s*<\s*3/, "should retry up to 3 times");
    assert.match(m[1], /buildTitlePrompt\(/);
    assert.match(m[1], /parseTitleReply\(/);
  });
  t(label + ": fallbackCollectionTitle never calls the AI", () => {
    const m = /async function fallbackCollectionTitle\(card, ?collection, ?extraAvoid\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "fallbackCollectionTitle not found");
    assert.doesNotMatch(m[1], /callAI\(/);
    assert.match(m[1], /composeFallbackTitle\(/);
    assert.match(m[1], /isGenericTitle\(/);
  });
```
(Replace the old assertion in place; don't leave both.)

- [ ] **Step 6: Run all the affected tests**

Run: `node tests/title-quality-integration.test.js` — Expected: PASS, all tests (old and new).
Run: `node tests/title-quality-wiring.test.js` — Expected: PASS.
Run: `node tests/syntax-check.js` — Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/index.html pwa/index.html tests/title-quality-integration.test.js tests/title-quality-wiring.test.js
git commit -m "generateUniqueTitle: tiered pipeline (description -> OCR -> vision -> collection fallback)"
```

---

### Task 9: Vision model + cost picker UI (Title Issues tab, OpenRouter/Gemini only)

**Files:**
- Modify: `web/index.html`, `pwa/index.html`
- Test: `tests/title-tiers-structural.test.js`

**Interfaces:**
- Consumes: `IA_AI.listVisionModels()` (Task 4), `_titleVisionModel` (Task 8).
- Produces: a picker rendered inside `renderHealthTitles()`, visible only when `S.provider` is `"openrouter"` or `"gemini"`; selecting an option sets `_titleVisionModel`, consumed by Tier 2 in `generateUniqueTitle`.

- [ ] **Step 1: Write the failing structural tests**

Add to `tests/title-tiers-structural.test.js`, inside the loop:

```js
  t(label + ": GEMINI_VISION_MODELS is a curated, dated, all-multimodal list (design spec: Gemini's API exposes no pricing/modality)", () => {
    assert.match(src, /const GEMINI_VISION_MODELS\s*=\s*\[/);
    assert.match(src, /gemini-2\.5-flash-lite/);
  });
  t(label + ": loadVisionModelsForPicker dispatches OpenRouter (dynamic) vs Gemini (curated) vs everything else (none)", () => {
    const m = /async function loadVisionModelsForPicker\(\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "loadVisionModelsForPicker not found");
    assert.match(m[1], /IA_AI\.listVisionModels\(\)/);
    assert.match(m[1], /GEMINI_VISION_MODELS/);
  });
  t(label + ": the picker is wired into renderHealthTitles and writes to _titleVisionModel", () => {
    assert.match(src, /_titleVisionModel\s*=\s*this\.value/);
    const start = src.indexOf("function renderHealthTitles(list){");
    assert.ok(start >= 0, "renderHealthTitles not found");
    const region = src.slice(start, start + 4000);
    assert.match(region, /visionPickerHTML\(/);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node tests/title-tiers-structural.test.js`
Expected: FAIL — none of this exists yet.

- [ ] **Step 3: Implement in `web/index.html`**

Add immediately after `_titleVisionModel`'s declaration (from Task 8, near the top of the `generateUniqueTitle` block):

```js
let _titleVisionModels = null;   // cached picker options for the current provider; null = not loaded yet
// Curated Gemini vision models + approximate per-card cost (design spec's
// Research section: Gemini's models.list API exposes neither pricing nor a
// modality flag, unlike OpenRouter's — every current Gemini model is
// natively multimodal, so there's nothing to "discover" here beyond cost).
// [id, name, approxCostPerCard] — manually sourced from Google's published
// per-token rates, verified 2026-07-24; re-check periodically.
const GEMINI_VISION_MODELS = [
  ["gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite", 0.0006],
  ["gemini-2.5-flash", "Gemini 2.5 Flash", 0.0022],
  ["gemini-2.5-pro", "Gemini 2.5 Pro", 0.0110],
];
async function loadVisionModelsForPicker(){
  if(S.provider==="openrouter"){
    try{ return await IA_AI.listVisionModels(); }catch(e){ console.warn("listVisionModels failed", e); return []; }
  }
  if(S.provider==="gemini"){
    return GEMINI_VISION_MODELS.map(m=>({id:m[0], name:m[1], estCostPerCard:m[2]}));
  }
  return [];
}
function visionPickerHTML(models){
  if(!models || !models.length) return "";
  const opts = models.map(m=>`<option value="${esc(m.id)}"${m.id===_titleVisionModel?" selected":""}>${esc(m.name)} — ~$${m.estCostPerCard.toFixed(4)}/card</option>`).join("");
  return `<div class="s" style="padding:6px 4px 10px">Vision model for photos with no legible text:
    <select onchange="_titleVisionModel=this.value" style="margin-left:6px">${opts}</select></div>`;
}
```

Then modify `renderHealthTitles` (currently starts `function renderHealthTitles(list){`) to render the picker and lazily kick off the fetch on first entry to the tab. Insert right after the `const hasSuggestions = ...` line:

```js
  if(_titleVisionModels===null && (S.provider==="openrouter" || S.provider==="gemini")){
    _titleVisionModels = [];   // avoid re-triggering the fetch while it's in flight
    loadVisionModelsForPicker().then(models=>{ _titleVisionModels = models; if(_healthTab==="titles") renderHealthTitles(document.getElementById("healthList")); });
  }
```

And add `${visionPickerHTML(_titleVisionModels)}` into the returned template string, right after the `<div class="s" style="opacity:.75;...">...</div>` summary line and before the `flagged.map(...)` rows.

- [ ] **Step 4: Apply the identical additions to `pwa/index.html`**

Same three additions (the `let _titleVisionModels`/`GEMINI_VISION_MODELS`/`loadVisionModelsForPicker`/`visionPickerHTML` block, and the two `renderHealthTitles` insertions), in the same relative positions.

- [ ] **Step 5: Run the structural tests and the syntax gate**

Run: `node tests/title-tiers-structural.test.js` — Expected: PASS.
Run: `node tests/syntax-check.js` — Expected: PASS.
Run: `node tests/run.js` — Expected: ALL TEST FILES PASSED (full-suite regression check now that every piece is wired together).

- [ ] **Step 6: Commit**

```bash
git add web/index.html pwa/index.html tests/title-tiers-structural.test.js
git commit -m "Add vision model+cost picker to the Title Issues tab (OpenRouter/Gemini)"
```

---

### Task 10: Manual browser verification

**Files:** none (verification only).

- [ ] **Step 1:** Start the desktop app (or point the Browser pane at the running Core service, `http://localhost:3456`, as done earlier this session).
- [ ] **Step 2:** Open Library Health → Title issues. Confirm the vision model picker appears (provider is currently `openrouter` per earlier session state) with real model names and non-zero cost estimates, defaulted to the cheapest option.
- [ ] **Step 3:** Pick a handful of real flagged cards spanning the known cases: a quote-card image (OCR should fire — check the network tab / console for a Tesseract.js load and no vision API call), a plain photo (OCR should find nothing, vision API call should fire), and a card with a `"From your 'X' Facebook collection"` desc whose image fails to load (Tier 3 should produce `"X — saved from a Facebook collection"` with no AI call). Click "Suggest titles" for a small batch (10-20 cards, not the full 1,135) and confirm titles look accurate, not fabricated-sounding.
- [ ] **Step 4:** Verify `isGenericTitle()` accepts every produced title (none of the suggested rows should re-flag immediately after Apply).
- [ ] **Step 5:** Confirm `node tests/run.js` is fully green one final time after manual verification, in case anything was hand-edited during debugging.
- [ ] **Step 6:** Report results back — do NOT run this against the full 1,135-card backlog without explicit go-ahead, given the cost/scale lesson from the 2026-07-24 bulk-apply incident earlier today.
