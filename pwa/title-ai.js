// Pure helpers for AI card-title generation (dual browser/Node, like
// web/deadcheck-ai.js). The AI call itself reuses index.html's provider
// dispatch (IA_AI/callAI); these only build the prompt and parse the reply.
(function (root) {
  "use strict";

  // buildTitlePrompt({url, domain, description, avoidTitles}) — asks for
  // exactly one title, <=8 words, grounded in whatever context is available.
  // avoidTitles (0+ strings) are titles already taken in the library — only
  // populated on a uniqueness-collision retry (see generateUniqueTitle in
  // index.html), so the common case (first attempt) never mentions them.
  function buildTitlePrompt(info) {
    info = info || {};
    var url = String(info.url || "");
    var domain = String(info.domain || "");
    var description = String(info.description || "").slice(0, 1000);
    var avoidTitles = Array.isArray(info.avoidTitles) ? info.avoidTitles.filter(Boolean) : [];
    var lines = [
      "Write ONE short, descriptive, specific title for this saved web page, 8 words or fewer.",
      "No platform names (Facebook/Instagram/Pinterest/etc), no generic filler like \"Post\" or \"Video\" — describe the actual subject.",
      "",
      "URL: " + url,
      "Domain: " + domain,
      "Description: " + description
    ];
    if (avoidTitles.length) {
      lines.push("");
      lines.push("Do not reuse any of these exact titles (already used elsewhere in the library):");
      avoidTitles.forEach(function (a) { lines.push("- " + String(a)); });
    }
    lines.push("");
    lines.push("Return ONLY the title, no quotes, no explanation.");
    return lines.join("\n");
  }

  // parseTitleReply(text) — extract a single-line title: first line only,
  // strip a leading "Title:" label and surrounding quotes/whitespace, then
  // hard-truncate to 8 words as a backstop (the model's own instruction-
  // following can't be trusted to enforce the word limit). Returns null for
  // empty/whitespace-only input.
  function parseTitleReply(text) {
    var s = String(text == null ? "" : text).split("\n")[0];
    s = s.replace(/^\s*title\s*:\s*/i, "");
    s = s.replace(/^["'\s]+|["'\s]+$/g, "");
    if (!s) return null;
    var words = s.split(/\s+/);
    if (words.length > 8) s = words.slice(0, 8).join(" ");
    return s;
  }

  var api = { buildTitlePrompt: buildTitlePrompt, parseTitleReply: parseTitleReply };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) { root.buildTitlePrompt = buildTitlePrompt; root.parseTitleReply = parseTitleReply; }
})(typeof self !== "undefined" ? self : this);
