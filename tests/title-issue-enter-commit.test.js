// tests/title-issue-enter-commit.test.js — the Title-issues panel's per-row
// "hit Enter in the suggestion box to commit just this card" flow
// (commitOneTitleSuggestion), wired via the input's onkeydown. Apply stays
// available afterward for whatever else is still pending in the batch —
// this only ever touches the ONE row the user pressed Enter in.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");
const { extractHashtags } = require("../web/title-ai.js");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": the suggestion input commits on Enter, wired to commitOneTitleSuggestion for that row's key", () => {
    const body = extractFn(src, "renderHealthTitles");
    assert.ok(body, "renderHealthTitles not found");
    assert.match(body, /onkeydown="if\(event\.key==='Enter'\)\{event\.preventDefault\(\);commitOneTitleSuggestion\('\$\{esc\(key\)\}'\)\}"/,
      "the suggestion input must call commitOneTitleSuggestion(key) on Enter, and prevent the default (form-submit-like) behavior");
  });

  t(label + ": commitOneTitleSuggestion writes an AI-origin row (applyGeneratedTitle), stamps titleSet, and removes only that key from the pending batch", () => {
    const imported = [{ id: "i1", title: "old", tags: [] }];
    const saved = [];
    const input = { value: "New Title #diy" };
    const row = { querySelector: (sel) => sel === "input.title-suggest-input" ? input : null };
    const document = { querySelector: () => row };
    const applyGeneratedTitle = (card, val) => { card.title = val.replace(/#\w+/g, "").trim(); card.tags = ["diy"]; return { title: card.title, tagsAdded: ["diy"] }; };
    let persistedCards = false, persistedSaved = false, toasted = "";
    const body = [
      "let _titleSuggestions = {'imported:i1':'New Title #diy','imported:i2':'Other pending #x'};",
      "let _titleSuggestionsAI = new Set(['imported:i1']);",
      extractFn(src, "titleRowCard"),
      extractFn(src, "captureOrigTitle"),
      extractFn(src, "settleOrigTitle"),
      extractFn(src, "commitOneTitleSuggestion"),
    ].join("\n");
    const factory = new Function(
      "document", "imported", "saved", "applyGeneratedTitle", "persistCards", "Store", "toast", "_healthTab", "window",
      body + "\nreturn { commitOneTitleSuggestion, get suggestions(){ return _titleSuggestions; }, get ai(){ return _titleSuggestionsAI; } };"
    );
    const mod = factory(
      document, imported, saved, applyGeneratedTitle,
      () => { persistedCards = true; },
      { putSaved: () => { persistedSaved = true; } },
      (msg) => { toasted = msg; }, "dupes", {}
    );
    mod.commitOneTitleSuggestion("imported:i1");
    assert.strictEqual(imported[0].title, "New Title");
    assert.deepStrictEqual(imported[0].tags, ["diy"]);
    assert.strictEqual(imported[0].titleSet, true, "commitOneTitleSuggestion must stamp titleSet so this card leaves the to-do list");
    assert.ok(persistedCards && persistedSaved, "must persist immediately, not wait for a later Apply click");
    assert.ok(toasted, "must confirm the commit to the user");
    assert.strictEqual(mod.suggestions["imported:i1"], undefined, "the committed key must be cleared from the pending batch");
    assert.strictEqual(mod.suggestions["imported:i2"], "Other pending #x", "an unrelated row still under review must be untouched");
  });

  t(label + ": commitOneTitleSuggestion writes a hand-edited row verbatim, hashtag and all (same provenance rule as Apply)", () => {
    const imported = [{ id: "i1", title: "old #legacy", tags: [] }];
    const saved = [];
    const input = { value: "My Own Title #keepit" };
    const row = { querySelector: (sel) => sel === "input.title-suggest-input" ? input : null };
    const document = { querySelector: () => row };
    const applyGeneratedTitle = () => { throw new Error("must not be called for a manual (non-AI-origin) row"); };
    const body = [
      "let _titleSuggestions = {'imported:i1':'My Own Title #keepit'};",
      "let _titleSuggestionsAI = new Set();",   // NOT AI-origin — a hand-edited row via editTitleManually
      extractFn(src, "titleRowCard"),
      extractFn(src, "captureOrigTitle"),
      extractFn(src, "settleOrigTitle"),
      extractFn(src, "mergeCleanTags"),
      extractFn(src, "captureOutgoingHashtags"),
      extractFn(src, "commitOneTitleSuggestion"),
    ].join("\n");
    const factory = new Function(
      "extractHashtags", "AI_TAB_TAG", "canonicalTag", "tagBadPattern",
      "document", "imported", "saved", "applyGeneratedTitle", "persistCards", "Store", "toast", "_healthTab", "window",
      body + "\nreturn commitOneTitleSuggestion;"
    );
    const commitOneTitleSuggestion = factory(
      extractHashtags, "interests", (x) => x.toLowerCase(), () => false,
      document, imported, saved, applyGeneratedTitle,
      () => {}, { putSaved: () => {} }, () => {}, "dupes", {}
    );
    commitOneTitleSuggestion("imported:i1");
    assert.strictEqual(imported[0].title, "My Own Title #keepit");
    assert.deepStrictEqual(imported[0].tags, ["legacy"], "the OUTGOING title's hashtag becomes a tag; the new (hand-typed) title's #keepit stays literal");
    assert.strictEqual(imported[0].origTitle, "old #legacy");
  });

  t(label + ": commitOneTitleSuggestion no-ops (no throw) on a blank typed title", () => {
    const imported = [{ id: "i1", title: "old", tags: [] }];
    const input = { value: "   " };
    const row = { querySelector: (sel) => sel === "input.title-suggest-input" ? input : null };
    const document = { querySelector: () => row };
    let persisted = false, toasted = "";
    const body = [
      "let _titleSuggestions = {'imported:i1':'old'};",
      "let _titleSuggestionsAI = new Set();",
      extractFn(src, "titleRowCard"),
      extractFn(src, "captureOrigTitle"),
      extractFn(src, "settleOrigTitle"),
      extractFn(src, "commitOneTitleSuggestion"),
    ].join("\n");
    const factory = new Function(
      "document", "imported", "saved", "applyGeneratedTitle", "persistCards", "Store", "toast", "_healthTab", "window",
      body + "\nreturn commitOneTitleSuggestion;"
    );
    const commitOneTitleSuggestion = factory(
      document, imported, [], () => {},
      () => { persisted = true; }, { putSaved: () => {} },
      (msg) => { toasted = msg; }, "dupes", {}
    );
    commitOneTitleSuggestion("imported:i1");
    assert.strictEqual(imported[0].title, "old", "a blank input must not overwrite the card's title");
    assert.strictEqual(persisted, false);
  });
}

t("commitOneTitleSuggestion is byte-identical between web/index.html and pwa/index.html (binding parity)", () => {
  assert.strictEqual(extractFn(html, "commitOneTitleSuggestion"), extractFn(pwaHtml, "commitOneTitleSuggestion"),
    "commitOneTitleSuggestion has drifted between web/ and pwa/");
});

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
