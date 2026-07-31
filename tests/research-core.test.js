// tests/research-core.test.js — Task 1: the AI research assistant's pure logic
// (provider capability gate, card resolver, prompt builders, and the plain-text
// article/answer parser). No DOM, no async — these are the building blocks every
// later task's UI orchestration calls into.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }
function fn(src, name) { const m = extractFn(src, name); assert.ok(m, name + " not found in source"); return m; }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": RESEARCH_PROVIDERS is exactly {anthropic, openai, gemini, openrouter}", () => {
    const factory = new Function(src.match(/const RESEARCH_PROVIDERS[^;]+;/)[0] + "\nreturn RESEARCH_PROVIDERS;");
    const set = factory();
    assert.deepStrictEqual([...set].sort(), ["anthropic", "gemini", "openai", "openrouter"]);
  });

  t(label + ": hasResearchProvider is true for anthropic/openai/gemini/openrouter, false for groq/local", () => {
    const body = [src.match(/const RESEARCH_PROVIDERS[^;]+;/)[0], fn(src, "hasResearchProvider")].join("\n");
    for (const provider of ["anthropic", "openai", "gemini", "openrouter"]) {
      const factory = new Function("S", body + "\nreturn hasResearchProvider;");
      assert.strictEqual(factory({ provider })(), true, provider + " should be capable");
    }
    for (const provider of ["groq", "local"]) {
      const factory = new Function("S", body + "\nreturn hasResearchProvider;");
      assert.strictEqual(factory({ provider })(), false, provider + " should NOT be capable");
    }
  });

  t(label + ": _researchCard resolves by scope+id from imported or saved, undefined if missing", () => {
    const factory = new Function(
      "imported", "saved",
      fn(src, "_researchCard") + "\nreturn _researchCard;"
    );
    const impArr = [{ id: "i0", title: "A" }];
    const savArr = [{ id: "s0", title: "B" }];
    const _researchCard = factory(impArr, savArr);
    assert.strictEqual(_researchCard("imported", "i0"), impArr[0]);
    assert.strictEqual(_researchCard("saved", "s0"), savArr[0]);
    assert.strictEqual(_researchCard("imported", "nope"), undefined);
    assert.strictEqual(_researchCard("saved", "nope"), undefined);
  });

  t(label + ": buildArticlePrompt includes the card's title, and desc/url only when present", () => {
    const factory = new Function(fn(src, "buildArticlePrompt") + "\nreturn buildArticlePrompt;");
    const buildArticlePrompt = factory();
    const bare = buildArticlePrompt({ title: "Ferrofluid displays" });
    assert.match(bare, /Ferrofluid displays/);
    assert.doesNotMatch(bare, /Context:/);
    assert.doesNotMatch(bare, /Original link:/);
    const full = buildArticlePrompt({ title: "Ferrofluid displays", desc: "A kinetic art piece", url: "https://example.com/x" });
    assert.match(full, /Context: A kinetic art piece/);
    assert.match(full, /Original link: https:\/\/example\.com\/x/);
    assert.match(full, /SOURCES/i);
  });

  t(label + ": buildQuestionPrompt includes the card's title and the literal question text", () => {
    const factory = new Function(fn(src, "buildQuestionPrompt") + "\nreturn buildQuestionPrompt;");
    const buildQuestionPrompt = factory();
    const p = buildQuestionPrompt({ title: "Ferrofluid displays" }, "How much does one cost?");
    assert.match(p, /Ferrofluid displays/);
    assert.match(p, /How much does one cost\?/);
    assert.match(p, /SOURCES/i);
  });

  t(label + ": parseResearchResponse splits body text from a SOURCES: block and extracts URLs", () => {
    const factory = new Function(fn(src, "parseResearchResponse") + "\nreturn parseResearchResponse;");
    const parseResearchResponse = factory();
    const out = parseResearchResponse("Ferrofluid displays use magnetic nanoparticles.\n\nSOURCES:\nhttps://example.com/a\nhttps://example.com/b (great overview)\n");
    assert.strictEqual(out.text, "Ferrofluid displays use magnetic nanoparticles.");
    assert.deepStrictEqual(out.sources, ["https://example.com/a", "https://example.com/b"]);
  });

  t(label + ": parseResearchResponse tolerates lowercase 'sources:' and no trailing newline", () => {
    const factory = new Function(fn(src, "parseResearchResponse") + "\nreturn parseResearchResponse;");
    const parseResearchResponse = factory();
    const out = parseResearchResponse("Body text here.\nsources:\nhttps://example.com/z");
    assert.strictEqual(out.text, "Body text here.");
    assert.deepStrictEqual(out.sources, ["https://example.com/z"]);
  });

  t(label + ": parseResearchResponse returns an empty sources array when no SOURCES: block is present", () => {
    const factory = new Function(fn(src, "parseResearchResponse") + "\nreturn parseResearchResponse;");
    const parseResearchResponse = factory();
    const out = parseResearchResponse("Just plain article text, no citations given.");
    assert.strictEqual(out.text, "Just plain article text, no citations given.");
    assert.deepStrictEqual(out.sources, []);
  });

  t(label + ": parseResearchResponse dedupes sources and caps at 10", () => {
    const factory = new Function(fn(src, "parseResearchResponse") + "\nreturn parseResearchResponse;");
    const parseResearchResponse = factory();
    const many = Array.from({ length: 15 }, (_, i) => "https://example.com/" + i).join("\n");
    const out = parseResearchResponse("Body.\n\nSOURCES:\nhttps://example.com/0\n" + many);
    assert.strictEqual(out.sources.length, 10);
    assert.strictEqual(new Set(out.sources).size, 10);
  });

  t(label + ": parseResearchResponse throws on an empty response", () => {
    const factory = new Function(fn(src, "parseResearchResponse") + "\nreturn parseResearchResponse;");
    const parseResearchResponse = factory();
    assert.throws(() => parseResearchResponse(""));
    assert.throws(() => parseResearchResponse("   "));
  });

  t(label + ": parseResearchResponse throws when the body is empty even if a SOURCES: block follows", () => {
    const factory = new Function(fn(src, "parseResearchResponse") + "\nreturn parseResearchResponse;");
    const parseResearchResponse = factory();
    assert.throws(() => parseResearchResponse("\nSOURCES:\nhttps://example.com/a"));
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
