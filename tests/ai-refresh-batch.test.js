// tests/ai-refresh-batch.test.js — runAiRefreshBatch, the "Process next 200"
// orchestrator. Stubs aiTagChunk/generateUniqueTitle/applyGeneratedTitle
// (each already has its own dedicated tests) to isolate the orchestration
// logic: chunking, checkbox gating, stamping, incremental persistence, and
// error propagation.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

function makeCards(n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ id: (prefix||"c") + i, title: "t" + i });
  return out;
}

// PROVIDERS[S.provider].keyName is read on the no-AI-key path; a Proxy that
// answers any key avoids having to set a matching S.provider in every state
// object above (several never touch that path at all).
const FAKE_PROVIDERS = new Proxy({}, { get: () => ({ keyName: "key" }) });
function load(src, state) {
  const doc = { getElementById: () => state.btn };
  const factory = new Function(
    "IA_AI", "PROVIDERS", "S", "toast", "aiRefreshCandidates", "aiTagChunk", "generateUniqueTitle", "applyGeneratedTitle",
    "Store", "persistAll", "_airefreshRetag", "_airefreshRetitle", "_airefreshRunning", "document",
    "curTab", "renderSaved", "renderImportedKeepFocus", "_healthTab", "renderHealthAiRefresh", "imported",
    extractFn(src, "runAiRefreshBatch") + "\nreturn runAiRefreshBatch;"
  );
  // `imported` is only ever passed BY REFERENCE into Store.putCards(imported)
  // — the stub below ignores its argument, so a plain [] satisfies the free
  // variable without needing to mirror the real global array's contents.
  return factory(
    state.IA_AI, FAKE_PROVIDERS, state.S, state.toast, state.aiRefreshCandidates,
    state.aiTagChunk, state.generateUniqueTitle, state.applyGeneratedTitle,
    state.Store, state.persistAll, state._airefreshRetag, state._airefreshRetitle, false, doc,
    "saved", state.renderSaved||(()=>{}), state.renderImportedKeepFocus||(()=>{}), "dupes", state.renderHealthAiRefresh||(()=>{}), []
  );
}

// Top-level await needs an async IIFE — this file is plain CommonJS.
(async () => {
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  await t(label + ": runAiRefreshBatch processes in chunks of 40, stamps aiRefreshedAt, persists per chunk", async () => {
    const cards = makeCards(45);
    const tagChunkCalls = [];
    const persistCalls = [];
    const state = {
      IA_AI: { hasAIKey: () => true },
      S: { aiRefreshDays: 30 },
      toast: () => {},
      aiRefreshCandidates: () => cards,
      aiTagChunk: async (chunk) => { tagChunkCalls.push(chunk.length); },
      generateUniqueTitle: async () => ({ title: null }),
      applyGeneratedTitle: () => {},
      Store: { putCards: () => { persistCalls.push("cards"); } },
      persistAll: () => { persistCalls.push("all"); },
      _airefreshRetag: true, _airefreshRetitle: false,
    };
    const runAiRefreshBatch = load(src, { ...state, btn: { } });
    await runAiRefreshBatch();
    assert.deepStrictEqual(tagChunkCalls, [40, 5]);
    assert.ok(cards.every(c => typeof c.aiRefreshedAt === "number"));
    assert.strictEqual(persistCalls.filter(x => x === "cards").length, 2);
  });

  await t(label + ": runAiRefreshBatch caps at 200 candidates even when more are eligible", async () => {
    const cards = makeCards(250);
    let totalTagged = 0;
    const state = {
      IA_AI: { hasAIKey: () => true },
      S: { aiRefreshDays: 30 },
      toast: () => {},
      aiRefreshCandidates: () => cards,
      aiTagChunk: async (chunk) => { totalTagged += chunk.length; },
      generateUniqueTitle: async () => ({ title: null }),
      applyGeneratedTitle: () => {},
      Store: { putCards: () => {} },
      persistAll: () => {},
      _airefreshRetag: true, _airefreshRetitle: false,
    };
    const runAiRefreshBatch = load(src, { ...state, btn: {} });
    await runAiRefreshBatch();
    assert.strictEqual(totalTagged, 200);
    assert.strictEqual(cards.slice(200).every(c => c.aiRefreshedAt === undefined), true);
  });

  await t(label + ": runAiRefreshBatch only retitles when Retitle is checked, only retags when Retag is checked", async () => {
    const cards = makeCards(1);
    let tagCalled = false, titleCalled = false;
    const state = {
      IA_AI: { hasAIKey: () => true },
      S: { aiRefreshDays: 30 },
      toast: () => {},
      aiRefreshCandidates: () => cards,
      aiTagChunk: async () => { tagCalled = true; },
      generateUniqueTitle: async () => { titleCalled = true; return { title: "New" }; },
      applyGeneratedTitle: (card, t) => { card.title = t; },
      Store: { putCards: () => {} },
      persistAll: () => {},
      _airefreshRetag: false, _airefreshRetitle: true,
    };
    const runAiRefreshBatch = load(src, { ...state, btn: {} });
    await runAiRefreshBatch();
    assert.strictEqual(tagCalled, false);
    assert.strictEqual(titleCalled, true);
    assert.strictEqual(cards[0].title, "New");
  });

  await t(label + ": runAiRefreshBatch: a per-card retitle failure doesn't abort the batch", async () => {
    const cards = makeCards(2);
    const state = {
      IA_AI: { hasAIKey: () => true },
      S: { aiRefreshDays: 30 },
      toast: () => {},
      aiRefreshCandidates: () => cards,
      aiTagChunk: async () => {},
      generateUniqueTitle: async (card) => { if (card.id === "c0") throw new Error("boom"); return { title: "ok" }; },
      applyGeneratedTitle: (card, t) => { card.title = t; },
      Store: { putCards: () => {} },
      persistAll: () => {},
      _airefreshRetag: false, _airefreshRetitle: true,
    };
    const runAiRefreshBatch = load(src, { ...state, btn: {} });
    await runAiRefreshBatch();
    assert.strictEqual(cards[1].title, "ok");
    assert.ok(cards.every(c => typeof c.aiRefreshedAt === "number"), "both cards stamped even though one retitle attempt failed");
  });

  await t(label + ": runAiRefreshBatch: a chunk-level retag failure propagates and stops the run without stamping that chunk", async () => {
    const cards = makeCards(2);
    const state = {
      IA_AI: { hasAIKey: () => true, creditsMessage: () => null },
      S: { aiRefreshDays: 30 },
      toast: () => {},
      aiRefreshCandidates: () => cards,
      aiTagChunk: async () => { throw new Error("AI down"); },
      generateUniqueTitle: async () => ({ title: null }),
      applyGeneratedTitle: () => {},
      Store: { putCards: () => {} },
      persistAll: () => {},
      _airefreshRetag: true, _airefreshRetitle: false,
    };
    const runAiRefreshBatch = load(src, { ...state, btn: {} });
    await runAiRefreshBatch();   // must not throw out of the function itself — caught and toasted
    assert.ok(cards.every(c => c.aiRefreshedAt === undefined), "no card stamped when its chunk's retag call threw");
  });

  await t(label + ": a multi-chunk batch stamps completed chunks even when a later chunk's retag throws", async () => {
    const cards = makeCards(45);
    let call = 0;
    const state = {
      IA_AI: { hasAIKey: () => true, creditsMessage: () => null },
      S: { aiRefreshDays: 30 },
      toast: () => {},
      aiRefreshCandidates: () => cards,
      aiTagChunk: async () => { call++; if (call === 2) throw new Error("AI down"); },
      generateUniqueTitle: async () => ({ title: null }),
      applyGeneratedTitle: () => {},
      Store: { putCards: () => {} },
      persistAll: () => {},
      _airefreshRetag: true, _airefreshRetitle: false,
    };
    const runAiRefreshBatch = load(src, { ...state, btn: {} });
    await runAiRefreshBatch();
    assert.ok(cards.slice(0, 40).every(c => typeof c.aiRefreshedAt === "number"), "chunk 1 (cards 0-39) must be stamped");
    assert.ok(cards.slice(40).every(c => c.aiRefreshedAt === undefined), "chunk 2 (cards 40-44) must NOT be stamped since its aiTagChunk call threw");
  });

  await t(label + ": runAiRefreshBatch no-ops with a toast when nothing is eligible", async () => {
    let toasted = "";
    const state = {
      IA_AI: { hasAIKey: () => true },
      S: { aiRefreshDays: 30 },
      toast: (m) => { toasted = m; },
      aiRefreshCandidates: () => [],
      aiTagChunk: async () => { throw new Error("must not be called"); },
      generateUniqueTitle: async () => { throw new Error("must not be called"); },
      applyGeneratedTitle: () => {},
      Store: { putCards: () => {} },
      persistAll: () => {},
      _airefreshRetag: true, _airefreshRetitle: true,
    };
    const runAiRefreshBatch = load(src, { ...state, btn: {} });
    await runAiRefreshBatch();
    assert.ok(toasted.length > 0);
  });

  t(label + ": _airefreshRunning is declared at script scope (not just injected by tests)", () => {
    assert.match(src, /let _airefreshRetag[^;]*_airefreshRunning\s*=\s*false/);
  });

  await t(label + ": runAiRefreshBatch no-ops with a toast when there's no AI key", async () => {
    let toasted = "";
    const state = {
      IA_AI: { hasAIKey: () => false },
      S: { aiRefreshDays: 30 },
      toast: (m) => { toasted = m; },
      aiRefreshCandidates: () => makeCards(1),
      aiTagChunk: async () => { throw new Error("must not be called"); },
      generateUniqueTitle: async () => { throw new Error("must not be called"); },
      applyGeneratedTitle: () => {},
      Store: { putCards: () => {} },
      persistAll: () => {},
      _airefreshRetag: true, _airefreshRetitle: true,
    };
    const runAiRefreshBatch = load(src, { ...state, btn: {} });
    await runAiRefreshBatch();
    assert.ok(toasted.indexOf("key") >= 0);
  });
}
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
})();
