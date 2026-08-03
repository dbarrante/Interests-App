// tests/hashtag-title-apply.test.js — applyGeneratedTitle, the shared write
// path every AI-generated title goes through (impRefreshTitle, enrichOnOpen,
// the Title-issues Apply flow for AI-origin rows, and the new AI-refresh
// batch). Converts embedded #hashtags into tags; deliberately NOT wired into
// manual title edits (cardEditSave/impEditSave) — see
// docs/superpowers/specs/2026-08-02-ai-batch-refresh-design.md.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");
const { extractHashtags } = require("../web/title-ai.js");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

// Real canonicalTag/tagBadPattern from the source (not reimplemented) —
// canonicalTag depends on allTags(), stubbed here to an injected vocabulary.
function loadApplyGeneratedTitle(src, vocab) {
  const parts = {
    tagBadPattern: extractFn(src, "tagBadPattern"),
    canonicalTag: extractFn(src, "canonicalTag"),
    applyGeneratedTitle: extractFn(src, "applyGeneratedTitle"),
  };
  Object.keys(parts).forEach(name => assert.ok(parts[name], name + " not found in source"));
  const body = Object.values(parts).join("\n");
  const factory = new Function(
    "extractHashtags", "allTags", "AI_TAB_TAG",
    body + "\nreturn applyGeneratedTitle;"
  );
  return factory(extractHashtags, () => vocab || [], "interests");
}

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": applyGeneratedTitle returns null and touches nothing for a falsy title", () => {
    const applyGeneratedTitle = loadApplyGeneratedTitle(src);
    const card = { title: "old", tags: ["x"] };
    const out = applyGeneratedTitle(card, "");
    assert.strictEqual(out, null);
    assert.strictEqual(card.title, "old");
    assert.deepStrictEqual(card.tags, ["x"]);
  });

  t(label + ": applyGeneratedTitle strips hashtags from the title and adds them as tags", () => {
    const applyGeneratedTitle = loadApplyGeneratedTitle(src);
    const card = { title: "old", tags: [] };
    const out = applyGeneratedTitle(card, "Backyard Pizza Oven #diy #pizza Build");
    assert.strictEqual(card.title, "Backyard Pizza Oven Build");
    assert.deepStrictEqual(card.tags.sort(), ["diy", "pizza"]);
    assert.strictEqual(out.title, "Backyard Pizza Oven Build");
    assert.deepStrictEqual(out.tagsAdded.sort(), ["diy", "pizza"]);
  });

  t(label + ": applyGeneratedTitle merges into existing tags, never replaces", () => {
    const applyGeneratedTitle = loadApplyGeneratedTitle(src);
    const card = { title: "old", tags: ["existing"] };
    applyGeneratedTitle(card, "New Title #fresh");
    assert.deepStrictEqual(card.tags.sort(), ["existing", "fresh"]);
  });

  t(label + ": applyGeneratedTitle falls back to the raw title when hashtag-stripping empties it", () => {
    const applyGeneratedTitle = loadApplyGeneratedTitle(src);
    const card = { title: "old", tags: [] };
    const out = applyGeneratedTitle(card, "#diy #pizza");
    assert.strictEqual(card.title, "#diy #pizza");
    assert.strictEqual(out.title, "#diy #pizza");
    assert.deepStrictEqual(card.tags, ["diy", "pizza"]);
  });

  t(label + ": applyGeneratedTitle rejects a bad-pattern hashtag (e.g. a bare year) as a tag but still cleans the title", () => {
    const applyGeneratedTitle = loadApplyGeneratedTitle(src);
    const card = { title: "old", tags: [] };
    const out = applyGeneratedTitle(card, "Recap #2024 Highlights");
    assert.strictEqual(card.title, "Recap Highlights");
    assert.deepStrictEqual(card.tags, []);
    assert.deepStrictEqual(out.tagsAdded, []);
  });

  t(label + ": applyGeneratedTitle canonicalizes a hashtag onto an existing near-duplicate tag", () => {
    const applyGeneratedTitle = loadApplyGeneratedTitle(src, ["recipes"]);
    const card = { title: "old", tags: [] };
    applyGeneratedTitle(card, "Dinner Ideas #recipe");
    assert.deepStrictEqual(card.tags, ["recipes"]);
  });

  t(label + ": applyGeneratedTitle drops the reserved AI_TAB_TAG if somehow present as a hashtag", () => {
    const applyGeneratedTitle = loadApplyGeneratedTitle(src);
    const card = { title: "old", tags: [] };
    applyGeneratedTitle(card, "Something #interests Weird");
    assert.deepStrictEqual(card.tags, []);
  });

  t(label + ": applyGeneratedTitle caps the written title at 250 characters", () => {
    const applyGeneratedTitle = loadApplyGeneratedTitle(src);
    const card = { title: "old", tags: [] };
    const longTitle = "A".repeat(300);
    applyGeneratedTitle(card, longTitle);
    assert.strictEqual(card.title.length, 250);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
