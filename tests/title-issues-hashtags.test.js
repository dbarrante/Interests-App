// tests/title-issues-hashtags.test.js — the Title-issues panel's Apply flow
// only runs hashtag-to-tag conversion on AI-origin suggestions
// (retryTitleSuggestion / suggestTitlesForFlagged), never on a row the user
// hand-edited via editTitleManually — both share the same input box and the
// same Apply button, so provenance has to be tracked explicitly.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

function fakeRow(key, value, checked) {
  const input = { value };
  const checkbox = { checked };
  return {
    getAttribute: (a) => a === "data-title-key" ? key : null,
    querySelector: (sel) => sel === "input.title-suggest-input" ? input : (sel === "input[data-title-apply]" ? checkbox : null),
  };
}

// Top-level await needs an async IIFE — this file is plain CommonJS.
(async () => {
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  await t(label + ": applyTitleSuggestions runs applyGeneratedTitle for an AI-origin row (hashtag becomes a tag)", () => {
    const imported = [{ id: "i1", title: "old", tags: [] }];
    const saved = [];
    const rows = [fakeRow("imported:i1", "New Title #diy", true)];
    const document = { querySelectorAll: () => rows };
    let persistedCards = false, persistedSaved = false, toasted = "";
    const applyGeneratedTitle = (card, val) => { card.title = val.replace(/#\w+/g, "").trim(); card.tags = ["diy"]; return { title: card.title, tagsAdded: ["diy"] }; };
    const body = [
      "let _titleSuggestions = {};",
      "let _titleSuggestionsAI = new Set();",
      extractFn(src, "clearTitleSuggestions") || "function clearTitleSuggestions(){ _titleSuggestions={}; _titleSuggestionsAI=new Set(); }",
      extractFn(src, "captureOrigTitle"),
      extractFn(src, "settleOrigTitle"),
      extractFn(src, "applyTitleSuggestions"),
    ].join("\n");
    const factory = new Function(
      "document", "imported", "saved", "applyGeneratedTitle", "persistCards", "Store", "toast", "_healthTab",
      body + "\n_titleSuggestionsAI.add('imported:i1');\nreturn applyTitleSuggestions;"
    );
    // _healthTab is deliberately NOT "titles" here, so the real function's
    // trailing `if(_healthTab==="titles") renderHealthTitles(...)` re-render
    // is skipped — renderHealthTitles isn't stubbed because this test only
    // cares about the write/persist behavior above it.
    const applyTitleSuggestions = factory(
      document, imported, saved, applyGeneratedTitle,
      () => { persistedCards = true; },
      { putSaved: () => { persistedSaved = true; } },
      (msg) => { toasted = msg; }, "dupes"
    );
    applyTitleSuggestions();
    assert.strictEqual(imported[0].title, "New Title");
    assert.deepStrictEqual(imported[0].tags, ["diy"]);
    assert.ok(persistedCards && persistedSaved);
  });

  await t(label + ": applyTitleSuggestions writes a hand-edited row verbatim, hashtag and all", () => {
    const imported = [{ id: "i1", title: "old", tags: [] }];
    const saved = [];
    const rows = [fakeRow("imported:i1", "My Own Title #keepit", true)];
    const document = { querySelectorAll: () => rows };
    const applyGeneratedTitle = () => { throw new Error("must not be called for a manual row"); };
    const body = [
      "let _titleSuggestions = {};",
      "let _titleSuggestionsAI = new Set();",
      extractFn(src, "clearTitleSuggestions") || "function clearTitleSuggestions(){ _titleSuggestions={}; _titleSuggestionsAI=new Set(); }",
      extractFn(src, "captureOrigTitle"),
      extractFn(src, "settleOrigTitle"),
      extractFn(src, "applyTitleSuggestions"),
    ].join("\n");
    const factory = new Function(
      "document", "imported", "saved", "applyGeneratedTitle", "persistCards", "Store", "toast", "_healthTab",
      body + "\nreturn applyTitleSuggestions;"   // _titleSuggestionsAI deliberately NOT seeded with this key
    );
    const applyTitleSuggestions = factory(
      document, imported, saved, applyGeneratedTitle,
      () => {}, { putSaved: () => {} }, () => {}, "dupes"
    );
    applyTitleSuggestions();
    assert.strictEqual(imported[0].title, "My Own Title #keepit");
    assert.deepStrictEqual(imported[0].tags, []);
    assert.strictEqual(imported[0].origTitle, "old", "a hand-edited (non-AI) suggestion must still capture the pre-write title");
  });

  await t(label + ": retryTitleSuggestion marks its key as AI-origin", async () => {
    const flaggedTitleCards = () => [{ scope: "imported", card: { id: "i1" } }];
    const regenerateTitleFor = async () => "AI Suggestion #tag";
    const body = [
      "let _titleSuggestions = {};",
      "let _titleSuggestionsAI = new Set();",
      extractFn(src, "retryTitleSuggestion"),
    ].join("\n");
    const factory = new Function(
      "flaggedTitleCards", "regenerateTitleFor", "_healthTab", "document", "toast",
      body + "\nreturn { retryTitleSuggestion, get suggestions(){ return _titleSuggestions; }, get ai(){ return _titleSuggestionsAI; } };"
    );
    // _healthTab is deliberately NOT "titles" here, so the real function's
    // `if(_healthTab==="titles") renderHealthTitles(...)` branch is skipped —
    // this test only cares about the AI-origin flag, not the re-render.
    const mod = factory(flaggedTitleCards, regenerateTitleFor, "dupes", { getElementById: () => null }, () => {});
    await mod.retryTitleSuggestion("imported:i1");
    assert.strictEqual(mod.suggestions["imported:i1"], "AI Suggestion #tag");
    assert.ok(mod.ai.has("imported:i1"));
  });

  await t(label + ": editTitleManually clears any prior AI-origin flag for that key", () => {
    const titleRowCard = () => ({ card: { title: "Current Title" } });
    const body = [
      "let _titleSuggestions = {};",
      "let _titleSuggestionsAI = new Set(['imported:i1']);",
      extractFn(src, "editTitleManually"),
    ].join("\n");
    const factory = new Function(
      "titleRowCard", "document", "toast", "renderHealthTitles", "window",
      body + "\nreturn { editTitleManually, get ai(){ return _titleSuggestionsAI; } };"
    );
    // editTitleManually unconditionally calls renderHealthTitles(...) and
    // touches window.CSS?.escape — both stubbed out; this test only cares
    // about the AI-origin flag being cleared.
    const mod = factory(
      titleRowCard,
      { getElementById: () => null, querySelector: () => null },
      () => {}, () => {}, {}
    );
    mod.editTitleManually("imported:i1");
    assert.strictEqual(mod.ai.has("imported:i1"), false);
  });
}
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
})();
