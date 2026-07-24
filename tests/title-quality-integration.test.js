// tests/title-quality-integration.test.js — behavioral test of
// generateUniqueTitle()'s uniqueness/collision-retry logic, extracted from
// the real web/index.html source (not reimplemented) and run against a
// scripted fake AI provider. Mirrors the extraction technique
// tests/duplicate-review-mode.test.js already uses for self-contained
// inline-script functions.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");
const { buildTitlePrompt, parseTitleReply, extractWeakContext, composeFallbackTitle } = require("../web/title-ai.js");
const { isGenericTitle } = require("../web/lib/capture-state.js");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");

function loadTitleFns(aiReplies, opts) {
  opts = opts || {};
  // aiReplies: array of strings, one per callAI invocation, consumed in order.
  let callCount = 0;
  const domain = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } };
  const callAI = async (prompt, callOpts) => { const r = aiReplies[callCount]; callCount++; if (r instanceof Error) throw r; return r; };
  const IA_AI = { hasAIKey: () => true };
  // Fakes for the browser-only tiers — real behavior is manually verified
  // (Task 10); these let the ORDERING/short-circuit logic be tested here.
  const ocrExtractText = opts.ocrExtractText || (async () => null);
  const resolveCardImageForAI = opts.resolveCardImageForAI || (async () => null);
  const sandbox = { imported: [], saved: [], buildTitlePrompt, parseTitleReply, domain, callAI, IA_AI, isGenericTitle, extractWeakContext, composeFallbackTitle, ocrExtractText, resolveCardImageForAI, console };
  // generateUniqueTitle reads the module-level `_titleVisionModel` (Tier 2's
  // vision-model override) as a free variable — extractFn only pulls function
  // bodies, so pull this one statement out of the real source too, rather than
  // hardcoding a copy that could drift from the shipped declaration.
  const visionModelDecl = /\nlet _titleVisionModel = [^\n]*;/.exec(html);
  if (!visionModelDecl) throw new Error("_titleVisionModel declaration not found in index.html");
  const src = [
    visionModelDecl[0].trim(),
    extractFn(html, "normalizeTitleKey"),
    extractFn(html, "allTitleKeys"),
    extractFn(html, "titleFromSignal"),
    extractFn(html, "fallbackCollectionTitle"),
    extractFn(html, "generateUniqueTitle"),
  ].join("\n");
  // eval in a function scope closed over `sandbox`'s properties as locals —
  // matches loadFns' approach (_extract.js) but with our own controlled globals.
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

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.stack || e)); } }

(async () => {
  await t("generateUniqueTitle returns the AI's title when it's unique on the first try", async () => {
    const { fns, sandbox } = loadTitleFns(["Backyard Pizza Oven Build Guide"]);
    sandbox.imported.push({ id: "a", title: "Some Other Existing Descriptive Title", url: "https://x.com/a" });
    const result = await fns.generateUniqueTitle({ id: "b", desc: "A guide to pizza ovens", url: "https://x.com/pizza" });
    assert.strictEqual(result, "Backyard Pizza Oven Build Guide");
  });

  await t("generateUniqueTitle retries with avoidTitles when the AI's first pick collides", async () => {
    const { fns, sandbox, callCountRef } = loadTitleFns(["Backyard Pizza Oven Guide", "Outdoor Wood-Fired Oven Plans"]);
    sandbox.imported.push({ id: "existing", title: "Backyard Pizza Oven Guide", url: "https://x.com/existing" });
    const result = await fns.generateUniqueTitle({ id: "new", desc: "pizza oven", url: "https://x.com/new" });
    assert.strictEqual(result, "Outdoor Wood-Fired Oven Plans");
    assert.strictEqual(callCountRef(), 2, "should have retried exactly once");
  });

  await t("generateUniqueTitle disambiguates with the domain after 3 straight collisions", async () => {
    const { fns, sandbox } = loadTitleFns(["Same Title Every Time", "Same Title Every Time", "Same Title Every Time"]);
    sandbox.imported.push({ id: "existing", title: "Same Title Every Time", url: "https://x.com/existing" });
    const result = await fns.generateUniqueTitle({ id: "new", desc: "d", url: "https://pizza-blog.example.com/new" });
    assert.strictEqual(result, "Same Title Every Time — pizza-blog.example.com");
  });

  await t("generateUniqueTitle appends a numeric suffix if even the disambiguated title collides", async () => {
    const { fns, sandbox } = loadTitleFns(["Same Title Every Time", "Same Title Every Time", "Same Title Every Time"]);
    sandbox.imported.push({ id: "existing1", title: "Same Title Every Time", url: "https://x.com/e1" });
    sandbox.imported.push({ id: "existing2", title: "Same Title Every Time — pizza-blog.example.com", url: "https://x.com/e2" });
    const result = await fns.generateUniqueTitle({ id: "new", desc: "d", url: "https://pizza-blog.example.com/new" });
    assert.strictEqual(result, "Same Title Every Time — pizza-blog.example.com (2)");
  });

  await t("generateUniqueTitle returns null when there's no AI key", async () => {
    const { fns, sandbox } = loadTitleFns([]);
    sandbox.IA_AI.hasAIKey = () => false;
    const result = await fns.generateUniqueTitle({ id: "new", desc: "d", url: "https://x.com/new" });
    assert.strictEqual(result, null);
  });

  await t("generateUniqueTitle returns null when there's no description AND no url", async () => {
    const { fns } = loadTitleFns([]);
    const result = await fns.generateUniqueTitle({ id: "new", desc: "", url: "" });
    assert.strictEqual(result, null);
  });

  await t("generateUniqueTitle returns null when desc is empty but a url is present (URL alone isn't enough signal)", async () => {
    const { fns, callCountRef } = loadTitleFns([]);
    const result = await fns.generateUniqueTitle({ id: "new", desc: "", url: "https://facebook.com/permalink.php?story_fbid=123&id=456" });
    assert.strictEqual(result, null);
    assert.strictEqual(callCountRef(), 0, "should not call the AI when there's no real description");
  });

  await t("generateUniqueTitle treats a 'Saved from X' placeholder desc as no real description, even with a url", async () => {
    const { fns, callCountRef } = loadTitleFns([]);
    const result = await fns.generateUniqueTitle({ id: "new", desc: "Saved from Facebook", url: "https://facebook.com/permalink.php?story_fbid=123&id=456" });
    assert.strictEqual(result, null);
    assert.strictEqual(callCountRef(), 0, "boilerplate 'Saved from ...' desc must not be treated as real content");
  });

  await t("generateUniqueTitle treats a 'From your X' placeholder desc as no real description", async () => {
    const { fns, callCountRef } = loadTitleFns([]);
    const result = await fns.generateUniqueTitle({ id: "new", desc: "From your Saved list", url: "https://facebook.com/x" });
    assert.strictEqual(result, null);
    assert.strictEqual(callCountRef(), 0, "boilerplate 'From your ...' desc must not be treated as real content");
  });

  await t("generateUniqueTitle rejects a unique-but-still-generic candidate and keeps retrying", async () => {
    const { fns, callCountRef } = loadTitleFns(["Short One", "A Sufficiently Long Descriptive Title Here"]);
    const result = await fns.generateUniqueTitle({ id: "new", desc: "d", url: "https://x.com/new" });
    assert.strictEqual(result, "A Sufficiently Long Descriptive Title Here");
    assert.strictEqual(callCountRef(), 2, "should have retried after the first candidate was rejected for being generic, not just for colliding");
  });

  await t("generateUniqueTitle checks extraAvoid (in-flight batch titles) alongside the library", async () => {
    const { fns } = loadTitleFns(["A Title Already Suggested This Batch", "A Genuinely Different New Title"]);
    const result = await fns.generateUniqueTitle(
      { id: "new", desc: "d", url: "https://x.com/new" },
      ["A Title Already Suggested This Batch"]
    );
    assert.strictEqual(result, "A Genuinely Different New Title");
  });

  await t("generateUniqueTitle Tier 1: uses OCR'd text as the description when there's no real desc", async () => {
    const { fns } = loadTitleFns(["A Title Extracted From OCR Text"], { ocrExtractText: async () => "some legible quote text" });
    const result = await fns.generateUniqueTitle({ id:"new", desc:"Saved from Facebook", url:"https://facebook.com/x/posts/1" });
    assert.strictEqual(result, "A Title Extracted From OCR Text");
  });

  await t("generateUniqueTitle Tier 2: falls back to vision when OCR finds nothing", async () => {
    const { fns } = loadTitleFns(["A Title Generated From The Vision Model"], {
      ocrExtractText: async () => null,
      resolveCardImageForAI: async () => ({ mediaType:"image/jpeg", base64:"xyz" }),
    });
    const result = await fns.generateUniqueTitle({ id:"new", desc:"Saved from Facebook", url:"https://facebook.com/x/posts/1", img:"idb:new" });
    assert.strictEqual(result, "A Title Generated From The Vision Model");
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
    const { fns } = loadTitleFns(["A Genuinely Unique Real Article Title"], {
      ocrExtractText: async () => { ocrCalled = true; return null; },
      resolveCardImageForAI: async () => { visionCalled = true; return null; },
    });
    const result = await fns.generateUniqueTitle({ id:"new", desc:"A genuinely real description of the content", url:"https://x.com/new" });
    assert.strictEqual(result, "A Genuinely Unique Real Article Title");
    assert.strictEqual(ocrCalled, false);
    assert.strictEqual(visionCalled, false);
  });

  await t("fallbackCollectionTitle: respects uniqueness (disambiguates on collision)", async () => {
    const { fns, sandbox } = loadTitleFns([]);
    sandbox.imported.push({ id:"existing", title:"VR Stuff — saved from a Facebook collection", url:"https://x.com/e" });
    const result = await fns.fallbackCollectionTitle({ id:"new", url:"https://facebook.com/x" }, "VR Stuff", []);
    assert.strictEqual(result, "VR Stuff — saved from a Facebook collection (2)");
  });

  console.log(pass + " passed, " + fail + " failed");
  process.exitCode = fail ? 1 : 0;
})();
