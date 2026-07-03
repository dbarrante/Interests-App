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

  var api = {
    isFavicon: isFavicon, isBadImg: isBadImg,
    captureable: captureable, captureableFb: captureableFb,
    needsCapture: needsCapture, needsRetry: needsRetry,
    needsFbCapture: needsFbCapture, fbMiss: fbMiss
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
  }
})(typeof self !== "undefined" ? self : this);
