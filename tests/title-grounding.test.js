// tests/title-grounding.test.js — generateUniqueTitle prefers a freshly-fetched
// groundingText excerpt over card.desc when both are present; regenerateTitleFor
// fetches it via Store.captureMeta before generating.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

(async () => {
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  await t(label + ": generateUniqueTitle uses groundingText instead of card.desc when both are present", async () => {
    let seenDescription = null;
    const factory = new Function(
      "IA_AI", "looksLikeVideo", "ocrExtractText", "titleFromSignal", "extractWeakContext", "resolveCardImageForAI",
      extractFn(src, "generateUniqueTitle") + "\nreturn generateUniqueTitle;"
    );
    const generateUniqueTitle = factory(
      { hasAIKey: () => true },
      () => false,
      async () => null,
      async (card, opts) => { seenDescription = opts.description; return "Resulting Title"; },
      () => ({ collection: "" }),
      async () => null
    );
    const card = { desc: "thin og description", url: "https://example.test/x" };
    await generateUniqueTitle(card, [], true, "A much richer article excerpt fetched fresh from the page.");
    assert.strictEqual(seenDescription, "A much richer article excerpt fetched fresh from the page.");
  });

  await t(label + ": generateUniqueTitle falls back to card.desc when groundingText is empty", async () => {
    let seenDescription = null;
    const factory = new Function(
      "IA_AI", "looksLikeVideo", "ocrExtractText", "titleFromSignal", "extractWeakContext", "resolveCardImageForAI",
      extractFn(src, "generateUniqueTitle") + "\nreturn generateUniqueTitle;"
    );
    const generateUniqueTitle = factory(
      { hasAIKey: () => true },
      () => false,
      async () => null,
      async (card, opts) => { seenDescription = opts.description; return "Resulting Title"; },
      () => ({ collection: "" }),
      async () => null
    );
    const card = { desc: "a real usable description", url: "https://example.test/x" };
    await generateUniqueTitle(card, [], true, "");
    assert.strictEqual(seenDescription, "a real usable description");
  });

  await t(label + ": regenerateTitleFor fetches grounding via Store.captureMeta before generating", async () => {
    let capturedArg = null, seenGrounding = null;
    const factory = new Function(
      "IA_AI", "PROVIDERS", "S", "toast", "showBusyOverlay", "hideBusyOverlay", "requestAnimationFrame", "Store", "generateUniqueTitle",
      extractFn(src, "fetchGroundingExcerpt") + "\n" + extractFn(src, "regenerateTitleFor") + "\nreturn regenerateTitleFor;"
    );
    const regenerateTitleFor = factory(
      { hasAIKey: () => true }, { anthropic: { keyName: "key" } }, { provider: "anthropic" },
      () => {}, () => {}, () => {}, (cb) => cb(),
      { captureMeta: async (items) => { capturedArg = items; return [{ id: items[0].id, excerpt: "fetched excerpt text" }]; } },
      async (card, extraAvoid, allowVision, groundingText) => { seenGrounding = groundingText; return { title: "New Title", failReason: "" }; }
    );
    const out = await regenerateTitleFor({ id: "c1", url: "https://example.test/y" }, [], "");
    assert.strictEqual(out, "New Title");
    assert.deepStrictEqual(capturedArg, [{ id: "c1", url: "https://example.test/y" }]);
    assert.strictEqual(seenGrounding, "fetched excerpt text");
  });

  await t(label + ": fetchGroundingExcerpt calls Store.captureMeta with excerptOnly:true (must never overwrite the card's captured image)", async () => {
    let capturedOpts = null;
    const factory = new Function(
      "Store",
      extractFn(src, "fetchGroundingExcerpt") + "\nreturn fetchGroundingExcerpt;"
    );
    const fetchGroundingExcerpt = factory(
      { captureMeta: async (items, opts) => { capturedOpts = opts; return [{ id: items[0].id, excerpt: "grounding text" }]; } }
    );
    const out = await fetchGroundingExcerpt({ id: "c2", url: "https://example.test/z" });
    assert.strictEqual(out, "grounding text");
    assert.deepStrictEqual(capturedOpts, { excerptOnly: true },
      "fetchGroundingExcerpt must pass excerptOnly:true so the Core skips the og:image download/write");
  });
}
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
})();
