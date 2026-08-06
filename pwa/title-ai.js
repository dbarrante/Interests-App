// Pure helpers for AI card-title generation (dual browser/Node, like
// web/deadcheck-ai.js). The AI call itself reuses index.html's provider
// dispatch (IA_AI/callAI); these only build the prompt and parse the reply.
(function (root) {
  "use strict";

  // buildTitlePrompt({url, domain, description, avoidTitles, hasImage, ocr, collection}) — asks for
  // exactly one title, <=8 words, grounded in whatever context is available.
  // avoidTitles (0+ strings) are titles already taken in the library — only
  // populated on a uniqueness-collision retry (see generateUniqueTitle in
  // index.html), so the common case (first attempt) never mentions them.
  // hasImage, ocr, collection are optional context flags for richer prompting.
  function buildTitlePrompt(info) {
    info = info || {};
    var url = String(info.url || "");
    var domain = String(info.domain || "");
    var description = String(info.description || "").slice(0, 1000);
    var avoidTitles = Array.isArray(info.avoidTitles) ? info.avoidTitles.filter(Boolean) : [];
    var hasImage = !!info.hasImage;
    var ocr = !!info.ocr;
    var collection = String(info.collection || "");
    var lines = [
      "Write ONE short, descriptive, specific title for this saved web page, 8 words or fewer.",
      "No platform names (Facebook/Instagram/Pinterest/etc), no generic filler like \"Post\" or \"Video\" — describe the actual subject.",
      "Do not write generic stock-photo/blog-headline captions that could apply to many different images in the same category (e.g. \"Stylish Indoor Plant Decor for Modern Homes\", \"Cozy Living Room Ideas for Every Season\"). If the image only shows a generic scene with nothing specific to identify (no distinct object, product, place, person, or text), say so plainly and briefly rather than inventing a decorative-sounding title."
    ];
    if (hasImage) {
      lines.push("An image of the actual saved content is attached — base the title on what's shown. If the image contains legible text (e.g. a quote), use that as the primary basis. Otherwise describe what's depicted, specifically — not the general category it belongs to.");
    }
    if (ocr) {
      lines.push("The description below was extracted via OCR from an image and may contain minor recognition errors — treat it as approximate, not verbatim-perfect.");
    }
    lines.push("", "URL: " + url, "Domain: " + domain, "Description: " + description);
    if (collection) {
      lines.push("This was saved from the user's '" + collection + "' collection (context only — do not assume this describes the specific content).");
    }
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

  // extractWeakContext(card) — the ONE genuine signal inside otherwise-inert
  // capture-time boilerplate: the user's own Facebook collection/list name.
  // Never enough alone for a confident title (see generateUniqueTitle's Tier
  // 3 in index.html) — only ever used as supplementary AI-prompt context, or
  // as the sole input to the deterministic (non-AI) fallback label.
  var FB_COLLECTION_RE = /^From your '(.+)' Facebook collection$/;
  var FB_NON_PAGE_SEGMENTS = { "reel": 1, "permalink.php": 1, "photo.php": 1, "watch": 1, "groups": 1, "story.php": 1, "share": 1, "p": 1 };
  function extractWeakContext(card) {
    var desc = String((card && (card.desc || card.benefit)) || "");
    var m = FB_COLLECTION_RE.exec(desc.trim());
    var collection = m ? m[1] : "";
    var pageSlug = "";
    try {
      var u = new URL(String((card && card.url) || ""));
      if (/(^|\.)facebook\.com$/i.test(u.hostname) || /(^|\.)fb\.watch$/i.test(u.hostname)) {
        var seg = (u.pathname.split("/").filter(Boolean)[0] || "");
        if (seg && !FB_NON_PAGE_SEGMENTS[seg.toLowerCase()]) pageSlug = seg;
      }
    } catch (e) {}
    return { collection: collection, pageSlug: pageSlug };
  }

  // composeFallbackTitle(collection) — Tier 3's deterministic, non-AI label
  // (generateUniqueTitle in index.html/pwa). Padding text is fixed so even a
  // 1-character collection name clears isGenericTitle()'s 25-char floor;
  // callers still re-check isGenericTitle() themselves as a backstop.
  function composeFallbackTitle(collection) {
    return String(collection || "").trim() + " — saved from a Facebook collection";
  }

  // extractHashtags(rawTitle) — pull #word tokens out of an AI-generated
  // title; returns { title, tags } where title has the tokens (and any
  // resulting double-spaces) removed, and tags is the lowercase, deduped
  // token list, UNCLEANED — bad-pattern rejection and canonicalization onto
  // existing vocabulary is index.html's job (applyGeneratedTitle), since
  // this module has no access to the library's tag state.
  function extractHashtags(rawTitle) {
    var text = String(rawTitle == null ? "" : rawTitle);
    var found = text.match(/#(\w+)/g) || [];
    var title = text.replace(/#\w+/g, "").replace(/\s{2,}/g, " ").trim();
    var seen = {}, tags = [];
    found.forEach(function (h) {
      var tag = h.slice(1).toLowerCase();
      if (!tag || tag.length > 40 || seen[tag]) return;
      seen[tag] = 1;
      tags.push(tag);
    });
    return { title: title, tags: tags };
  }

  var api = { buildTitlePrompt: buildTitlePrompt, parseTitleReply: parseTitleReply, extractWeakContext: extractWeakContext, composeFallbackTitle: composeFallbackTitle, extractHashtags: extractHashtags };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) { root.buildTitlePrompt = buildTitlePrompt; root.parseTitleReply = parseTitleReply; root.extractWeakContext = extractWeakContext; root.composeFallbackTitle = composeFallbackTitle; root.extractHashtags = extractHashtags; }
})(typeof self !== "undefined" ? self : this);
