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
    src.match(/let _researchBusy[^;]+;/)[0],
    fn(src, "hasResearchProvider"), fn(src, "_researchCard"), fn(src, "buildQuestionPrompt"),
    fn(src, "parseResearchResponse"), fn(src, "askQuestion"),
  ].join("\n");
  const factory = new Function(
    "S", "IA_AI", "PROVIDERS", "imported", "saved", "callAI", "toast", "renderTabsView", "Store", "document",
    body + "\nreturn { askQuestion: askQuestion, getBusy: function(){ return _researchBusy; } };"
  );
  return factory(
    state.S || { provider: "anthropic" },
    state.IA_AI || { hasAIKey: () => true },
    state.PROVIDERS || { anthropic: { keyName: "Anthropic API key" } },
    state.imported || [], state.saved || [],
    callAI, state.toast || (()=>{}), state.renderTabsView || (()=>{}),
    state.Store || { putCards: ()=>{}, putSaved: ()=>{} },
    state.document || { getElementById: () => ({ value: state.question != null ? state.question : "How much does it cost?" }) }
  );
}

// Loads generateArticle AND askQuestion together, sharing the same _researchBusy
// map — this is the only way to actually test the shared-busy-key serialization
// the design deliberately relies on (a card can't run both AI calls at once).
function loadBoth(src, state, callAI) {
  const body = [
    src.match(/const RESEARCH_PROVIDERS[^;]+;/)[0],
    src.match(/let _researchBusy[^;]+;/)[0],
    fn(src, "hasResearchProvider"), fn(src, "_researchCard"),
    fn(src, "buildArticlePrompt"), fn(src, "buildQuestionPrompt"),
    fn(src, "parseResearchResponse"), fn(src, "generateArticle"), fn(src, "askQuestion"),
  ].join("\n");
  const factory = new Function(
    "S", "IA_AI", "PROVIDERS", "imported", "saved", "callAI", "toast", "renderTabsView", "Store", "document",
    body + "\nreturn { generateArticle: generateArticle, askQuestion: askQuestion, getBusy: function(){ return _researchBusy; } };"
  );
  return factory(
    state.S || { provider: "anthropic" },
    state.IA_AI || { hasAIKey: () => true },
    state.PROVIDERS || { anthropic: { keyName: "Anthropic API key" } },
    state.imported || [], state.saved || [],
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

  t(label + ": askQuestion refuses when no API key is configured for a capable provider (final review Important #1)", async () => {
    const impArr = [{ id: "i0", title: "X" }];
    let aiCalled = false;
    const toasts = [];
    const api = loadAskQuestion(src, {
      IA_AI: { hasAIKey: () => false },
      PROVIDERS: { anthropic: { keyName: "Anthropic API key" } },
      imported: impArr, toast: (m)=>toasts.push(m),
    }, async () => { aiCalled = true; return ""; });
    await api.askQuestion("imported", "i0");
    assert.strictEqual(aiCalled, false);
    assert.ok(toasts.length && /Anthropic API key/.test(toasts[0]) && /Settings/.test(toasts[0]));
  });

  t(label + ": generateArticle and askQuestion on the SAME card serialize through the shared busy key (final review Recommendation #9a)", async () => {
    const impArr = [{ id: "i0", title: "Ferrofluid displays" }];
    let articleCallCount = 0, qaCallCount = 0;
    let resolveArticle;
    const articlePromise = new Promise(r => { resolveArticle = r; });
    const api = loadBoth(src, { imported: impArr }, (prompt) => {
      if(/Research and write/.test(prompt)){ articleCallCount++; return articlePromise; }
      qaCallCount++; return Promise.resolve("An answer.\n\nSOURCES:\nhttps://example.com/a");
    });
    const p1 = api.generateArticle("imported", "i0");
    const p2 = api.askQuestion("imported", "i0");   // fired while the article call is still in flight
    resolveArticle("Article body.\n\nSOURCES:\nhttps://example.com/b");
    await Promise.all([p1, p2]);
    assert.strictEqual(articleCallCount, 1);
    assert.strictEqual(qaCallCount, 0, "askQuestion must be dropped while generateArticle is busy on the same card — they share one busy key by design");
    assert.ok(impArr[0].research.article, "the article call that DID run must still have completed normally");
    assert.strictEqual((impArr[0].research.qa||[]).length, 0, "the dropped Q&A call must not have appended anything");
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
      "_researchBusy", "_articleEditing", "_articleExpanded", "_articleDrafts", "_qaDrafts", "esc", "domain",
      fn(src, "researchPanelHTML") + "\nreturn researchPanelHTML;"
    );
    const researchPanelHTML = factory(new Map(), new Set(), new Set(), {}, {}, (s)=>s, ()=>"");
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
      "_researchBusy", "_articleEditing", "_articleExpanded", "_articleDrafts", "_qaDrafts", "esc", "domain",
      fn(src, "researchPanelHTML") + "\nreturn researchPanelHTML;"
    );
    const researchPanelHTML = factory(new Map([["imported:i0", "qa"]]), new Set(), new Set(), {}, {}, (s)=>s, ()=>"");
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
