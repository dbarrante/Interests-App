// core/news.js — free news source for Stumble. Fetches + parses Google News RSS per
// interest keyword. Dependency-free (string/regex parse; the repo avoids XML/native deps).
// Outbound fetches go through core/guardedfetch (timeouts, drain-don't-cancel). The fetch is
// injectable so tests never hit the real network.
"use strict";

var ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'" };
function decodeEntities(s) {
  if (!s) return "";
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-fA-F]+);/g, function (_m, h) { return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_m, d) { return String.fromCodePoint(parseInt(d, 10)); })
    .replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&apos;/g, function (m) { return ENTITIES[m]; })
    .trim();
}
function pick(seg, tag) {
  var m = seg.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "i"));
  return m ? decodeEntities(m[1]) : "";
}
function pickSource(seg) {
  var m = seg.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
  return m ? decodeEntities(m[1]) : "";
}

// Parse Google News RSS into [{title,url,source,ts}]. Pure; no network.
function parseNewsRss(xml) {
  if (!xml || typeof xml !== "string") return [];
  var out = [];
  var blocks = xml.split(/<item[\s>]/i).slice(1);
  for (var i = 0; i < blocks.length; i++) {
    var seg = blocks[i].split(/<\/item>/i)[0];
    var title = pick(seg, "title");
    var url = pick(seg, "link");
    if (!title || !url) continue;
    var source = pickSource(seg);
    var pub = pick(seg, "pubDate");
    var ts = pub ? Date.parse(pub) : NaN;
    if (source && title.length > source.length + 3 && title.slice(-(source.length + 3)) === " - " + source) {
      title = title.slice(0, -(source.length + 3));
    }
    out.push({ title: title, url: url, source: source, ts: isNaN(ts) ? 0 : ts });
  }
  return out;
}

var gf = require("./guardedfetch");

function feedUrl(interest, whenDays) {
  var q = encodeURIComponent(interest + " when:" + whenDays + "d");
  return "https://news.google.com/rss/search?q=" + q + "&hl=en-US&gl=US&ceid=US:en";
}

// Default transport: one guarded GET, body → utf8 string. Fixed host (news.google.com), so
// no SSRF host-check needed; guardedfetch supplies timeout + drain-don't-cancel.
async function defaultFetchImpl(url) {
  var r = await gf.fetchOnceGuarded(url, { ua: gf.UA_LINKCHECK, timeoutMs: 8000, maxBytes: 512 * 1024 });
  if (!r || r.status === 0 || r.error) throw (r && r.error) || new Error("fetch failed");
  return r.buffer ? r.buffer.toString("utf8") : "";
}

// Fetch news for each interest, tag, merge, dedupe (url then lowercased title), sort
// newest-first, cap. One failing feed contributes nothing but never rejects the batch.
async function fetchNews(interests, opts) {
  opts = opts || {};
  var list = (Array.isArray(interests) ? interests : []).map(function (s) { return String(s || "").trim(); }).filter(Boolean);
  if (!list.length) return [];
  var perInterest = opts.perInterest || 10;
  var limit = opts.limit || 40;
  var whenDays = opts.whenDays || 7;
  var concurrency = opts.concurrency || 4;
  var fetchImpl = opts.fetchImpl || defaultFetchImpl;

  var perFeed = await gf.runPool(list, concurrency, async function (interest) {
    try {
      var xml = await fetchImpl(feedUrl(interest, whenDays));
      var items = parseNewsRss(xml).slice(0, perInterest);
      items.forEach(function (it) { it.interest = interest; });
      return items;
    } catch (e) { return []; }   // one feed down ≠ whole batch down
  });

  var merged = [];
  var seenUrl = Object.create(null), seenTitle = Object.create(null);
  perFeed.forEach(function (items) {
    (items || []).forEach(function (it) {
      var uk = String(it.url || "");
      var tk = String(it.title || "").toLowerCase();
      if (!uk || seenUrl[uk] || seenTitle[tk]) return;
      seenUrl[uk] = 1; seenTitle[tk] = 1;
      merged.push(it);
    });
  });
  merged.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
  return merged.slice(0, limit);
}

module.exports = { parseNewsRss: parseNewsRss, decodeEntities: decodeEntities, fetchNews: fetchNews };
