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
    if (bestArea >= 40000) return best;
    // video posts have no still <img> — use the <video> poster thumbnail if any
    try {
      const v = (root || document).querySelector("video[poster]");
      if (v && re.test(v.poster || "")) return v.poster;
    } catch (e) {}
    return "";
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

      let post = cfg.findPost ? cfg.findPost(trigger, U) : null;
      if (cfg.hoverTimestamps) U.hoverTimestamps(post);

      const doCapture = function () {
        try {
          // FB's virtualized feed can detach the post node during the delay — re-resolve it
          if (post && post.isConnected === false && cfg.findPost) { const re = cfg.findPost(trigger, U); if (re) post = re; }
          const ex = (post && cfg.extract) ? cfg.extract(post, U) : { author: "", text: "" };
          const author = (ex && ex.author) || "";
          const perma = (post && cfg.findPermalink) ? cfg.findPermalink(post, U) : "";
          const url = (cfg.isSpecificUrl && cfg.isSpecificUrl(location.href)) ? location.href : (perma || location.href);
          // The post's OWN photo. Only widen to a document-wide image search on a
          // specific post/photo PAGE (the whole document is the post there) — never
          // on the feed, where it would grab an unrelated post's image.
          let image = U.largestImg(post, cfg.imageCdn);
          if (!image && cfg.isSpecificUrl && cfg.isSpecificUrl(location.href)) image = U.largestImg(document, cfg.imageCdn);
          // post rect for region/photo strategies (photo uses it as the fallback
          // for text/video posts that have no still photo)
          const rect = (cfg.image !== "screenshot") ? U.rectOf((post && post.closest && post.closest('[role="dialog"]')) || post) : null;
          const title = cfg.title ? cfg.title(author) : (author || "Saved post");
          const info = { url: url, title: title, author: author, text: (ex && ex.text) || "", image: image, rect: rect, strategy: cfg.image, pageUrl: location.href };
          console.log("[Interests] " + cfg.id + " save | author=", JSON.stringify(author),
            "| url=", url, "| img=", image ? "yes" : "no", "| rect=", rect ? (Math.round(rect.w) + "x" + Math.round(rect.h)) : "none");
          // the extension may have been reloaded while this tab kept the old
          // content script — bail quietly instead of throwing "context invalidated"
          if (!chrome.runtime || !chrome.runtime.id) { console.warn("[Interests] extension reloaded — refresh this tab to re-enable Save mirror"); return; }
          chrome.runtime.sendMessage({ action: "clipSocialPost", data: info }, function () {
            if (chrome.runtime && chrome.runtime.lastError) { console.warn("[Interests] clip send failed:", chrome.runtime.lastError.message); lastClipTs = 0; }
          });
        } catch (err) { /* never break the page */ }
      };
      // poll a predicate every `step`ms until true or `timeout`, then run cb
      const pollUntil = function (pred, timeout, step, cb) {
        let waited = 0;
        (function loop() {
          let ok = false; try { ok = pred(); } catch (e) {}
          if (ok || waited >= timeout) { cb(); return; }
          waited += step; setTimeout(loop, step);
        })();
      };
      setTimeout(function () {
        // If the post has its own still photo, the floating "Save To" dialog is
        // irrelevant (we read the image, not a screenshot) — capture immediately.
        let hasPhoto = false; try { hasPhoto = !!(post && U.largestImg(post, cfg.imageCdn)); } catch (e) {}
        if (hasPhoto || !cfg.overlayPresent) { doCapture(); return; }
        // No still photo -> we must crop, so the overlay MUST be gone first.
        // Facebook pops the dialog with variable delay, so don't trust fixed
        // timing: wait for it to APPEAR, dismiss it, then wait until it's GONE.
        pollUntil(function () { return cfg.overlayPresent(U); }, 1600, 120, function () {
          if (cfg.overlayPresent(U)) {
            if (cfg.dismiss) { try { cfg.dismiss(U); } catch (e) {} }
            pollUntil(function () { return !cfg.overlayPresent(U); }, 2500, 120, doCapture);
          } else {
            doCapture();   // never appeared -> no overlay -> safe to capture
          }
        });
      }, cfg.preCaptureDelayMs || 300);
    } catch (err) { /* never break the page */ }
  }, true);

  // ---- Batch auto-capture (Facebook) ----
  // The app's "Capture Facebook posts" batch opens each permalink for a card that
  // has no picture; the background worker then asks us (no click) to find and
  // measure the MAIN post on this page and hand back its photo + rect. Mirrors the
  // click-driven doCapture flow, but resolves the post itself.
  if (cfg.id === "facebook") {
    const findMainPost = function () {
      const arts = Array.prototype.slice.call(document.querySelectorAll('[role="article"]'));
      if (!arts.length) return null;
      let best = null, bestScore = -1;
      for (let i = 0; i < arts.length; i++) {
        const a = arts[i];
        const r = a.getBoundingClientRect();
        if (r.width < 180 || r.height < 100) continue;
        const hasImg = !!U.largestImg(a, cfg.imageCdn);
        const topBias = Math.max(0.05, 1 - Math.max(0, r.top) / 2500);   // prefer the post nearest the top
        const score = (hasImg ? 5e9 : 0) + (r.width * r.height) * topBias;
        if (score > bestScore) { bestScore = score; best = a; }
      }
      return best || arts[0];
    };
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || msg.action !== "autoCaptureFB") return;
      let waited = 0;
      (function loop() {
        let post = findMainPost();
        const img = post ? U.largestImg(post, cfg.imageCdn) : "";
        // WAIT for the post's real photo to actually load+decode — NOT just for its
        // text. Triggering on text grabbed the loading spinner that was still
        // showing (the auto-capture bug: manual works because the photo is already
        // loaded when you click). Only time out → crop for genuine text/video posts.
        const ready = !!img;
        if (ready || waited >= 12000) {
          try { U.hoverTimestamps(post); } catch (e) {}
          setTimeout(function () {
            try {
              if (post && post.isConnected === false) post = findMainPost();
              const ex = (post && cfg.extract) ? cfg.extract(post, U) : { author: "", text: "" };
              const perma = (post && cfg.findPermalink) ? cfg.findPermalink(post, U) : "";
              const image = (post ? U.largestImg(post, cfg.imageCdn) : "") || U.largestImg(document, cfg.imageCdn);
              const rect = U.rectOf(post);
              console.log("[Interests] autoCaptureFB | img=", image ? "yes" : "no", "| rect=", rect ? (Math.round(rect.w) + "x" + Math.round(rect.h)) : "none");
              sendResponse({
                ok: true, rect: rect, image: image,
                title: cfg.title ? cfg.title(ex.author) : (ex.author || "Saved post"),
                author: ex.author || "", text: (ex && ex.text) || "",
                permalink: perma || location.href,
              });
            } catch (e) { try { sendResponse({ ok: false, error: e.message }); } catch (e2) {} }
          }, 450);
        } else { waited += 250; setTimeout(loop, 250); }
      })();
      return true;   // keep the message channel open for the async sendResponse
    });
  }

  console.log("[Interests] capture engine active (" + cfg.id + ")");
})();
