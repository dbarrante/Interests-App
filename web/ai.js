/* web/ai.js — the ONE AI provider dispatcher + JSON-array parser.
   Replaces ~10 copies of the `{anthropic:callAnthropic,...}[S.provider]` dispatch
   object and the strip-fences -> bracket-slice -> JSON.parse block that were
   copy-pasted throughout index.html.

   Decoupled from the page's global `S`: index.html calls IA_AI.configure(() => S)
   once at boot, so the module is Node-testable with a fake settings accessor.
   Dual browser/Node like route-capture.js / storage.js: attach on `root` for the
   browser, module.exports for tests. The provider callers use fetch and are gated
   on `typeof fetch`; parseJsonArray is pure (no fetch, no globals). */
(function (root) {
  "use strict";

  // Injected settings accessor. Returns the live settings object (S) with the same
  // shape index.html uses: { provider, keys{...}, models{...}, localUrl }.
  var _getSettings = null;
  function configure(getSettings) { _getSettings = getSettings; }
  function S() {
    if (!_getSettings) throw new Error("IA_AI not configured — call IA_AI.configure(() => S) at boot");
    return _getSettings();
  }

  var hasFetch = (typeof fetch !== "undefined");

  /* ============ providers ============ */
  async function callAnthropic(prompt) {
    var s = S();
    var r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": s.keys.anthropic,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model: s.models.anthropic, max_tokens: 6000,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
        messages: [{ role: "user", content: prompt }]
      })
    });
    if (!r.ok) throw new Error("Anthropic API error " + r.status + ": " + (await r.text()).slice(0, 300));
    var d = await r.json();
    return (d.content || []).filter(function (b) { return b.type === "text"; }).map(function (b) { return b.text; }).join("\n");
  }
  async function callOpenAI(prompt) {
    var s = S();
    var r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + s.keys.openai },
      body: JSON.stringify({ model: s.models.openai, tools: [{ type: "web_search" }], input: prompt })
    });
    if (!r.ok) throw new Error("OpenAI API error " + r.status + ": " + (await r.text()).slice(0, 300));
    var d = await r.json();
    var out = "";
    (d.output || []).forEach(function (o) { if (o.type === "message") (o.content || []).forEach(function (c) { if (c.type === "output_text") out += c.text; }); });
    return out || d.output_text || "";
  }
  async function callGemini(prompt) {
    var s = S();
    var url = "https://generativelanguage.googleapis.com/v1beta/models/" + s.models.gemini + ":generateContent?key=" + s.keys.gemini;
    var r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], tools: [{ google_search: {} }] })
    });
    if (!r.ok) throw new Error("Gemini API error " + r.status + ": " + (await r.text()).slice(0, 300));
    var d = await r.json();
    var parts = (d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];
    return parts.map(function (p) { return p.text || ""; }).join("\n");
  }
  async function callGroq(prompt) {
    var s = S();
    var r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + s.keys.groq },
      body: JSON.stringify({ model: s.models.groq, temperature: 0.8, messages: [{ role: "user", content: prompt }] })
    });
    if (!r.ok) throw new Error("Groq API error " + r.status + ": " + (await r.text()).slice(0, 300));
    var d = await r.json();
    return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "";
  }
  async function callOpenRouter(prompt, opts) {
    var s = S();
    opts = opts || {};
    var body = { model: s.models.openrouter, temperature: 0.8, messages: [{ role: "user", content: prompt }] };
    if (opts.webSearch) {
      body.max_tokens = 2500;
      body.tools = [{
        type: "openrouter:web_search",
        parameters: { max_results: 6, max_total_results: 6, search_context_size: "low" }
      }];
    }
    var r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json", "Authorization": "Bearer " + s.keys.openrouter,
        "HTTP-Referer": "http://localhost:3456", "X-Title": "Interests App"
      },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error("OpenRouter API error " + r.status + ": " + (await r.text()).slice(0, 300));
    var d = await r.json();
    return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "";
  }
  async function callLocal(prompt) {
    var s = S();
    var headers = { "Content-Type": "application/json" };
    if (s.keys.local) headers["Authorization"] = "Bearer " + s.keys.local;
    var r = await fetch(s.localUrl + "/chat/completions", {
      method: "POST", headers: headers,
      body: JSON.stringify({ model: s.models.local, temperature: 0.8, messages: [{ role: "user", content: prompt }] })
    }).catch(function () { throw new Error("Can't reach " + s.localUrl + ". If using Ollama, start it with OLLAMA_ORIGINS=* set."); });
    if (!r.ok) throw new Error("Endpoint error " + r.status + ": " + (await r.text()).slice(0, 300));
    var d = await r.json();
    return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || "";
  }

  var PROVIDER_CALLERS = {
    anthropic: callAnthropic, openai: callOpenAI, gemini: callGemini,
    groq: callGroq, openrouter: callOpenRouter, local: callLocal
  };

  /* ============ dispatcher ============ */
  // callAI(prompt, opts?) — the single provider dispatcher. opts.provider overrides
  // the configured provider (used by the dead-link checker, which snapshots
  // S.provider into a local before the loop). Preserves the exact single-arg
  // `call(prompt)` semantics of every replaced call site.
  function callAI(prompt, opts) {
    opts = opts || {};
    var provider = opts.provider || S().provider;
    var call = PROVIDER_CALLERS[provider];
    if (!call) throw new Error("Unknown AI provider: " + provider);
    return call(prompt, opts);
  }

  // hasAIKey() — the ONE no-key guard. True when the configured (or opts.provider)
  // provider has a usable key, or is "local" (which needs no key). Replaces the ~9
  // `!S.keys[S.provider] && S.provider!=="local"` variants. Call sites keep their
  // own toast/return control flow.
  function hasAIKey(opts) {
    opts = opts || {};
    var s = S();
    var provider = opts.provider || s.provider;
    return provider === "local" || !!s.keys[provider];
  }

  /* ============ pure JSON-array parser ============ */
  // parseJsonArray(text) — strip ```json fences, slice the outermost [ ... ], and
  // JSON.parse it. CONTRACT (preserved from index.html's copies): returns null when
  // no bracket pair is found (callers decide whether that's an error); otherwise
  // returns the parsed value (which may NOT be an Array — callers that require an
  // array check separately, exactly as parseItems did). JSON.parse still throws on
  // malformed JSON inside the brackets — that propagation is preserved.
  function parseJsonArray(text) {
    var t = String(text == null ? "" : text).replace(/```json|```/g, "").trim();
    var a = t.indexOf("["), b = t.lastIndexOf("]");
    if (a === -1 || b === -1) return null;
    return JSON.parse(t.slice(a, b + 1));
  }

  /* ============ out-of-credits classifier ============ */
  // creditsMessage(err, opts) — when an AI call failed because the provider
  // ACCOUNT is out of credits/quota (not a rate limit, bad key, or network
  // blip), return a specific actionable message; otherwise null. Matches the
  // uniform "<Provider> API error <status>: <body>" strings the callers throw.
  // Markers: Anthropic 400 "credit balance is too low"; OpenAI 429
  // "insufficient_quota"/"exceeded your current quota"; OpenRouter/any 402
  // (Payment Required) or "insufficient credits"; Gemini RESOURCE_EXHAUSTED
  // bodies that mention quota/billing (plain RESOURCE_EXHAUSTED alone can be
  // a per-minute rate limit — that one should NOT claim the account is dry).
  var CREDIT_RE = /credit balance is too low|insufficient_quota|exceeded your current quota|insufficient credits|API error 402\b|purchase more credits|billing hard limit/i;
  var GEMINI_QUOTA_RE = /RESOURCE_EXHAUSTED[\s\S]*?(?:daily|billing|free.tier|plan)|(?:daily|billing|free.tier|plan)[\s\S]*?RESOURCE_EXHAUSTED/i;
  function creditsMessage(err, opts) {
    opts = opts || {};
    var msg = String((err && err.message) || err || "");
    if (!CREDIT_RE.test(msg) && !GEMINI_QUOTA_RE.test(msg)) return null;
    var provider = opts.provider;
    if (!provider) { try { provider = S().provider; } catch (e) { provider = ""; } }
    var names = { anthropic: "Anthropic", openai: "OpenAI", gemini: "Google Gemini", groq: "Groq", local: "local/custom" };
    var name = names[provider] || provider || "AI provider";
    return "Your " + name + " account is out of credits — add funds, or switch provider/model in Settings.";
  }

  var IA_AI = {
    configure: configure,
    callAI: callAI,
    hasAIKey: hasAIKey,
    creditsMessage: creditsMessage,
    parseJsonArray: parseJsonArray,
    // exposed for completeness / potential direct use; dispatch normally via callAI
    callAnthropic: callAnthropic, callOpenAI: callOpenAI, callGemini: callGemini,
    callGroq: callGroq, callOpenRouter: callOpenRouter, callLocal: callLocal,
    _hasFetch: hasFetch
  };

  if (typeof module !== "undefined" && module.exports) module.exports = IA_AI;
  if (root) root.IA_AI = IA_AI;
})(typeof self !== "undefined" ? self : this);
