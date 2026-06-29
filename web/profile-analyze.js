// Pure helpers for "Analyze my library" (dual browser/Node, like web/route-capture.js):
// aggregate cards locally → build one AI prompt → parse the result → merge interests.
// No network, no DOM. buildProfilePrompt takes optional extraSources (the seam a future
// Notion connector plugs into); unused for now.
(function (root) {
  "use strict";

  var STOP = {};
  ("the a an and or of to in for on with how your you my is are was were this that these those best top vs from what why when where who which will can their his her its our about into over under more most just like get make made use using guide tips ideas ways things review reviews new howto").split(/\s+/).forEach(function (w) { STOP[w] = 1; });

  function topN(map, n) {
    var arr = Object.keys(map).map(function (k) { return { name: k, count: map[k] }; });
    arr.sort(function (a, b) { return b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
    return arr.slice(0, n);
  }
  function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch (e) { return ""; } }

  function summarizeLibrary(cards, opts) {
    opts = opts || {};
    var list = Array.isArray(cards) ? cards : [];
    var cat = {}, dom = {}, kw = {}, tag = {};
    for (var i = 0; i < list.length; i++) {
      var c = list[i]; if (!c) continue;
      var category = (typeof c.category === "string") ? c.category.trim() : "";
      if (category) cat[category] = (cat[category] || 0) + 1;
      var h = hostOf(c.url); if (h) dom[h] = (dom[h] || 0) + 1;
      var title = (typeof c.title === "string") ? c.title.toLowerCase() : "";
      var toks = title.split(/[^a-z0-9]+/);
      for (var j = 0; j < toks.length; j++) {
        var w = toks[j];
        if (w.length >= 3 && !STOP[w] && !/^\d+$/.test(w)) kw[w] = (kw[w] || 0) + 1;
      }
      if (Array.isArray(c.tags)) for (var k = 0; k < c.tags.length; k++) {
        var tg = (typeof c.tags[k] === "string") ? c.tags[k].trim() : "";
        if (tg) tag[tg] = (tag[tg] || 0) + 1;
      }
    }
    return {
      total: list.length,
      categories: topN(cat, opts.maxCategories || 40),
      domains: topN(dom, opts.maxDomains || 40),
      keywords: topN(kw, opts.maxKeywords || 60),
      tags: topN(tag, opts.maxTags || 40)
    };
  }

  function _fmt(arr) { return (arr || []).map(function (x) { return x.name + " (" + x.count + ")"; }).join(", "); }

  function buildProfilePrompt(summary, profile, extraSources) {
    summary = summary || {}; profile = profile || {};
    extraSources = Array.isArray(extraSources) ? extraSources : [];
    var lines = [
      "Analyze this person's saved-content library to infer what they're into, then propose an interest profile.",
      "",
      "LIBRARY SUMMARY (aggregated from " + (summary.total || 0) + " saved items):",
      "Top categories: " + _fmt(summary.categories),
      "Top sites: " + _fmt(summary.domains),
      "Common title keywords: " + _fmt(summary.keywords),
      "Top tags: " + _fmt(summary.tags)
    ];
    for (var i = 0; i < extraSources.length; i++) {
      var s = extraSources[i] || {};
      lines.push("", "ADDITIONAL SOURCE — " + (s.label || "source") + ":", String(s.text || "").slice(0, 4000));
    }
    lines.push(
      "",
      "Their CURRENT profile (build on it, do not just repeat it):",
      "About: " + (profile.about || "(empty)"),
      "Interests: " + (profile.interests || "(empty)"),
      "",
      'Return ONLY a JSON object: {"interests": [15-25 short topic strings, 2-5 words each, feed-able for finding articles/projects, drawn PRIMARILY from the library above with a FEW clearly-adjacent stretch topics, no duplicates], "about": "a 2-4 sentence first-person about-me describing their taste"}'
    );
    return lines.join("\n");
  }

  function parseProfileResult(text) {
    var s = String(text == null ? "" : text);
    var m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        var o = JSON.parse(m[0]);
        var interests = Array.isArray(o.interests)
          ? o.interests.filter(function (x) { return typeof x === "string" && x.trim(); }).map(function (x) { return x.trim(); })
          : [];
        var about = (typeof o.about === "string") ? o.about.trim() : "";
        return { interests: interests, about: about };
      } catch (e) { /* fall through */ }
    }
    return { interests: [], about: "" };
  }

  function mergeInterests(existingCsv, picked) {
    var existing = String(existingCsv == null ? "" : existingCsv).split(",").map(function (x) { return x.trim(); }).filter(Boolean);
    var seen = {}; existing.forEach(function (x) { seen[x.toLowerCase()] = 1; });
    var out = existing.slice();
    (Array.isArray(picked) ? picked : []).forEach(function (pp) {
      var v = String(pp == null ? "" : pp).trim(); if (!v) return;
      if (!seen[v.toLowerCase()]) { seen[v.toLowerCase()] = 1; out.push(v); }
    });
    return out.join(", ");
  }

  var api = { summarizeLibrary: summarizeLibrary, buildProfilePrompt: buildProfilePrompt, parseProfileResult: parseProfileResult, mergeInterests: mergeInterests };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) { root.summarizeLibrary = summarizeLibrary; root.buildProfilePrompt = buildProfilePrompt; root.parseProfileResult = parseProfileResult; root.mergeInterests = mergeInterests; }
})(typeof self !== "undefined" ? self : this);
