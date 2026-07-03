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

var gf = require("./guardedfetch");
var UA = gf.UA_CAPTURE;
var MAX_HOPS = 5;

async function _fetchHtml(url, opts) {
  opts = opts || {};
  var timeoutMs = Math.min(opts.timeoutMs || 8000, 20000);
  var maxBytes = opts.maxBytes || 256 * 1024;
  if (!(await linkcheck.safeToFetch(url, opts))) return { finalUrl: url, html: "" };
  var walk = await gf.followRedirects(url, {
    maxRedirects: MAX_HOPS, timeoutMs: timeoutMs, maxBytes: maxBytes, ua: UA,
    lookup: opts.lookup, safeToFetch: linkcheck.safeToFetch
  });
  if (walk.stopReason === "terminal") {
    var html = (walk.result.buffer || Buffer.alloc(0)).toString("utf8");
    return { finalUrl: walk.current, html: html };
  }
  // blocked / badloc / maxhops -> no html (matches the old loop's early returns).
  return { finalUrl: walk.current, html: "" };
}

async function _fetchImageDataUrl(url, opts) {
  opts = opts || {};
  var timeoutMs = Math.min(opts.timeoutMs || 8000, 20000);
  var maxBytes = opts.maxImageBytes || 3 * 1024 * 1024;
  if (!(await linkcheck.safeToFetch(url, opts))) return "";
  // Single guarded GET (no redirect follow — as before). Read the body capped+drained.
  var r = await gf.fetchOnceGuarded(url, { method: "GET", timeoutMs: timeoutMs, maxBytes: maxBytes, ua: UA });
  if (r.error) return "";
  if (!(r.status >= 200 && r.status < 300)) return "";
  var res = r.res;
  var ct = (res && res.headers && typeof res.headers.get === "function") ? String(res.headers.get("content-type") || "") : "";
  if (!/^image\//i.test(ct)) return "";
  var buf = r.buffer || Buffer.alloc(0);
  if (!buf.length) return "";
  return "data:" + ct.split(";")[0].trim() + ";base64," + buf.toString("base64");
}

async function captureMetaChunk(items, opts) {
  opts = opts || {};
  var concurrency = Math.min(opts.concurrency || 6, 6);
  var arr = Array.isArray(items) ? items : [];
  return gf.runPool(arr, concurrency, async function (item) {
    var it = item || {};
    try {
      var url = it.url;
      if (typeof url !== "string" || !linkcheck.isProbableHost(url) || linkcheck.isSkippedHost(url) || !(await linkcheck.safeToFetch(url, opts))) {
        var skipReason = (typeof url === "string" && linkcheck.isSkippedHost(url)) ? "social" : "unreachable";
        return { id: it.id, skipped: true, imageDataUrl: "", title: "", description: "", reason: skipReason };
      }
      var page = await _fetchHtml(url, opts);
      var og = extractOg(page.html);
      var imageDataUrl = "";
      var abs = "";
      if (og.image) {
        try { abs = new URL(og.image, page.finalUrl).href; } catch (e) { abs = ""; }
        if (abs) imageDataUrl = await _fetchImageDataUrl(abs, opts);
      }
      var reason = "";
      if (!imageDataUrl) {
        if (!page.html) reason = "unreachable";
        else if (og.image) reason = "image-failed";
        else reason = "no-image";
      }
      // When the image couldn't be downloaded server-side but a valid http(s) og:image URL was found,
      // return it so the renderer can display it directly via <img> (the browser loads it where the
      // server-side fetch was blocked by hotlink/referer protection). http(s) only.
      var imageUrl = (!imageDataUrl && /^https?:\/\//i.test(abs)) ? abs : "";
      return { id: it.id, imageDataUrl: imageDataUrl, imageUrl: imageUrl, title: og.title, description: og.description, reason: reason };
    } catch (e) {
      return { id: it.id, imageDataUrl: "", title: "", description: "", reason: "unreachable" };
    }
  });
}

module.exports = { extractOg: extractOg, captureMetaChunk: captureMetaChunk };
