// Card-state predicates (dual browser/Node, route-capture.js pattern).
//
// These pure functions of a card object gate captures, filters, and the
// Get-pictures panel buckets. Byte-equivalent logic is the binding requirement
// (the Phase-1 B8 lesson: predicate drift = bulk actions hitting the wrong
// cards) — every function here is moved verbatim from index.html.
//
//   isFavicon(u)       url is a favicon/touch-icon (not a real picture)
//   isBadImg(u)        no usable picture: empty, favicon, or a known
//                      placeholder/mshots/microlink/webcache proxy url
//   captureable(i)     web-proxy-capturable: has url, not capDone, bad img,
//                      not blocked, NOT a Facebook post
//   captureableFb(i)   FB-only mirror of captureable (login-walled → extension)
//   needsCapture(i)    captureable AND never tried
//   needsRetry(i)      captureable AND tried but still no image
//   needsFbCapture(i)  captureableFb AND never tried
//   fbMiss(i)          a Facebook card that tried and still has no picture
//
// DOM-free, Store-free, global-free. isBadImg/isFavicon take a url string; the
// rest take a card object.
(function (root) {
  "use strict";

  function isFavicon(u) { return !!u && /favicon|apple-touch-icon|icons\.duckduckgo\.com\/ip3|\/s2\/favicons/i.test(u); }
  function isBadImg(u) { return !u || isFavicon(u) || /s0\.wp\.com\/mshots|thum\.io|microlink|webcache\.googleusercontent/i.test(u); }

  function captureable(i) { return i.url && !i.capDone && isBadImg(i.img || "") && !i.blocked && !/facebook\.com|fb\.watch/i.test(i.url); }
  function captureableFb(i) { return i.url && !i.capDone && isBadImg(i.img || "") && !i.blocked && /facebook\.com|fb\.watch/i.test(i.url); }
  function needsCapture(i) { return captureable(i) && !i.lastUpdate && !i.captured; }   // never tried
  function needsRetry(i) { return captureable(i) && (i.lastUpdate || i.captured); }      // tried but still no image
  function needsFbCapture(i) { return captureableFb(i) && !i.lastUpdate && !i.captured; }
  function fbMiss(it) { return it && it.url && /facebook\.com|fb\.watch/i.test(it.url) && isBadImg(it.img || "") && (it.lastResult === "fail" || it.lastUpdate || it.captured); }

  // titleMismatch(suggestedTitle, pageTitle): true when an AI-suggested article's title shares
  // ZERO content words with the page the URL actually serves — the hallucinated-article-ID case
  // (live 2026-07-03: thekitchn.com/how-to-meal-prep-229363 serves "Braided Pesto Bread").
  // Conservative by design: needs >= 2 content words (4+ letters, non-stopword) on BOTH sides,
  // so short/generic titles can never over-drop a real article.
  var TM_STOP = { this: 1, that: 1, with: 1, your: 1, from: 1, have: 1, like: 1, what: 1, when: 1,
    will: 1, they: 1, them: 1, were: 1, been: 1, into: 1, over: 1, more: 1, most: 1, some: 1,
    then: 1, than: 1, "guide": 1, "tips": 1 };
  function _tmTokens(s) {
    var out = {};
    String(s || "").toLowerCase().split(/[^a-z0-9]+/).forEach(function (w) {
      if (w.length >= 4 && !TM_STOP[w]) out[w] = 1;
    });
    return out;
  }
  function titleMismatch(suggested, actual) {
    var a = _tmTokens(suggested), b = _tmTokens(actual);
    var ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length < 2 || bk.length < 2) return false;   // not enough signal — never over-drop
    for (var i = 0; i < ak.length; i++) if (b[ak[i]]) return false;
    return true;
  }

  var api = {
    isFavicon: isFavicon, isBadImg: isBadImg,
    captureable: captureable, captureableFb: captureableFb,
    needsCapture: needsCapture, needsRetry: needsRetry,
    needsFbCapture: needsFbCapture, fbMiss: fbMiss,
    titleMismatch: titleMismatch
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  // Browser: attach the bare names directly to root so index.html's existing
  // calls (isBadImg(u), imported.filter(needsRetry), etc.) keep working.
  if (root) {
    root.isFavicon = isFavicon;
    root.isBadImg = isBadImg;
    root.captureable = captureable;
    root.captureableFb = captureableFb;
    root.needsCapture = needsCapture;
    root.needsRetry = needsRetry;
    root.needsFbCapture = needsFbCapture;
    root.fbMiss = fbMiss;
    root.titleMismatch = titleMismatch;
  }
})(typeof self !== "undefined" ? self : this);
