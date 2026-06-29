// Server-side content analysis for "soft-dead" links (pages that return 200 OK but
// whose content is gone). PURE helpers (extract*/classifyContent) + a guarded probe
// (added in Task 2). Conservative: classifyContent only ever returns "suspect" or
// "likely-alive" — the AI tier (browser) makes the final dead/alive call.
"use strict";

function extractTitle(html) {
  var m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""));
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

function extractText(html, maxChars) {
  var max = maxChars || 1500;
  var s = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max) : s;
}

// Lowercase substrings that strongly indicate a removed/missing page. English v1.
var DEAD_PHRASES = [
  "page not found", "page can't be found", "page can't be found",
  "404 not found", "error 404", "not found",
  "no longer available", "no longer exists", "isn't available", "isn't available",
  "is not available", "content unavailable", "this content isn't available", "this content isn't available",
  "doesn't exist", "doesn't exist", "does not exist",
  "has been removed", "been deleted", "this listing has ended",
  "item is no longer", "product is no longer", "sorry, this page",
  "the page you requested", "domain is for sale", "buy this domain"
];

function pathOf(url) {
  try { return new URL(url).pathname || "/"; } catch (e) { return ""; }
}

function hostOf(url) {
  try { return new URL(url).hostname || ""; } catch (e) { return ""; }
}

function classifyContent(info) {
  info = info || {};
  var title = String(info.title || "");
  var text = String(info.text || "");
  var hay = (title + " " + text).toLowerCase();
  var signals = [];

  for (var i = 0; i < DEAD_PHRASES.length; i++) {
    if (hay.indexOf(DEAD_PHRASES[i]) >= 0) { signals.push("phrase:" + DEAD_PHRASES[i]); break; }
  }

  // Redirected from a real (deep) path to the site homepage (same site only).
  if (info.finalUrl) {
    var op = pathOf(info.originalUrl), fp = pathOf(info.finalUrl);
    var oh = hostOf(info.originalUrl), fh = hostOf(info.finalUrl);
    if (oh && oh === fh && op && op.replace(/\/+$/, "").length > 0 && (fp === "/" || fp === "")) signals.push("redirect-home");
  }

  // Almost no readable text.
  if (text.trim().length < 40) signals.push("empty");

  var reasonMap = { "redirect-home": "redirected to homepage", "empty": "page is nearly empty" };
  var reason = "looks alive";
  if (signals.length) {
    var first = signals[0];
    if (first.indexOf("phrase:") === 0) reason = 'page text says "' + first.slice(7) + '"';
    else reason = reasonMap[first] || "looks removed";
  }
  return { verdict: signals.length ? "suspect" : "likely-alive", reason: reason, signals: signals };
}

module.exports = { extractTitle: extractTitle, extractText: extractText, DEAD_PHRASES: DEAD_PHRASES, classifyContent: classifyContent };
