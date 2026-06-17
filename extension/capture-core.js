// Interests capture ENGINE — shared logic for every in-page "Save" mirror.
// Per-platform specifics live in capture-configs.js, which defines the global
// window.INTERESTS_CAPTURE_CONFIGS (loaded before this file). The engine picks
// the config whose match(host) is true, wires one capture-phase click listener,
// and on a qualifying Save: find the post -> (optional hover-coax) -> wait for
// the native menu to close -> measure the post rect -> send clipSocialPost.
//
// Adding/tuning a platform = edit a config object; the engine never changes.
(function () {
  "use strict";

  const TIME_RE = /^\s*(just now|\d+\s*(s|m|h|d|w|hr|hrs|min|mins|y)\b|yesterday|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}|\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/i;
  const DEFAULT_CDN = /scontent|fbcdn|cdninstagram|pinimg/;

  function txtOf(el) { return ((el && (el.innerText || el.getAttribute("aria-label"))) || "").trim(); }
  function hrefOf(a) { return (a && (a.href || a.getAttribute("href"))) || ""; }
  function rectOf(el) {
    if (!el || !el.getBoundingClientRect) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return null;
    return { x: r.left, y: r.top, w: r.width, h: r.height, dpr: window.devicePixelRatio || 1 };
  }
  // largest CDN image inside a root (skips tiny avatars/icons). Used as the
  // image fallback when a region crop fails.
  function largestImg(root, cdnRe) {
    const re = cdnRe || DEFAULT_CDN;
    let best = "", bestArea = 0;
    try {
      Array.prototype.forEach.call((root || document).querySelectorAll("img"), function (im) {
        const s = im.currentSrc || im.src || "";
        if (!re.test(s)) return;
        const area = (im.naturalWidth || im.width || 0) * (im.naturalHeight || im.height || 0);
        if (area > bestArea) { bestArea = area; best = s; }
      });
    } catch (e) {}
    return bestArea >= 40000 ? best : "";
  }
  // some sites (Facebook) lazy-fill a timestamp link's permalink href on hover
  function hoverTimestamps(post) {
    if (!post) return;
    try {
      const links = post.querySelectorAll('a[role="link"], a[href]');
      let n = 0;
      for (let i = 0; i < links.length && n < 6; i++) {
        const tx = (links[i].innerText || "").trim();
        if (tx && tx.length <= 24 && TIME_RE.test(tx)) {
          ["mouseover", "mouseenter", "pointerover", "focus"].forEach(function (ev) {
            try { links[i].dispatchEvent(new MouseEvent(ev, { bubbles: true })); } catch (e) {}
          });
          n++;
        }
      }
    } catch (e) {}
  }
  // innermost article ancestor — a single post, not a multi-post container
  function smallestArticleAt(el) {
    const a = el && el.closest && el.closest('[role="article"]');
    if (!a) return null;
    const inner = a.querySelector('[role="article"]');
    if (inner && inner.contains(el)) return inner;
    return a;
  }

  const U = { TIME_RE, txtOf, hrefOf, rectOf, largestImg, hoverTimestamps, smallestArticleAt };

  // pick the config for this site
  const host = location.hostname;
  const configs = window.INTERESTS_CAPTURE_CONFIGS || [];
  let cfg = null;
  for (let i = 0; i < configs.length; i++) {
    try { if (configs[i].match(host)) { cfg = configs[i]; break; } } catch (e) {}
  }
  if (!cfg) return;
  try { if (cfg.init) cfg.init(U); } catch (e) {}

  let lastClipTs = 0;
  document.addEventListener("click", function (e) {
    try {
      const trigger = cfg.saveTrigger(e, U);   // returns the Save control, or null
      if (!trigger) return;
      const now = Date.now();
      if (now - lastClipTs < 2500) return;       // debounce
      lastClipTs = now;

      const post = cfg.findPost ? cfg.findPost(trigger, U) : null;
      if (cfg.hoverTimestamps) U.hoverTimestamps(post);

      setTimeout(function () {
        try {
          const ex = (post && cfg.extract) ? cfg.extract(post, U) : { author: "", text: "" };
          const author = (ex && ex.author) || "";
          const perma = (post && cfg.findPermalink) ? cfg.findPermalink(post, U) : "";
          const url = (cfg.isSpecificUrl && cfg.isSpecificUrl(location.href)) ? location.href : (perma || location.href);
          const image = U.largestImg(post, cfg.imageCdn) || U.largestImg(document, cfg.imageCdn);
          // include the post rect for region OR photo strategies (photo uses it
          // only as a fallback for text-only posts with no photo)
          const rect = (cfg.image !== "screenshot") ? U.rectOf((post && post.closest && post.closest('[role="dialog"]')) || post) : null;
          const title = cfg.title ? cfg.title(author) : (author || "Saved post");
          const info = { url: url, title: title, author: author, text: (ex && ex.text) || "", image: image, rect: rect, strategy: cfg.image, pageUrl: location.href };
          console.log("[Interests] " + cfg.id + " save | author=", JSON.stringify(author),
            "| url=", url, "| rect=", rect ? (Math.round(rect.w) + "x" + Math.round(rect.h)) : "none");
          chrome.runtime.sendMessage({ action: "clipSocialPost", data: info }, function () {
            if (chrome.runtime.lastError) { /* SW asleep / reloading — ignore */ }
          });
        } catch (err) { /* never break the page */ }
      }, cfg.preCaptureDelayMs || 300);
    } catch (err) { /* never break the page */ }
  }, true);

  console.log("[Interests] capture engine active (" + cfg.id + ")");
})();
