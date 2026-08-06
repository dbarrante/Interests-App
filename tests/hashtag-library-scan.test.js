// tests/hashtag-library-scan.test.js — hashtag library scan in Library Health modal.
// Tests runHashtagLibraryScan orchestration (chunking, state persistence, error handling)
// and captureOutgoingHashtags return value.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

function loadFnsFromSource(src) {
  const fns = [
    "tagBadPattern",
    "tagSuppressed",
    "allTags",
    "canonicalTag",
    "mergeCleanTags",
    "captureOutgoingHashtags",
    "renderHealthHashtags",
    "runHashtagLibraryScan"
  ];

  const srcs = fns.map((name) => {
    const fnSrc = extractFn(src, name);
    if (!fnSrc) throw new Error("function not found in source: " + name);
    return fnSrc;
  });

  // AI_TAB_TAG is a const, not extracted by extractFn, so pull it directly
  const aiTabTagMatch = src.match(/const\s+AI_TAB_TAG\s*=\s*"[^"]*";/);
  if (!aiTabTagMatch) throw new Error("AI_TAB_TAG not found in source");
  const aiTabTagSrc = aiTabTagMatch[0];

  // Combine all function sources and constants, then create factory
  const combined = aiTabTagSrc + "\n" + srcs.join("\n");
  const factory = new Function(
    "imported", "saved", "Store", "toast", "persistAll",
    "renderSaved", "renderImportedKeepFocus", "curTab", "_healthTab",
    "_hashtagScanRunning", "document", "tabs", "tagStats", "extractHashtags",
    combined + "\nreturn { captureOutgoingHashtags, renderHealthHashtags, runHashtagLibraryScan };"
  );
  return factory;
}

// Stub for extractHashtags from title-ai.js
function extractHashtagsStub(rawTitle){
  if(!rawTitle) return { title: "", tags: [] };
  const tags = [];
  const hashtagRe = /#(\w+)/g;
  let match;
  while((match = hashtagRe.exec(rawTitle))){
    if(match[1]) tags.push(match[1].toLowerCase());
  }
  const title = rawTitle.replace(/#\w+/g, "  ").replace(/\s{2,}/g, " ").trim();
  return { title, tags };
}

function load(src, state) {
  const factory = loadFnsFromSource(src);
  const fns = factory(
    state.imported, state.saved, state.Store, state.toast, state.persistAll,
    state.renderSaved, state.renderImportedKeepFocus, state.curTab, state._healthTab,
    false, // _hashtagScanRunning initial value
    state.document,
    state.tabs || [],  // tabs
    state.tagStats || {},  // tagStats
    extractHashtagsStub  // extractHashtags from title-ai.js
  );
  return fns;
}

// Top-level await needs an async IIFE — this file is plain CommonJS.
(async () => {

// First, verify byte-parity of key functions
{
  const webFns = ["captureOutgoingHashtags", "renderHealthHashtags", "runHashtagLibraryScan"];
  const pwaFns = ["captureOutgoingHashtags", "renderHealthHashtags", "runHashtagLibraryScan"];

  for (let i = 0; i < webFns.length; i++) {
    const webBody = extractFn(html, webFns[i]);
    const pwaBody = extractFn(pwaHtml, pwaFns[i]);
    try {
      assert.strictEqual(pwaBody, webBody, `pwa/index.html's ${pwaFns[i]} has diverged from web/index.html's — keep them byte-identical`);
      console.log(`  ok  pwa/web byte-identical: ${webFns[i]}`);
    } catch (e) {
      fail++;
      console.log(`  FAIL pwa/web byte-identical: ${webFns[i]}`);
      console.error("  " + e.message);
    }
  }
}

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  await t(label + ": captureOutgoingHashtags returns the tags it added, [] for a no-op", async () => {
    const state = {
      imported: [],
      saved: [],
      Store: { putCards: () => {}, putSaved: () => {} },
      toast: () => {},
      persistAll: () => {},
      renderSaved: () => {},
      renderImportedKeepFocus: () => {},
      curTab: "saved",
      _healthTab: "hashtags",
      document: { getElementById: () => null }
    };
    const fns = load(src, state);
    const card = { title: "Great sunset #photography #travel", tags: [] };
    const added = fns.captureOutgoingHashtags(card);
    assert.deepStrictEqual(added.sort(), ["photography", "travel"].sort());
    // Already tagged — no-op, returns []
    const added2 = fns.captureOutgoingHashtags(card);
    assert.deepStrictEqual(added2, []);
  });

  await t(label + ": captureOutgoingHashtags never modifies the title", async () => {
    const state = {
      imported: [],
      saved: [],
      Store: { putCards: () => {}, putSaved: () => {} },
      toast: () => {},
      persistAll: () => {},
      renderSaved: () => {},
      renderImportedKeepFocus: () => {},
      curTab: "saved",
      _healthTab: "hashtags",
      document: { getElementById: () => null }
    };
    const fns = load(src, state);
    const card = { title: "Great sunset #photography", tags: [] };
    fns.captureOutgoingHashtags(card);
    assert.strictEqual(card.title, "Great sunset #photography");
  });

  await t(label + ": runHashtagLibraryScan processes both imported and saved", async () => {
    const imported = [{ title: "one #a", tags: [] }];
    const saved = [{ title: "two #b", tags: [] }];
    const persistCalls = [];
    const state = {
      imported,
      saved,
      Store: {
        putCards: (arr) => { persistCalls.push("cards"); },
        putSaved: (arr) => { persistCalls.push("saved"); }
      },
      toast: () => {},
      persistAll: () => { persistCalls.push("all"); },
      renderSaved: () => {},
      renderImportedKeepFocus: () => {},
      curTab: "saved",
      _healthTab: "hashtags",
      document: { getElementById: () => null }
    };
    const fns = load(src, state);
    await fns.runHashtagLibraryScan();
    assert.ok(imported[0].tags.includes("a"));
    assert.ok(saved[0].tags.includes("b"));
  });

  await t(label + ": runHashtagLibraryScan chunks in groups of 400", async () => {
    const imported = [];
    for (let i = 0; i < 450; i++) {
      imported.push({ title: `card ${i} #tag${i % 5}`, tags: [] });
    }
    const saved = [];
    const chunkCalls = [];
    const state = {
      imported,
      saved,
      Store: {
        putCards: () => { chunkCalls.push("cards"); },
        putSaved: () => { chunkCalls.push("saved"); }
      },
      toast: () => {},
      persistAll: () => { chunkCalls.push("all"); },
      renderSaved: () => {},
      renderImportedKeepFocus: () => {},
      curTab: "saved",
      _healthTab: "hashtags",
      document: { getElementById: () => null }
    };
    const fns = load(src, state);
    await fns.runHashtagLibraryScan();
    assert.ok(imported.every(c => c.tags.length > 0), "all cards should have tags after scan");
    // Should have two chunk persist cycles: 400 cards, then 50 cards
    assert.ok(chunkCalls.length >= 4, "should have at least 2 Store.put cycles (cards + saved per chunk)");
  });

  await t(label + ": runHashtagLibraryScan is idempotent (already-tagged cards don't duplicate tags)", async () => {
    const imported = [{ title: "x #dup", tags: [] }];
    const saved = [];
    const state = {
      imported,
      saved,
      Store: { putCards: () => {}, putSaved: () => {} },
      toast: () => {},
      persistAll: () => {},
      renderSaved: () => {},
      renderImportedKeepFocus: () => {},
      curTab: "saved",
      _healthTab: "hashtags",
      document: { getElementById: () => null }
    };
    const fns = load(src, state);
    // First run
    await fns.runHashtagLibraryScan();
    assert.deepStrictEqual(imported[0].tags, ["dup"]);
    // Second run — tag should not duplicate
    await fns.runHashtagLibraryScan();
    assert.deepStrictEqual(imported[0].tags, ["dup"]);
  });

  await t(label + ": runHashtagLibraryScan no-ops with toast when library is empty", async () => {
    let toasted = "";
    const state = {
      imported: [],
      saved: [],
      Store: { putCards: () => {}, putSaved: () => {} },
      toast: (m) => { toasted = m; },
      persistAll: () => {},
      renderSaved: () => {},
      renderImportedKeepFocus: () => {},
      curTab: "saved",
      _healthTab: "hashtags",
      document: { getElementById: () => null }
    };
    const fns = load(src, state);
    await fns.runHashtagLibraryScan();
    assert.ok(toasted.length > 0, "should toast a message");
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
})();
