// Server-side content analysis for "soft-dead" links (pages that return 200 OK but
// whose content is gone). PURE helpers (extract*/classifyContent) + a guarded probe
// (added in Task 2). Conservative: classifyContent only ever returns "suspect" or
// "likely-alive" — the AI tier (browser) makes the final dead/alive call.
"use strict";

var linkcheck = require("./linkcheck");
var capturemeta = require("./capturemeta");   // extractOg only (pure); no require cycle — capturemeta needs linkcheck/guardedfetch, never this module

function extractTitle(html) {
  var m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""));
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

function extractText(html, maxChars) {
  // Default raised 1500 -> 4000: content-stuffed custom 404 pages (nav bars, shop promos)
  // can push the "page not found" wording past 1500 chars (real case: makezine.com).
  var max = maxChars || 4000;
  var s = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max) : s;
}

// Lowercase substrings that strongly indicate a removed/missing page. English v1.
// Apostrophes are STRAIGHT (') here; classifyContent normalizes curly apostrophes in
// the page text to straight before matching, so both "isn't" and "isn’t" hit.
var DEAD_PHRASES = [
  "page not found", "page can't be found",
  "404 not found", "error 404", "not found",
  "no longer available", "no longer exists", "isn't available",
  "is not available", "content unavailable", "this content isn't available",
  "doesn't exist", "does not exist",
  "has been removed", "been deleted", "this listing has ended",
  "item is no longer", "product is no longer", "sorry, this page",
  "the page you requested", "domain is for sale", "buy this domain",
  // Creative not-found titles (Star Wars-style). Real case: makezine.com's HTTP-200 404
  // titled "This is not the page you're looking for..." slipped the list (2026-07-03).
  "not the page you're looking for", "not the page you are looking for",
  "sorry page not found", "page cannot be found", "page could not be found"
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
  // Normalize curly apostrophes (U+2018/U+2019) to straight so dead phrases match
  // regardless of which apostrophe a page uses. \u escapes keep the source ASCII-only.
  var hay = (title + " " + text).toLowerCase().replace(/[‘’]/g, "'");
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

var gf = require("./guardedfetch");
var UA = gf.UA_LINKCHECK;
var MAX_HOPS = 5;

// Read a response body but stop at maxBytes so a hostile/huge page never fully materializes
// in memory. DRAINS rather than cancels (the undici teardown-crash workaround — see
// guardedfetch.drainCapped). Kept as a thin string wrapper so the module's contract and any
// callers are unchanged. Streams via res.body; falls back to arrayBuffer()/text() for stubs.
async function readCapped(res, maxBytes) {
  return (await gf.drainCapped(res, maxBytes)).toString("utf8");
}

// GET a page's content with the SSRF guard applied to every hop. Redirects followed
// manually so each next host is re-validated (a public url that 30x->internal is NOT
// followed). Body read is capped at maxBytes. Never throws — returns best-effort info.
async function fetchContent(url, opts) {
  opts = opts || {};
  var timeoutMs = Math.min(opts.timeoutMs || 8000, 20000);
  var maxBytes = opts.maxBytes || 256 * 1024;
  // SSRF: string guard + DNS-rebinding guard (a public-looking name that resolves private).
  if (!(await linkcheck.safeToFetch(url, opts))) return { finalUrl: url, status: 0, title: "", snippet: "" };

  var walk = await gf.followRedirects(url, {
    maxRedirects: MAX_HOPS, timeoutMs: timeoutMs, maxBytes: maxBytes, ua: UA,
    lookup: opts.lookup, safeToFetch: linkcheck.safeToFetch
  });
  if (walk.stopReason === "terminal") {
    var r = walk.result;
    var body = (r.buffer || Buffer.alloc(0)).toString("utf8");
    // og:image from the page we already read — callers (the feed) use it as the card's
    // REAL image instead of a third-party screenshot proxy. Resolved absolute against the
    // final URL (og content is often a relative path); http(s) only; "" when absent.
    var ogImage = "";
    try {
      var og = capturemeta.extractOg(body).image;
      if (og) { var abs = new URL(og, walk.current).href; if (/^https?:\/\//i.test(abs)) ogImage = abs; }
    } catch (e) { ogImage = ""; }
    return { finalUrl: walk.current, status: r.status, title: extractTitle(body), snippet: extractText(body), ogImage: ogImage };
  }
  // blocked / badloc -> report the last 3xx status with no content; maxhops -> status 0.
  if (walk.stopReason === "maxhops") return { finalUrl: walk.current, status: 0, title: "", snippet: "", ogImage: "" };
  return { finalUrl: walk.current, status: walk.result.status, title: "", snippet: "", ogImage: "" };
}

// Probe a chunk of {id,url} with a concurrency cap. Social/SSRF/non-probable urls are
// reported {verdict:"skipped"} WITHOUT any network request.
async function checkContentChunk(items, opts) {
  opts = opts || {};
  var concurrency = Math.min(opts.concurrency || 8, 8);
  var arr = Array.isArray(items) ? items : [];
  return gf.runPool(arr, concurrency, async function (item) {
    var it = item || {};
    var url = it.url;
    if (typeof url !== "string" || linkcheck.isSkippedHost(url) || !(await linkcheck.safeToFetch(url, opts))) {
      return { id: it.id, status: "skipped", verdict: "skipped", reason: "skipped", finalUrl: url || "", title: "", snippet: "", ogImage: "" };
    }
    var c = await fetchContent(url, opts);
    var cls = classifyContent({ originalUrl: url, finalUrl: c.finalUrl, status: c.status, title: c.title, text: c.snippet });
    // Forward `signals` so a caller (e.g. the feed's soft-404 filter) can act on the
    // STRONG signals (dead phrase / redirect-home) without dropping weak "empty"-only pages,
    // and `ogImage` so the feed can show the article's real image instead of a screenshot proxy.
    return { id: it.id, finalUrl: c.finalUrl, status: c.status, title: c.title, snippet: c.snippet, verdict: cls.verdict, reason: cls.reason, signals: cls.signals, ogImage: c.ogImage || "" };
  });
}

module.exports = { extractTitle: extractTitle, extractText: extractText, DEAD_PHRASES: DEAD_PHRASES, classifyContent: classifyContent, fetchContent: fetchContent, checkContentChunk: checkContentChunk };
