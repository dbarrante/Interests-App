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
const { buildTitlePrompt, parseTitleReply } = require("../web/title-ai.js");
const { isGenericTitle } = require("../web/lib/capture-state.js");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");

function loadTitleFns(aiReplies) {
  // aiReplies: array of strings, one per callAI invocation, consumed in order.
  let callCount = 0;
  const domain = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return ""; } };
  const callAI = async () => { const r = aiReplies[callCount]; callCount++; if (r instanceof Error) throw r; return r; };
  const IA_AI = { hasAIKey: () => true };
  const sandbox = { imported: [], saved: [], buildTitlePrompt, parseTitleReply, domain, callAI, IA_AI, isGenericTitle, console };
  const src = [
    extractFn(html, "normalizeTitleKey"),
    extractFn(html, "allTitleKeys"),
    extractFn(html, "generateUniqueTitle"),
  ].join("\n");
  // eval in a function scope closed over `sandbox`'s properties as locals —
  // matches loadFns' approach (_extract.js) but with our own controlled globals.
  const factory = new Function(
    "imported", "saved", "buildTitlePrompt", "parseTitleReply", "domain", "callAI", "IA_AI", "isGenericTitle",
    src + "\nreturn { normalizeTitleKey, allTitleKeys, generateUniqueTitle };"
  );
  return { fns: factory(sandbox.imported, sandbox.saved, sandbox.buildTitlePrompt, sandbox.parseTitleReply, sandbox.domain, sandbox.callAI, sandbox.IA_AI, sandbox.isGenericTitle), sandbox, callCountRef: () => callCount };
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

  console.log(pass + " passed, " + fail + " failed");
  process.exitCode = fail ? 1 : 0;
})();
