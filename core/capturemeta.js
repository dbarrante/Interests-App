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

module.exports = { extractOg: extractOg };
