// Server-side content analysis for "soft-dead" links (pages that return 200 OK but
// whose content is gone). PURE helpers (extract*/classifyContent) + a guarded probe
// (added in Task 2). Conservative: classifyContent only ever returns "suspect" or
// "likely-alive" — the AI tier (browser) makes the final dead/alive call.
"use strict";

var linkcheck = require("./linkcheck");

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

var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) InterestsApp link-check";
var MAX_HOPS = 5;

// Read a response body but stop at maxBytes so a hostile/huge page never fully
// materializes in memory. Streams via res.body when available; falls back to text()
// (used by test stubs that don't provide a stream).
async function readCapped(res, maxBytes) {
  if (res && res.body && typeof res.body.getReader === "function") {
    var reader = res.body.getReader();
    var chunks = [], received = 0;
    while (received < maxBytes) {
      var step = await reader.read();
      if (step.done) break;
      var chunk = Buffer.from(step.value);
      chunks.push(chunk);
      received += chunk.length;
    }
    try { await reader.cancel(); } catch (e) {}
    var buf = Buffer.concat(chunks);
    if (buf.length > maxBytes) buf = buf.subarray(0, maxBytes);
    return buf.toString("utf8");
  }
  if (res && typeof res.text === "function") {
    var full = await res.text();
    return (typeof full === "string" && full.length > maxBytes) ? full.slice(0, maxBytes) : (full || "");
  }
  return "";
}

// GET a page's content with the SSRF guard applied to every hop. Redirects followed
// manually so each next host is re-validated (a public url that 30x->internal is NOT
// followed). Body read is capped at maxBytes. Never throws — returns best-effort info.
async function fetchContent(url, opts) {
  opts = opts || {};
  var timeoutMs = Math.min(opts.timeoutMs || 8000, 20000);
  var maxBytes = opts.maxBytes || 256 * 1024;
  if (!linkcheck.isProbableHost(url)) return { finalUrl: url, status: 0, title: "", snippet: "" };

  async function getOnce(target) {
    var ac = new AbortController();
    var timer = setTimeout(function () { ac.abort(); }, timeoutMs);
    try {
      var res = await fetch(target, { method: "GET", redirect: "manual", signal: ac.signal, headers: { "User-Agent": UA, "Connection": "close" } });
      var loc = (res.headers && typeof res.headers.get === "function") ? res.headers.get("location") : null;
      var body = "";
      try { body = await readCapped(res, maxBytes); } catch (e) { body = ""; }
      return { status: res.status, location: loc, body: body, finalUrl: (res.url || target) };
    } catch (e) {
      return { status: 0, location: null, body: "", finalUrl: target };
    } finally {
      clearTimeout(timer);
    }
  }

  var current = url;
  for (var hop = 0; hop < MAX_HOPS; hop++) {
    var r = await getOnce(current);
    var isRedirect = r.status >= 300 && r.status < 400 && r.location;
    if (!isRedirect) {
      return { finalUrl: current, status: r.status, title: extractTitle(r.body), snippet: extractText(r.body) };
    }
    var nextUrl;
    try { nextUrl = new URL(r.location, current).href; } catch (e) { return { finalUrl: current, status: r.status, title: "", snippet: "" }; }
    if (!linkcheck.isProbableHost(nextUrl)) return { finalUrl: current, status: r.status, title: "", snippet: "" };
    current = nextUrl;
  }
  return { finalUrl: current, status: 0, title: "", snippet: "" };
}

// Probe a chunk of {id,url} with a concurrency cap. Social/SSRF/non-probable urls are
// reported {verdict:"skipped"} WITHOUT any network request.
async function checkContentChunk(items, opts) {
  opts = opts || {};
  var concurrency = Math.min(opts.concurrency || 8, 8);
  var arr = Array.isArray(items) ? items : [];
  var results = new Array(arr.length);
  var next = 0;
  async function worker() {
    while (true) {
      var idx = next++;
      if (idx >= arr.length) return;
      var it = arr[idx] || {};
      var url = it.url;
      if (typeof url !== "string" || !linkcheck.isProbableHost(url) || linkcheck.isSkippedHost(url)) {
        results[idx] = { id: it.id, status: "skipped", verdict: "skipped", reason: "skipped", finalUrl: url || "", title: "", snippet: "" };
        continue;
      }
      var c = await fetchContent(url, opts);
      var cls = classifyContent({ originalUrl: url, finalUrl: c.finalUrl, status: c.status, title: c.title, text: c.snippet });
      results[idx] = { id: it.id, finalUrl: c.finalUrl, status: c.status, title: c.title, snippet: c.snippet, verdict: cls.verdict, reason: cls.reason };
    }
  }
  var pool = [];
  for (var w = 0; w < Math.min(concurrency, arr.length); w++) pool.push(worker());
  await Promise.all(pool);
  return results;
}

module.exports = { extractTitle: extractTitle, extractText: extractText, DEAD_PHRASES: DEAD_PHRASES, classifyContent: classifyContent, fetchContent: fetchContent, checkContentChunk: checkContentChunk };
