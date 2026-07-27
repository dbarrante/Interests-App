/* web/imagehash.js — perceptual image hashing for duplicate detection.
   Pure functions only (no DOM), so tests can require() them in Node; the
   browser attaches them as IA_IMGHASH. Same dual-export shape as web/storage.js.

   dHash, not aHash or pHash: aHash groups anything flat or similarly-branded
   (Pinterest templates collide constantly), and pHash's DCT buys accuracy this
   use case doesn't need. dHash asks one question per pixel pair — "is this one
   brighter than its right-hand neighbour?" — which survives rescaling and
   re-compression while still separating different pictures. */
(function (root) {
  "use strict";

  var HASH_W = 9, HASH_H = 8;   // 9 wide so each row yields 8 comparisons -> 64 bits

  // STRICT by design: the outcome of a match is a deletion prompt, so the cost
  // of too loose (a wrongly grouped card) is worse than too strict (a missed
  // duplicate). Measure before changing: hash the real library, print the
  // distance distribution for known-duplicate and known-distinct pairs, and
  // record the numbers here.
  var MAX_DISTANCE = 5;

  function dhashFromGrey(grey, w, h) {
    w = w || HASH_W; h = h || HASH_H;
    var bits = "";
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w - 1; x++) {
        bits += (grey[y * w + x] > grey[y * w + x + 1]) ? "1" : "0";
      }
    }
    var hex = "";
    for (var i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex;
  }

  var HEX = /^[0-9a-f]+$/;
  function hamming(a, b) {
    // Junk in must NOT read as "identical" — that would group every unhashable
    // card into one deletion pile.
    if (typeof a !== "string" || typeof b !== "string") return 64;
    if (a.length !== 16 || b.length !== 16) return 64;
    if (!HEX.test(a) || !HEX.test(b)) return 64;
    var d = 0;
    for (var i = 0; i < 16; i++) {
      var x = (parseInt(a[i], 16) ^ parseInt(b[i], 16)) & 15;
      while (x) { d += x & 1; x >>= 1; }
    }
    return d;
  }

  var api = { dhashFromGrey: dhashFromGrey, hamming: hamming, HASH_W: HASH_W, HASH_H: HASH_H, MAX_DISTANCE: MAX_DISTANCE };
  root.IA_IMGHASH = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : this);
