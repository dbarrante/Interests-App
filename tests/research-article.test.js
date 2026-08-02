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
    src.match(/let _researchBusy[^;]+;/)[0],
    fn(src, "hasResearchProvider"), fn(src, "_researchCard"), fn(src, "buildArticlePrompt"),
    fn(src, "parseResearchResponse"), fn(src, "generateArticle"),
  ].join("\n");
  const factory = new Function(
    "S", "IA_AI", "PROVIDERS", "imported", "saved", "callAI", "toast", "renderTabsView", "Store",
    body + "\nreturn { generateArticle: generateArticle, getBusy: function(){ return _researchBusy; } };"
  );
  return factory(
    state.S || { provider: "anthropic" },
    state.IA_AI || { hasAIKey: () => true },
    state.PROVIDERS || { anthropic: { keyName: "Anthropic API key" } },
    state.imported || [], state.saved || [],
    callAI, state.toast || (()=>{}), state.renderTabsView || (()=>{}),
    state.Store || { putCards: ()=>{}, putSaved: ()=>{} }
  );
}

function loadExportCardToNotion(src, state) {
  const body = [
    fn(src, "_researchCard"),
    fn(src, "exportCardToNotion"),
  ].join("\n");
  const factory = new Function(
    "imported", "saved", "toast", "Store", "window",
    body + "\nreturn { exportCardToNotion: exportCardToNotion };"
  );
  return factory(
    state.imported || [], state.saved || [],
    state.toast || (()=>{}), state.Store || {}, state.window || { open: () => {} }
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

  t(label + ": generateArticle refuses when no API key is configured for a capable provider (Important finding #1, final review)", async () => {
    const impArr = [{ id: "i0", title: "X" }];
    let aiCalled = false;
    const toasts = [];
    const api = loadGenerateArticle(src, {
      IA_AI: { hasAIKey: () => false },
      PROVIDERS: { anthropic: { keyName: "Anthropic API key" } },
      imported: impArr, toast: (m)=>toasts.push(m),
    }, async () => { aiCalled = true; return ""; });
    await api.generateArticle("imported", "i0");
    assert.strictEqual(aiCalled, false);
    assert.strictEqual(impArr[0].research, undefined);
    assert.ok(toasts.length && /Anthropic API key/.test(toasts[0]) && /Settings/.test(toasts[0]));
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
      "_panelCollapsed", "_researchBusy", "_articleEditing", "_articleExpanded", "_articleDrafts", "_qaDrafts", "esc", "domain",
      fn(src, "researchPanelHTML") + "\nreturn researchPanelHTML;"
    );
    const researchPanelHTML = factory(new Set(), new Map(), new Set(), new Set(), {}, {}, (s)=>s, ()=>"");
    const out = researchPanelHTML("imported", { id: "i0" });
    assert.match(out, /generateArticle\('imported','i0'\)/);
    assert.match(out, /Research/);
  });

  t(label + ": researchPanelHTML shows a loading state while busy and no article exists yet", () => {
    const factory = new Function(
      "_panelCollapsed", "_researchBusy", "_articleEditing", "_articleExpanded", "_articleDrafts", "_qaDrafts", "esc", "domain",
      fn(src, "researchPanelHTML") + "\nreturn researchPanelHTML;"
    );
    const researchPanelHTML = factory(new Set(), new Map([["imported:i0", "article"]]), new Set(), new Set(), {}, {}, (s)=>s, ()=>"");
    const out = researchPanelHTML("imported", { id: "i0" });
    assert.doesNotMatch(out, /generateArticle\('imported','i0'\)/);
    assert.match(out, /esearching/);
  });

  t(label + ": researchPanelHTML shows 'Answering' (not 'Researching') while a Q&A call is busy on a card with no article yet (final review Minor #5)", () => {
    const factory = new Function(
      "_panelCollapsed", "_researchBusy", "_articleEditing", "_articleExpanded", "_articleDrafts", "_qaDrafts", "esc", "domain",
      fn(src, "researchPanelHTML") + "\nreturn researchPanelHTML;"
    );
    const researchPanelHTML = factory(new Set(), new Map([["imported:i0", "qa"]]), new Set(), new Set(), {}, {}, (s)=>s, ()=>"");
    const out = researchPanelHTML("imported", { id: "i0" });
    assert.doesNotMatch(out, /esearching/);
    assert.match(out, /nswering/);
  });

  t(label + ": researchPanelHTML shows the article, its sources, and a Regenerate/Copy row once generated", () => {
    const factory = new Function(
      "_panelCollapsed", "_researchBusy", "_articleEditing", "_articleExpanded", "_articleDrafts", "_qaDrafts", "esc", "domain",
      fn(src, "researchPanelHTML") + "\nreturn researchPanelHTML;"
    );
    const researchPanelHTML = factory(new Set(), new Map(), new Set(), new Set(), {}, {}, (s)=>s, (u)=>u.replace(/^https?:\/\//,"").split("/")[0]);
    const it = { id: "i0", research: { article: { text: "Short article body.", sources: ["https://example.com/a"], generatedAt: 1 }, qa: [] } };
    const out = researchPanelHTML("imported", it);
    assert.match(out, /Short article body\./);
    assert.match(out, /example\.com/);
    assert.match(out, /copyArticleText\('imported','i0'\)/);
    assert.match(out, /generateArticle\('imported','i0'\)/);   // Regenerate reuses generateArticle
    assert.match(out, /Regenerate/);
  });

  t(label + ": researchPanelHTML renders an open article edit from _articleDrafts, not from the stored (stale) article text (final review Important #2)", () => {
    const factory = new Function(
      "_panelCollapsed", "_researchBusy", "_articleEditing", "_articleExpanded", "_articleDrafts", "_qaDrafts", "esc", "domain",
      fn(src, "researchPanelHTML") + "\nreturn researchPanelHTML;"
    );
    const researchPanelHTML = factory(
      new Set(), new Map(), new Set(["imported:i0"]), new Set(),
      { "imported:i0": "unsaved draft text the user is mid-typing" }, {},
      (s)=>s, ()=>""
    );
    const it = { id: "i0", research: { article: { text: "stored article text", sources: [], generatedAt: 1 }, qa: [] } };
    const out = researchPanelHTML("imported", it);
    assert.match(out, /unsaved draft text the user is mid-typing/);
    assert.doesNotMatch(out, /stored article text/);
  });

  t(label + ": researchPanelHTML pre-fills the ask input from _qaDrafts, not empty, when a draft exists (final review Important #2)", () => {
    const factory = new Function(
      "_panelCollapsed", "_researchBusy", "_articleEditing", "_articleExpanded", "_articleDrafts", "_qaDrafts", "esc", "domain",
      fn(src, "researchPanelHTML") + "\nreturn researchPanelHTML;"
    );
    const researchPanelHTML = factory(
      new Set(), new Map(), new Set(), new Set(), {}, { "imported:i0": "half-typed question" },
      (s)=>s, ()=>""
    );
    const it = { id: "i0", research: null };
    const out = researchPanelHTML("imported", it);
    assert.match(out, /value="half-typed question"/);
  });

  t(label + ": toggleResearchPanel adds/removes the scope:id key and re-renders (user feedback)", () => {
    const calls = [];
    const factory = new Function(
      "_panelCollapsed", "renderTabsView",
      fn(src, "toggleResearchPanel") + "\nreturn toggleResearchPanel;"
    );
    const collapsed = new Set();
    const toggleResearchPanel = factory(collapsed, ()=>calls.push("render"));
    toggleResearchPanel("imported", "i0");
    assert.ok(collapsed.has("imported:i0"));
    toggleResearchPanel("imported", "i0");
    assert.ok(!collapsed.has("imported:i0"));
    assert.strictEqual(calls.length, 2);
  });

  t(label + ": researchPanelHTML renders only the header (no article/Q&A content) when the panel is collapsed (user feedback)", () => {
    const factory = new Function(
      "_panelCollapsed", "_researchBusy", "_articleEditing", "_articleExpanded", "_articleDrafts", "_qaDrafts", "esc", "domain",
      fn(src, "researchPanelHTML") + "\nreturn researchPanelHTML;"
    );
    const researchPanelHTML = factory(new Set(["imported:i0"]), new Map(), new Set(), new Set(), {}, {}, (s)=>s, ()=>"");
    const it = { id: "i0", research: { article: { text: "Article body that should be hidden.", sources: [], generatedAt: 1 }, qa: [{ question: "Q that should be hidden", answer: "A", sources: [], answeredAt: 1 }] } };
    const out = researchPanelHTML("imported", it);
    assert.match(out, /toggleResearchPanel\('imported','i0'\)/);
    assert.doesNotMatch(out, /Article body that should be hidden\./);
    assert.doesNotMatch(out, /Q that should be hidden/);
    assert.doesNotMatch(out, /qaInput_imported_i0/);
  });

  t(label + ": researchPanelHTML renders the full panel (header plus content) when not collapsed (user feedback)", () => {
    const factory = new Function(
      "_panelCollapsed", "_researchBusy", "_articleEditing", "_articleExpanded", "_articleDrafts", "_qaDrafts", "esc", "domain",
      fn(src, "researchPanelHTML") + "\nreturn researchPanelHTML;"
    );
    const researchPanelHTML = factory(new Set(), new Map(), new Set(), new Set(), {}, {}, (s)=>s, ()=>"");
    const it = { id: "i0", research: null };
    const out = researchPanelHTML("imported", it);
    assert.match(out, /toggleResearchPanel\('imported','i0'\)/);
    assert.match(out, /generateArticle\('imported','i0'\)/);
    assert.match(out, /qaInput_imported_i0/);
  });

  t(label + ": the ask-a-question input submits on Enter, not just via the Ask button (user feedback)", () => {
    const factory = new Function(
      "_panelCollapsed", "_researchBusy", "_articleEditing", "_articleExpanded", "_articleDrafts", "_qaDrafts", "esc", "domain",
      fn(src, "researchPanelHTML") + "\nreturn researchPanelHTML;"
    );
    const researchPanelHTML = factory(new Set(), new Map(), new Set(), new Set(), {}, {}, (s)=>s, ()=>"");
    const it = { id: "i0", research: null };
    const out = researchPanelHTML("imported", it);
    assert.match(out, /onkeydown="if\(event\.key==='Enter'\)askQuestion\('imported','i0'\)"/);
  });

  t(label + ": researchPanelHTML renders an Export to Notion button when an article exists (Task 6)", () => {
    const factory = new Function(
      "_panelCollapsed", "_researchBusy", "_articleEditing", "_articleExpanded", "_articleDrafts", "_qaDrafts", "esc", "domain",
      fn(src, "researchPanelHTML") + "\nreturn researchPanelHTML;"
    );
    const researchPanelHTML = factory(new Set(), new Map(), new Set(), new Set(), {}, {}, (s)=>s, ()=>"");
    const it = { id: "i0", research: { article: { text: "Some article text.", sources: [], generatedAt: 1 }, qa: [] } };
    const out = researchPanelHTML("imported", it);
    assert.match(out, /exportCardToNotion\('imported','i0'\)/);
    assert.match(out, /Export to Notion/);
  });

  t(label + ": researchPanelHTML renders the Export to Notion button when there's no article but Q&A exists (Task 6)", () => {
    const factory = new Function(
      "_panelCollapsed", "_researchBusy", "_articleEditing", "_articleExpanded", "_articleDrafts", "_qaDrafts", "esc", "domain",
      fn(src, "researchPanelHTML") + "\nreturn researchPanelHTML;"
    );
    const researchPanelHTML = factory(new Set(), new Map(), new Set(), new Set(), {}, {}, (s)=>s, ()=>"");
    const it = { id: "i0", research: { article: null, qa: [{ question: "Q", answer: "A", sources: [], answeredAt: 1 }] } };
    const out = researchPanelHTML("imported", it);
    assert.match(out, /exportCardToNotion\('imported','i0'\)/);
  });

  t(label + ": researchPanelHTML does NOT render the Export to Notion button when there's no article and no Q&A (Task 6)", () => {
    const factory = new Function(
      "_panelCollapsed", "_researchBusy", "_articleEditing", "_articleExpanded", "_articleDrafts", "_qaDrafts", "esc", "domain",
      fn(src, "researchPanelHTML") + "\nreturn researchPanelHTML;"
    );
    const researchPanelHTML = factory(new Set(), new Map(), new Set(), new Set(), {}, {}, (s)=>s, ()=>"");
    const it = { id: "i0", research: null };
    const out = researchPanelHTML("imported", it);
    assert.doesNotMatch(out, /exportCardToNotion/);
    assert.doesNotMatch(out, /Export to Notion/);
  });

  t(label + ": researchPanelHTML does NOT render the Export to Notion button for an initialized-but-empty research object (article:null, qa:[]) (Task 6)", () => {
    // Realistic empty state: it.research gets initialized by generateArticle/
    // askQuestion, then a card can end up with article:null (never generated)
    // and qa:[] (last Q&A entry deleted via deleteQaEntry) — distinct from
    // research:null itself, which the case above already covers.
    const factory = new Function(
      "_panelCollapsed", "_researchBusy", "_articleEditing", "_articleExpanded", "_articleDrafts", "_qaDrafts", "esc", "domain",
      fn(src, "researchPanelHTML") + "\nreturn researchPanelHTML;"
    );
    const researchPanelHTML = factory(new Set(), new Map(), new Set(), new Set(), {}, {}, (s)=>s, ()=>"");
    const it = { id: "i0", research: { article: null, qa: [] } };
    const out = researchPanelHTML("imported", it);
    assert.doesNotMatch(out, /exportCardToNotion/);
    assert.doesNotMatch(out, /Export to Notion/);
  });

  t(label + ": exportCardToNotion is a no-op for an unknown card id (Task 6)", async () => {
    const calls = [];
    const api = loadExportCardToNotion(src, {
      imported: [],
      Store: { getNotionStatus: async () => { calls.push("status"); return { hasToken: true, hasParent: true }; } },
    });
    await api.exportCardToNotion("imported", "nope");
    assert.strictEqual(calls.length, 0, "must not even check Notion status for an unresolved card");
  });

  t(label + ": exportCardToNotion toasts and does not export when neither token nor parent are configured (Task 6)", async () => {
    const impArr = [{ id: "i0", title: "X", url: "https://x.example", research: { article: { text: "a", sources: [], generatedAt: 1 }, qa: [] } }];
    const toasts = [];
    let exportCalled = false;
    const api = loadExportCardToNotion(src, {
      imported: impArr, toast: (m) => toasts.push(m),
      Store: {
        getNotionStatus: async () => ({ hasToken: false, hasParent: false }),
        exportToNotion: async () => { exportCalled = true; return { ok: true, pageUrl: "https://notion.so/x" }; },
      },
    });
    await api.exportCardToNotion("imported", "i0");
    assert.strictEqual(exportCalled, false);
    assert.ok(toasts.length && /Notion integration/i.test(toasts[0]) && /Settings/.test(toasts[0]));
  });

  t(label + ": exportCardToNotion toasts a token-specific message when only the token is missing (Task 6)", async () => {
    const impArr = [{ id: "i0", title: "X", research: { article: { text: "a", sources: [], generatedAt: 1 }, qa: [] } }];
    const toasts = [];
    let exportCalled = false;
    const api = loadExportCardToNotion(src, {
      imported: impArr, toast: (m) => toasts.push(m),
      Store: {
        getNotionStatus: async () => ({ hasToken: false, hasParent: true }),
        exportToNotion: async () => { exportCalled = true; return { ok: true, pageUrl: "https://notion.so/x" }; },
      },
    });
    await api.exportCardToNotion("imported", "i0");
    assert.strictEqual(exportCalled, false);
    assert.ok(toasts.length && /secret/i.test(toasts[0]));
  });

  t(label + ": exportCardToNotion toasts a parent-page-specific message when only the parent page is missing (Task 6)", async () => {
    const impArr = [{ id: "i0", title: "X", research: { article: { text: "a", sources: [], generatedAt: 1 }, qa: [] } }];
    const toasts = [];
    let exportCalled = false;
    const api = loadExportCardToNotion(src, {
      imported: impArr, toast: (m) => toasts.push(m),
      Store: {
        getNotionStatus: async () => ({ hasToken: true, hasParent: false }),
        exportToNotion: async () => { exportCalled = true; return { ok: true, pageUrl: "https://notion.so/x" }; },
      },
    });
    await api.exportCardToNotion("imported", "i0");
    assert.strictEqual(exportCalled, false);
    assert.ok(toasts.length && /target Notion page/i.test(toasts[toasts.length - 1]));
  });

  t(label + ": exportCardToNotion builds the payload from it.research and calls Store.exportToNotion on success (Task 6)", async () => {
    const impArr = [{
      id: "i0", title: "Ferrofluid displays", url: "https://example.com/f",
      research: { article: { text: "Article body.", sources: ["https://s.example"], generatedAt: 1 }, qa: [{ question: "Q1", answer: "A1", sources: [], answeredAt: 1 }] },
    }];
    const toasts = [];
    let sentPayload = null;
    const api = loadExportCardToNotion(src, {
      imported: impArr, toast: (m) => toasts.push(m),
      Store: {
        getNotionStatus: async () => ({ hasToken: true, hasParent: true }),
        exportToNotion: async (payload) => { sentPayload = payload; return { ok: true, pageUrl: "https://notion.so/abc" }; },
      },
    });
    await api.exportCardToNotion("imported", "i0");
    assert.deepStrictEqual(sentPayload, {
      title: "Ferrofluid displays", url: "https://example.com/f",
      article: { text: "Article body.", sources: ["https://s.example"], generatedAt: 1 },
      qa: [{ question: "Q1", answer: "A1", sources: [], answeredAt: 1 }],
    });
  });

  t(label + ": exportCardToNotion defaults url/article/qa when absent, still calling Store.exportToNotion (Task 6)", async () => {
    const impArr = [{ id: "i0", title: "No URL card", research: { article: null, qa: [{ question: "Q", answer: "A", sources: [], answeredAt: 1 }] } }];
    let sentPayload = null;
    const api = loadExportCardToNotion(src, {
      imported: impArr,
      Store: {
        getNotionStatus: async () => ({ hasToken: true, hasParent: true }),
        exportToNotion: async (payload) => { sentPayload = payload; return { ok: true, pageUrl: "https://notion.so/abc" }; },
      },
    });
    await api.exportCardToNotion("imported", "i0");
    assert.strictEqual(sentPayload.url, "");
    assert.strictEqual(sentPayload.article, null);
    assert.deepStrictEqual(sentPayload.qa, [{ question: "Q", answer: "A", sources: [], answeredAt: 1 }]);
  });

  t(label + ": exportCardToNotion toasts success including the returned pageUrl, openable via the toast's onclick (Task 6)", async () => {
    const impArr = [{ id: "i0", title: "X", research: { article: { text: "a", sources: [], generatedAt: 1 }, qa: [] } }];
    const toasts = [];
    const opened = [];
    const api = loadExportCardToNotion(src, {
      imported: impArr,
      toast: (m, ms, onclick) => toasts.push({ m, onclick }),
      window: { open: (...args) => opened.push(args) },
      Store: {
        getNotionStatus: async () => ({ hasToken: true, hasParent: true }),
        exportToNotion: async () => ({ ok: true, pageUrl: "https://notion.so/abc" }),
      },
    });
    await api.exportCardToNotion("imported", "i0");
    const last = toasts[toasts.length - 1];
    assert.ok(last, "expected a success toast");
    assert.strictEqual(typeof last.onclick, "function", "success toast must be clickable to open the page (or otherwise verifiably carry pageUrl)");
    last.onclick();
    assert.ok(opened.length === 1 && opened[0][0] === "https://notion.so/abc", "clicking the toast must open the returned pageUrl");
  });

  t(label + ": exportCardToNotion surfaces res.reason on a {ok:false, reason} response, e.g. the PWA stub (Task 6)", async () => {
    const impArr = [{ id: "i0", title: "X", research: { article: { text: "a", sources: [], generatedAt: 1 }, qa: [] } }];
    const toasts = [];
    const api = loadExportCardToNotion(src, {
      imported: impArr, toast: (m) => toasts.push(m),
      Store: {
        getNotionStatus: async () => ({ hasToken: true, hasParent: true }),
        exportToNotion: async () => ({ ok: false, reason: "Not applicable on iPad — Notion export needs the desktop app's local service." }),
      },
    });
    await api.exportCardToNotion("imported", "i0");
    assert.ok(toasts.some(m => /Not applicable on iPad/.test(m)));
  });

  t(label + ": exportCardToNotion never throws when Store.getNotionStatus rejects (network hiccup, Task 6)", async () => {
    const impArr = [{ id: "i0", title: "X", research: { article: { text: "a", sources: [], generatedAt: 1 }, qa: [] } }];
    const toasts = [];
    let exportCalled = false;
    const api = loadExportCardToNotion(src, {
      imported: impArr, toast: (m) => toasts.push(m),
      Store: {
        getNotionStatus: async () => { throw new Error("network down"); },
        exportToNotion: async () => { exportCalled = true; return { ok: true, pageUrl: "x" }; },
      },
    });
    await api.exportCardToNotion("imported", "i0");   // must resolve, not reject
    assert.strictEqual(exportCalled, false);
    assert.ok(toasts.length);
  });

  t(label + ": exportCardToNotion never throws when Store.exportToNotion rejects (network hiccup, Task 6)", async () => {
    const impArr = [{ id: "i0", title: "X", research: { article: { text: "a", sources: [], generatedAt: 1 }, qa: [] } }];
    const toasts = [];
    const api = loadExportCardToNotion(src, {
      imported: impArr, toast: (m) => toasts.push(m),
      Store: {
        getNotionStatus: async () => ({ hasToken: true, hasParent: true }),
        exportToNotion: async () => { throw new Error("fetch failed"); },
      },
    });
    await api.exportCardToNotion("imported", "i0");   // must resolve, not reject
    assert.ok(toasts.some(m => /[Ee]xport/.test(m)));
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
