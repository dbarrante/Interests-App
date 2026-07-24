// Tests for web/ai.js (IA_AI): parseJsonArray contract, callAI dispatch,
// hasAIKey truth table, and the configure-not-called error. Network-free:
// global.fetch is stubbed per-test and restored after.
const assert = require("assert");
const IA_AI = require("../web/ai");
let passed = 0, failed = 0;
const queue = [];
function t(n, fn){ queue.push([n, fn]); }

// ---- parseJsonArray: preserved contract = null on no-bracket, parsed value
//      otherwise (may be non-array), JSON.parse still throws on malformed JSON. ----
t("parseJsonArray: fenced ```json array", () => {
  assert.deepStrictEqual(IA_AI.parseJsonArray('```json\n["a","b"]\n```'), ["a","b"]);
});
t("parseJsonArray: bare ``` fence (no json tag)", () => {
  assert.deepStrictEqual(IA_AI.parseJsonArray('```\n[1,2,3]\n```'), [1,2,3]);
});
t("parseJsonArray: unfenced array", () => {
  assert.deepStrictEqual(IA_AI.parseJsonArray('[{"t":"x"}]'), [{t:"x"}]);
});
t("parseJsonArray: junk-wrapped -> slices outermost brackets", () => {
  assert.deepStrictEqual(IA_AI.parseJsonArray('Sure! here you go: ["one"] hope that helps'), ["one"]);
});
t("parseJsonArray: no bracket at all -> null (callers treat as error)", () => {
  assert.strictEqual(IA_AI.parseJsonArray("no array here"), null);
});
t("parseJsonArray: empty string -> null", () => {
  assert.strictEqual(IA_AI.parseJsonArray(""), null);
});
t("parseJsonArray: null/undefined input -> null (no throw)", () => {
  assert.strictEqual(IA_AI.parseJsonArray(null), null);
  assert.strictEqual(IA_AI.parseJsonArray(undefined), null);
});
t("parseJsonArray: brackets present but malformed JSON -> throws (preserved)", () => {
  assert.throws(() => IA_AI.parseJsonArray("[not, valid, json]"), SyntaxError);
});
t("parseJsonArray: non-array JSON inside brackets is returned as-is (callers check Array)", () => {
  // lastIndexOf("]") picks the final bracket; a nested object array still parses.
  assert.deepStrictEqual(IA_AI.parseJsonArray('[{"a":[1]}]'), [{a:[1]}]);
});

// ---- configure guard ----
t("callAI before configure -> clear error", () => {
  const fresh = requireFresh();
  assert.throws(() => fresh.callAI("hi"), /not configured/);
});
t("hasAIKey before configure -> clear error", () => {
  const fresh = requireFresh();
  assert.throws(() => fresh.hasAIKey(), /not configured/);
});

// ---- hasAIKey truth table ----
t("hasAIKey truth table", () => {
  const settings = { provider:"gemini", keys:{ gemini:"", anthropic:"sk-a", local:"" }, models:{}, localUrl:"" };
  IA_AI.configure(() => settings);
  settings.provider = "gemini";     assert.strictEqual(IA_AI.hasAIKey(), false, "no gemini key");
  settings.keys.gemini = "sk-g";    assert.strictEqual(IA_AI.hasAIKey(), true,  "gemini key present");
  settings.provider = "anthropic";  assert.strictEqual(IA_AI.hasAIKey(), true,  "anthropic key present");
  settings.provider = "local";      assert.strictEqual(IA_AI.hasAIKey(), true,  "local needs no key");
  settings.provider = "openai";     assert.strictEqual(IA_AI.hasAIKey(), false, "no openai key");
  // opts.provider override (used by confirmSoftDead which snapshots provider)
  assert.strictEqual(IA_AI.hasAIKey({ provider:"anthropic" }), true, "override anthropic");
  assert.strictEqual(IA_AI.hasAIKey({ provider:"local" }), true, "override local");
});

// ---- callAI dispatch with a fake settings accessor + stubbed global fetch ----
t("callAI dispatches to the configured provider (gemini) with the prompt", async () => {
  const settings = {
    provider:"gemini",
    keys:{ gemini:"KEY" }, models:{ gemini:"gemini-2.5-flash" }, localUrl:"http://x"
  };
  IA_AI.configure(() => settings);
  const seen = {};
  global.fetch = async (url, init) => {
    seen.url = url; seen.body = JSON.parse(init.body);
    return { ok:true, json: async () => ({ candidates:[{ content:{ parts:[{ text:"hello" }] } }] }) };
  };
  try {
    const out = await IA_AI.callAI("PROMPT_TEXT");
    assert.strictEqual(out, "hello");
    assert.ok(seen.url.indexOf("generativelanguage.googleapis.com") >= 0, "hit gemini endpoint");
    assert.ok(seen.url.indexOf("key=KEY") >= 0, "passed key");
    assert.strictEqual(seen.body.contents[0].parts[0].text, "PROMPT_TEXT", "passed prompt");
  } finally { delete global.fetch; }
});

t("callAI opts.provider overrides the configured provider (groq)", async () => {
  const settings = {
    provider:"gemini",
    keys:{ gemini:"G", groq:"GROQKEY" }, models:{ gemini:"g", groq:"llama" }, localUrl:""
  };
  IA_AI.configure(() => settings);
  const seen = {};
  global.fetch = async (url, init) => {
    seen.url = url; seen.auth = init.headers["Authorization"];
    return { ok:true, json: async () => ({ choices:[{ message:{ content:"groq-said" } }] }) };
  };
  try {
    const out = await IA_AI.callAI("P", { provider:"groq" });
    assert.strictEqual(out, "groq-said");
    assert.ok(seen.url.indexOf("api.groq.com") >= 0, "hit groq endpoint, not gemini");
    assert.strictEqual(seen.auth, "Bearer GROQKEY");
  } finally { delete global.fetch; }
});

t("callAI enables OpenRouter web search only when requested by Stumble", async () => {
  const settings = {
    provider:"openrouter",
    keys:{ openrouter:"ORKEY" }, models:{ openrouter:"openai/gpt-4o-mini" }, localUrl:""
  };
  IA_AI.configure(() => settings);
  const bodies = [];
  global.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok:true, json: async () => ({ choices:[{ message:{ content:"[]" } }] }) };
  };
  try {
    await IA_AI.callAI("STUMBLE", { webSearch:true });
    await IA_AI.callAI("ENRICH");
    assert.deepStrictEqual(bodies[0].tools, [{
      type:"openrouter:web_search",
      parameters:{ max_results:6, max_total_results:6, search_context_size:"low" }
    }], "Stumble request gets grounded OpenRouter search");
    assert.strictEqual(bodies[0].max_tokens, 2500, "grounded JSON response is bounded");
    assert.ok(!("tools" in bodies[1]), "ordinary OpenRouter calls do not incur web-search cost");
  } finally { delete global.fetch; }
});

t("callAI unknown provider -> throws", () => {
  IA_AI.configure(() => ({ provider:"nope", keys:{}, models:{}, localUrl:"" }));
  assert.throws(() => IA_AI.callAI("x"), /Unknown AI provider/);
});

t("callAI surfaces non-ok API errors", async () => {
  IA_AI.configure(() => ({ provider:"openai", keys:{ openai:"K" }, models:{ openai:"gpt" }, localUrl:"" }));
  global.fetch = async () => ({ ok:false, status:429, text: async () => "rate limited" });
  try {
    await assert.rejects(IA_AI.callAI("x"), /OpenAI API error 429/);
  } finally { delete global.fetch; }
});

// ---- opts.model override tests ----
t("callAI opts.model overrides the configured model (gemini)", async () => {
  const settings = { provider:"gemini", keys:{ gemini:"KEY" }, models:{ gemini:"gemini-2.5-flash" }, localUrl:"" };
  IA_AI.configure(() => settings);
  let seenUrl;
  global.fetch = async (url) => { seenUrl = url; return { ok:true, json: async () => ({ candidates:[{ content:{ parts:[{ text:"hi" }] } }] }) }; };
  try {
    await IA_AI.callAI("P", { model: "gemini-2.5-pro" });
    assert.ok(seenUrl.indexOf("/models/gemini-2.5-pro:") >= 0, "used the override model, not the configured one: " + seenUrl);
  } finally { delete global.fetch; }
});
t("callAI opts.model overrides the configured model (anthropic)", async () => {
  IA_AI.configure(() => ({ provider:"anthropic", keys:{ anthropic:"K" }, models:{ anthropic:"claude-default" }, localUrl:"" }));
  let seenBody;
  global.fetch = async (_url, init) => { seenBody = JSON.parse(init.body); return { ok:true, json: async () => ({ content:[{ type:"text", text:"hi" }] }) }; };
  try {
    await IA_AI.callAI("P", { model: "claude-override" });
    assert.strictEqual(seenBody.model, "claude-override");
  } finally { delete global.fetch; }
});
t("callAI opts.model overrides the configured model (openai)", async () => {
  IA_AI.configure(() => ({ provider:"openai", keys:{ openai:"K" }, models:{ openai:"gpt-default" }, localUrl:"" }));
  let seenBody;
  global.fetch = async (_url, init) => { seenBody = JSON.parse(init.body); return { ok:true, json: async () => ({ output_text:"hi" }) }; };
  try {
    await IA_AI.callAI("P", { model: "gpt-override" });
    assert.strictEqual(seenBody.model, "gpt-override");
  } finally { delete global.fetch; }
});
t("callAI opts.model overrides the configured model (groq)", async () => {
  IA_AI.configure(() => ({ provider:"groq", keys:{ groq:"K" }, models:{ groq:"groq-default" }, localUrl:"" }));
  let seenBody;
  global.fetch = async (_url, init) => { seenBody = JSON.parse(init.body); return { ok:true, json: async () => ({ choices:[{ message:{ content:"hi" } }] }) }; };
  try {
    await IA_AI.callAI("P", { model: "groq-override" });
    assert.strictEqual(seenBody.model, "groq-override");
  } finally { delete global.fetch; }
});
t("callAI opts.model overrides the configured model (openrouter)", async () => {
  IA_AI.configure(() => ({ provider:"openrouter", keys:{ openrouter:"K" }, models:{ openrouter:"or-default" }, localUrl:"" }));
  let seenBody;
  global.fetch = async (_url, init) => { seenBody = JSON.parse(init.body); return { ok:true, json: async () => ({ choices:[{ message:{ content:"hi" } }] }) }; };
  try {
    await IA_AI.callAI("P", { model: "or-override" });
    assert.strictEqual(seenBody.model, "or-override");
  } finally { delete global.fetch; }
});
t("callAI opts.model overrides the configured model (local)", async () => {
  IA_AI.configure(() => ({ provider:"local", keys:{}, models:{ local:"local-default" }, localUrl:"http://x" }));
  let seenBody;
  global.fetch = async (_url, init) => { seenBody = JSON.parse(init.body); return { ok:true, json: async () => ({ choices:[{ message:{ content:"hi" } }] }) }; };
  try {
    await IA_AI.callAI("P", { model: "local-override" });
    assert.strictEqual(seenBody.model, "local-override");
  } finally { delete global.fetch; }
});
t("callAI without opts.model still uses the configured model (regression guard, all providers)", async () => {
  const cases = [
    ["gemini", (b, u) => u.indexOf("/models/gem-default:") >= 0],
    ["anthropic", (b) => b.model === "anthropic-default"],
    ["openai", (b) => b.model === "openai-default"],
    ["groq", (b) => b.model === "groq-default"],
    ["openrouter", (b) => b.model === "openrouter-default"],
  ];
  for (const [provider, check] of cases) {
    IA_AI.configure(() => ({ provider, keys:{ [provider]:"K" }, models:{ [provider]: provider==="gemini"?"gem-default":(provider+"-default") }, localUrl:"" }));
    let seenBody, seenUrl;
    global.fetch = async (url, init) => { seenUrl = url; seenBody = init && init.body ? JSON.parse(init.body) : null; return { ok:true, json: async () => ({ candidates:[{content:{parts:[{text:"hi"}]}}], content:[{type:"text",text:"hi"}], output_text:"hi", choices:[{message:{content:"hi"}}] }) }; };
    try {
      await IA_AI.callAI("P");
      assert.ok(check(seenBody, seenUrl), provider + " should use its configured default model when opts.model is absent");
    } finally { delete global.fetch; }
  }
});

// Load a pristine copy of the module (unconfigured) for the configure-guard tests.
function requireFresh(){
  const p = require.resolve("../web/ai");
  delete require.cache[p];
  const m = require("../web/ai");
  delete require.cache[p]; // don't poison the shared instance used by later tests
  return m;
}

// Run queued tests sequentially so async fetch stubs never overlap.
(async () => {
  for (const [n, fn] of queue) {
    try { await fn(); passed++; }
    catch (e) { failed++; console.error("FAIL: " + n + "\n  " + (e && e.stack || e)); }
  }
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
