// tests/ai-credits-message.test.js — IA_AI.creditsMessage classifies
// out-of-credits provider failures (specific actionable toast) vs everything
// else (null -> callers keep their generic "Hmm:" text). Runs against BOTH
// copies (web/ai.js + pwa/ai.js) so they can't drift.
const assert = require("assert");
const path = require("path");

let passed = 0, failed = 0;
function t(n, fn) { try { fn(); passed++; } catch (e) { failed++; console.error("FAIL: " + n + "\n  " + (e && e.stack || e)); } }

for (const which of ["web", "pwa"]) {
  const AI = require(path.join(__dirname, "..", which, "ai.js"));
  AI.configure(() => ({ provider: "anthropic", keys: { anthropic: "k" }, models: {}, localUrl: "" }));
  const err = (m) => new Error(m);

  /* ---------- positives: genuine out-of-credits signals ---------- */
  t(`${which}: Anthropic 400 credit-balance body -> credits message with provider name`, () => {
    const m = AI.creditsMessage(err('Anthropic API error 400: {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}'));
    assert.ok(m && /Anthropic/.test(m) && /out of credits/.test(m), m);
  });
  t(`${which}: OpenAI 429 insufficient_quota -> credits message`, () => {
    const m = AI.creditsMessage(err('OpenAI API error 429: {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","code":"insufficient_quota"}}'), { provider: "openai" });
    assert.ok(m && /OpenAI/.test(m), m);
  });
  t(`${which}: any HTTP 402 (OpenRouter Payment Required) -> credits message`, () => {
    const m = AI.creditsMessage(err('OpenRouter API error 402: {"error":{"message":"Insufficient credits"}}'), { provider: "local" });
    assert.ok(m && /local\/custom/.test(m), m);
  });
  t(`${which}: Gemini RESOURCE_EXHAUSTED with a billing/plan marker -> credits message`, () => {
    const m = AI.creditsMessage(err('Gemini API error 429: {"error":{"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded for the free tier of the API, enable billing on your plan."}}'), { provider: "gemini" });
    assert.ok(m && /Gemini/.test(m), m);
  });

  /* ---------- negatives: NOT credit problems ---------- */
  t(`${which}: plain rate limit (429, no quota marker) -> null`, () => {
    assert.strictEqual(AI.creditsMessage(err('Groq API error 429: {"error":{"message":"Rate limit reached, retry in 2s","code":"rate_limit_exceeded"}}')), null);
  });
  t(`${which}: bad key (401) -> null`, () => {
    assert.strictEqual(AI.creditsMessage(err('Anthropic API error 401: {"error":{"message":"invalid x-api-key"}}')), null);
  });
  t(`${which}: network failure -> null`, () => {
    assert.strictEqual(AI.creditsMessage(err("Failed to fetch")), null);
  });
  t(`${which}: bare Gemini RESOURCE_EXHAUSTED (per-minute limit, no billing marker) -> null`, () => {
    assert.strictEqual(AI.creditsMessage(err('Gemini API error 429: {"error":{"status":"RESOURCE_EXHAUSTED","message":"Requests per minute exceeded"}}')), null);
  });
  t(`${which}: null/undefined err -> null, no throw`, () => {
    assert.strictEqual(AI.creditsMessage(null), null);
    assert.strictEqual(AI.creditsMessage(undefined), null);
  });
  t(`${which}: provider falls back to configured settings when opts absent`, () => {
    const m = AI.creditsMessage(err("X API error 402: pay up"));
    assert.ok(/Anthropic/.test(m), "configured provider (anthropic) named: " + m);
  });
}

console.log("ai-credits-message: " + passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
