// tests/title-write-sites-hashtags.test.js — impRefreshTitle and
// enrichOnOpen's AI-title branch route through applyGeneratedTitle, so a
// hashtag in an AI-generated title becomes a tag instead of staying in the
// title text.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

// Top-level await needs an async IIFE — this file is plain CommonJS (no
// "type":"module" in package.json), so bare top-level `await` is a syntax error.
(async () => {
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  await t(label + ": impRefreshTitle applies a hashtag in the AI's suggested title as a tag, not literal text", async () => {
    const it = { title: "old", tags: [] };
    const imported = [it];
    const applyGeneratedTitle = (card, rawTitle) => { card.title = rawTitle.replace(/#\w+/g, "").trim(); card.tags = ["diy"]; return { title: card.title, tagsAdded: ["diy"] }; };
    const regenerateTitleFor = async () => "New Title #diy";
    let persisted = false, toasted = "";
    const factory = new Function(
      "imported", "applyGeneratedTitle", "regenerateTitleFor", "persistCards", "updateCounts",
      "curTab", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "refreshTabsViewIfShowing", "toast",
      extractFn(src, "impRefreshTitle") + "\nreturn impRefreshTitle;"
    );
    const impRefreshTitle = factory(
      imported, applyGeneratedTitle, regenerateTitleFor,
      async () => { persisted = true; }, () => {}, "imported",
      () => {}, () => {}, () => {}, () => false, (msg) => { toasted = msg; }
    );
    await impRefreshTitle(0);
    assert.strictEqual(it.title, "New Title");
    assert.deepStrictEqual(it.tags, ["diy"]);
    assert.ok(persisted);
    assert.ok(toasted.indexOf("New Title") >= 0);
    assert.ok(toasted.indexOf("#") === -1, "toast must show the cleaned title, not the raw one with '#'");
  });

  await t(label + ": impRefreshTitle is a no-op when regenerateTitleFor returns null (unchanged)", async () => {
    const it = { title: "old", tags: [] };
    const imported = [it];
    let applyCalled = false;
    const factory = new Function(
      "imported", "applyGeneratedTitle", "regenerateTitleFor", "persistCards", "updateCounts",
      "curTab", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "refreshTabsViewIfShowing", "toast",
      extractFn(src, "impRefreshTitle") + "\nreturn impRefreshTitle;"
    );
    const impRefreshTitle = factory(
      imported, () => { applyCalled = true; }, async () => null,
      async () => {}, () => {}, "imported",
      () => {}, () => {}, () => {}, () => false, () => {}
    );
    await impRefreshTitle(0);
    assert.strictEqual(it.title, "old");
    assert.strictEqual(applyCalled, false);
  });

  await t(label + ": enrichOnOpen applies a hashtag in the AI's suggested title as a tag, not literal text", async () => {
    // A facebook.com URL makes isFb=true, which short-circuits enrichOnOpen's
    // captureMeta/microlink/image-fallback blocks entirely — isolating just
    // the AI-title branch this task rewired, without having to stub every
    // media-fetch dependency those skipped blocks would otherwise need.
    const it = { title: "Facebook Post", desc: "a real description", url: "https://facebook.com/x/posts/1", tags: [] };
    const isGenericTitle = () => true;
    const generateUniqueTitle = async () => ({ title: "New Title #diy" });
    const applyGeneratedTitle = (card, rawTitle) => { card.title = rawTitle.replace(/#\w+/g, "").trim(); card.tags = ["diy"]; return { title: card.title, tagsAdded: ["diy"] }; };
    let putCardsCalled = false;
    const factory = new Function(
      "Store", "isGenericTitle", "setCardImage", "isBadImg", "fetchMicrolink", "Image",
      "IA_AI", "callAI", "generateUniqueTitle", "applyGeneratedTitle", "imported",
      "curTab", "renderImported", "restoreImpScrollSettle", "refreshTabsViewIfShowing", "toast", "document",
      extractFn(src, "enrichOnOpen") + "\nreturn enrichOnOpen;"
    );
    // `imported` is only ever passed BY REFERENCE into Store.putCards(imported)
    // — the stub below ignores its argument, so [] satisfies the free
    // variable without needing to mirror the real global array.
    const enrichOnOpen = factory(
      { putCards: () => { putCardsCalled = true; } }, isGenericTitle,
      () => {}, () => false, async () => null, function(){},
      { hasAIKey: () => true }, async () => "", generateUniqueTitle, applyGeneratedTitle, [],
      "imported", () => {}, () => {}, () => false, () => {}, { addEventListener: () => {} }
    );
    await enrichOnOpen(it, 0);
    assert.strictEqual(it.title, "New Title");
    assert.deepStrictEqual(it.tags, ["diy"]);
    assert.ok(putCardsCalled);
  });

  await t(label + ": enrichOnOpen's metadata-title branch captures hashtags from the outgoing title", async () => {
    const it = { id: "c1", title: "Old Post #throwback", desc: "a real description", url: "https://example.test/article", tags: [] };
    const isGenericTitle = () => true;
    let capturedFrom = null;
    const captureOutgoingHashtags = (card) => { capturedFrom = card.title; card.tags = ["throwback"]; };
    const captureOrigTitle = () => {};
    const settleOrigTitle = () => {};
    const factory = new Function(
      "Store", "isGenericTitle", "setCardImage", "isBadImg", "fetchMicrolink", "Image",
      "IA_AI", "callAI", "generateUniqueTitle", "applyGeneratedTitle", "captureOutgoingHashtags", "captureOrigTitle", "settleOrigTitle", "imported",
      "curTab", "renderImported", "restoreImpScrollSettle", "refreshTabsViewIfShowing", "toast", "document",
      extractFn(src, "enrichOnOpen") + "\nreturn enrichOnOpen;"
    );
    const enrichOnOpen = factory(
      { putCards: () => {}, captureMeta: async () => [{ id: "c1", title: "A Real Page Title From The Site", description: "", hasImage: false }] },
      isGenericTitle, () => {}, () => false, async () => null, function(){},
      { hasAIKey: () => false }, async () => "", async () => ({ title: null }), () => {}, captureOutgoingHashtags, captureOrigTitle, settleOrigTitle, [],
      "imported", () => {}, () => {}, () => false, () => {}, { addEventListener: () => {} }
    );
    await enrichOnOpen(it, 0);
    assert.strictEqual(capturedFrom, "Old Post #throwback");
    assert.deepStrictEqual(it.tags, ["throwback"]);
  });
}
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
})();
