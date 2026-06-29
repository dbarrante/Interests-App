// Server-side "capture missing": fetch a card's page, extract its preview image + title/
// description (extractOg, pure), and download the image (captureMetaChunk, Task 2). Self-
// contained SSRF-guarded fetch with a DRAIN-not-cancel reader (cancelling an undici body
// crashes the main process — see the v1.3.2 fix).
"use strict";

var linkcheck = require("./linkcheck");

function _meta(html, prop) {
  var p = prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  var m = new RegExp('<meta[^>]+(?:property|name)\\s*=\\s*["\']' + p + '["\'][^>]*content\\s*=\\s*["\']([^"\']*)["\']', "i").exec(html);
  if (m) return m[1];
  m = new RegExp('<meta[^>]+content\\s*=\\s*["\']([^"\']*)["\'][^>]*(?:property|name)\\s*=\\s*["\']' + p + '["\']', "i").exec(html);
  return m ? m[1] : "";
}

function extractOg(html) {
  var h = String(html || "");
  if (h.length > 300000) h = h.slice(0, 300000);   // bound the regex scans on a hostile/huge page (og tags live in <head>)
  var image = _meta(h, "og:image") || _meta(h, "og:image:url") || _meta(h, "twitter:image") || _meta(h, "twitter:image:src");
  if (!image) { var li = /<link[^>]+rel\s*=\s*["']image_src["'][^>]*href\s*=\s*["']([^"']+)["']/i.exec(h); if (li) image = li[1]; }
  var title = _meta(h, "og:title");
  if (!title) { var tt = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(h); if (tt) title = tt[1].replace(/\s+/g, " ").trim(); }
  var description = _meta(h, "og:description") || _meta(h, "description");
  return { image: String(image || "").trim(), title: String(title || "").trim(), description: String(description || "").trim() };
}

var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) InterestsApp capture";
var MAX_HOPS = 5;

// Drain a response body to a byte cap WITHOUT cancelling (cancel crashes undici on socket
// end — v1.3.2). Streams via res.body when present; falls back to arrayBuffer/text (test stubs).
async function _drainToBuffer(res, maxBytes) {
  if (res && res.body && typeof res.body.getReader === "function") {
    var reader = res.body.getReader(); var chunks = [], kept = 0;
    while (true) {
      var step = await reader.read(); if (step.done) break;
      if (kept < maxBytes && step.value) {
        var c = Buffer.from(step.value); var room = maxBytes - kept;
        if (c.length > room) c = c.subarray(0, room);
        chunks.push(c); kept += c.length;
      }
    }
    return Buffer.concat(chunks);
  }
  if (res && typeof res.arrayBuffer === "function") { var b = Buffer.from(await res.arrayBuffer()); return b.length > maxBytes ? b.subarray(0, maxBytes) : b; }
  if (res && typeof res.text === "function") { var b2 = Buffer.from(String((await res.text()) || ""), "utf8"); return b2.length > maxBytes ? b2.subarray(0, maxBytes) : b2; }
  return Buffer.alloc(0);
}

async function _fetchHtml(url, opts) {
  opts = opts || {};
  var timeoutMs = Math.min(opts.timeoutMs || 8000, 20000);
  var maxBytes = opts.maxBytes || 256 * 1024;
  if (!(await linkcheck.safeToFetch(url, opts))) return { finalUrl: url, html: "" };
  async function once(target) {
    var ac = new AbortController(); var timer = setTimeout(function () { ac.abort(); }, timeoutMs);
    try {
      var res = await fetch(target, { method: "GET", redirect: "manual", signal: ac.signal, headers: { "User-Agent": UA, "Connection": "close" } });
      var loc = (res.headers && typeof res.headers.get === "function") ? res.headers.get("location") : null;
      var html = ""; try { html = (await _drainToBuffer(res, maxBytes)).toString("utf8"); } catch (e) { html = ""; }
      return { status: res.status, location: loc, html: html, finalUrl: (res.url || target) };
    } catch (e) { return { status: 0, location: null, html: "", finalUrl: target }; }
    finally { clearTimeout(timer); }
  }
  var current = url;
  for (var hop = 0; hop < MAX_HOPS; hop++) {
    var r = await once(current);
    if (!(r.status >= 300 && r.status < 400 && r.location)) return { finalUrl: current, html: r.html };
    var next; try { next = new URL(r.location, current).href; } catch (e) { return { finalUrl: current, html: "" }; }
    if (!(await linkcheck.safeToFetch(next, opts))) return { finalUrl: current, html: "" };
    current = next;
  }
  return { finalUrl: current, html: "" };
}

async function _fetchImageDataUrl(url, opts) {
  opts = opts || {};
  var timeoutMs = Math.min(opts.timeoutMs || 8000, 20000);
  var maxBytes = opts.maxImageBytes || 3 * 1024 * 1024;
  if (!(await linkcheck.safeToFetch(url, opts))) return "";
  var ac = new AbortController(); var timer = setTimeout(function () { ac.abort(); }, timeoutMs);
  try {
    var res = await fetch(url, { method: "GET", redirect: "manual", signal: ac.signal, headers: { "User-Agent": UA, "Connection": "close" } });
    if (!(res.status >= 200 && res.status < 300)) return "";
    var ct = (res.headers && typeof res.headers.get === "function") ? String(res.headers.get("content-type") || "") : "";
    if (!/^image\//i.test(ct)) return "";
    var buf = await _drainToBuffer(res, maxBytes);
    if (!buf.length) return "";
    return "data:" + ct.split(";")[0].trim() + ";base64," + buf.toString("base64");
  } catch (e) { return ""; }
  finally { clearTimeout(timer); }
}

async function captureMetaChunk(items, opts) {
  opts = opts || {};
  var concurrency = Math.min(opts.concurrency || 6, 6);
  var arr = Array.isArray(items) ? items : [];
  var results = new Array(arr.length);
  var next = 0;
  async function worker() {
    while (true) {
      var idx = next++; if (idx >= arr.length) return;
      var it = arr[idx] || {};
      try {
        var url = it.url;
        if (typeof url !== "string" || !linkcheck.isProbableHost(url) || linkcheck.isSkippedHost(url) || !(await linkcheck.safeToFetch(url, opts))) {
          var skipReason = (typeof url === "string" && linkcheck.isSkippedHost(url)) ? "social" : "unreachable";
          results[idx] = { id: it.id, skipped: true, imageDataUrl: "", title: "", description: "", reason: skipReason }; continue;
        }
        var page = await _fetchHtml(url, opts);
        var og = extractOg(page.html);
        var imageDataUrl = "";
        if (og.image) {
          var abs; try { abs = new URL(og.image, page.finalUrl).href; } catch (e) { abs = ""; }
          if (abs) imageDataUrl = await _fetchImageDataUrl(abs, opts);
        }
        var reason = "";
        if (!imageDataUrl) {
          if (!page.html) reason = "unreachable";
          else if (og.image) reason = "image-failed";
          else reason = "no-image";
        }
        results[idx] = { id: it.id, imageDataUrl: imageDataUrl, title: og.title, description: og.description, reason: reason };
      } catch (e) {
        results[idx] = { id: it.id, imageDataUrl: "", title: "", description: "", reason: "unreachable" };
      }
    }
  }
  var pool = []; for (var w = 0; w < Math.min(concurrency, arr.length); w++) pool.push(worker());
  await Promise.all(pool);
  return results;
}

module.exports = { extractOg: extractOg, captureMetaChunk: captureMetaChunk };
