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
        // ONLY a fully DECODED image — never the display-sized but still-loading
        // placeholder/spinner (the old `im.width` fallback let that through, which
        // is exactly what auto-capture grabbed). Manual works because by click
        // time the real photo has decoded and replaced the placeholder.
        if (!im.complete || !im.naturalWidth) return;
        const area = im.naturalWidth * im.naturalHeight;
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
    // The MAIN post is the highest article on the page that owns a real photo;
    // comments are also role="article" but sit BELOW it (and a big comment must
    // never win). Fall back to the topmost large article when no photo yet.
    const findMainPost = function () {
      const arts = Array.prototype.slice.call(document.querySelectorAll('[role="article"]'))
        .filter(function (a) { const r = a.getBoundingClientRect(); return r.width >= 180 && r.height >= 100; });
      if (!arts.length) return null;
      const byTop = function (a, b) { return a.getBoundingClientRect().top - b.getBoundingClientRect().top; };
      const withPhoto = arts.filter(function (a) { return !!U.largestImg(a, cfg.imageCdn); }).sort(byTop);
      if (withPhoto.length) return withPhoto[0];          // topmost article that actually has its photo = the post
      return arts.slice().sort(byTop)[0];                 // none decoded yet → topmost large article (the post sits above comments)
    };
    // The post's photo URL straight from Facebook's page metadata. This is present
    // even when the visible <img> is still a loading spinner (a cold-opened deep
    // permalink often never renders the photo) — so the worker can fetch the REAL
    // photo by URL without it ever decoding on screen.
    const metaPhoto = function () {
      try {
        const sels = ['meta[property="og:image"]', 'meta[name="og:image"]', 'meta[property="og:image:url"]', 'meta[property="og:image:secure_url"]', 'link[rel="image_src"]'];
        for (let i = 0; i < sels.length; i++) {
          const m = document.querySelector(sels[i]);
          const u = m && (m.content || m.getAttribute("content") || m.getAttribute("href"));
          if (u && /scontent|fbcdn/i.test(u) && !/static\.|rsrc\.php|\/images\//i.test(u)) return u;
        }
      } catch (e) {}
      return "";
    };
    chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
      if (!msg || msg.action !== "autoCaptureFB") return;
      // bring the top of the page (the post + its photo) into view so FB lazy-loads
      // the photo and a crop fallback frames the POST, not the comments below it
      try { window.scrollTo(0, 0); } catch (e) {}
      let waited = 0;
      // Wait up to 18s for the REAL post photo to actually load + decode. A cold
      // permalink shows a loading SPINNER first; the manual Save works only because
      // YOU wait until the photo is on screen before clicking. 8s wasn't enough, and
      // (critically) on timeout we used to CROP the post rect — which captured the
      // spinner. Now we capture ONLY a real photo, and if none loads we give up
      // cleanly (no crop) so the card stays a favicon for a true manual Save.
      const MAX_WAIT = 18000;
      (function loop() {
        let post = findMainPost();
        // og:image (post photo / video thumbnail) is preferred and is never a spinner;
        // a decoded scontent <img> is the fallback. largestImg already rejects the
        // spinner (it's not an scontent image), so "" here means "not loaded yet".
        const img = metaPhoto() || (post ? U.largestImg(post, cfg.imageCdn) : "") || U.largestImg(document, cfg.imageCdn);
        if (img) {
          try { U.hoverTimestamps(post); } catch (e) {}
          setTimeout(function () {
            try {
              if (post && post.isConnected === false) post = findMainPost();
              const ex = (post && cfg.extract) ? cfg.extract(post, U) : { author: "", text: "" };
              const perma = (post && cfg.findPermalink) ? cfg.findPermalink(post, U) : "";
              const og = metaPhoto();
              const decoded = (post ? U.largestImg(post, cfg.imageCdn) : "") || U.largestImg(document, cfg.imageCdn);
              const image = og || decoded;   // og:image wins (real photo/thumbnail); decoded only when no metadata
              console.log("[Interests] autoCaptureFB | og:image:", !!og, "| decoded:", !!decoded, "| using:", (image || "(none)").slice(0, 80));
              sendResponse({
                ok: true, rect: null, image: image, imgSrc: og ? "og" : (decoded ? "decoded" : ""),   // rect:null → captureFbPost never crops (no spinner)
                title: cfg.title ? cfg.title(ex.author) : (ex.author || "Saved post"),
                author: ex.author || "", text: (ex && ex.text) || "",
                permalink: perma || location.href,
              });
            } catch (e) { try { sendResponse({ ok: false, error: e.message }); } catch (e2) {} }
          }, 350);
        } else if (waited >= MAX_WAIT) {
          // No real photo after the full wait — DON'T crop (that's the spinner). Skip.
          console.log("[Interests] autoCaptureFB | no real photo after " + MAX_WAIT + "ms — skipping (no spinner crop)");
          try {
            const ex = (post && cfg.extract) ? cfg.extract(post, U) : { author: "", text: "" };
            sendResponse({
              ok: true, rect: null, image: "", imgSrc: "",
              title: cfg.title ? cfg.title(ex.author) : "", author: ex.author || "", text: (ex && ex.text) || "",
              permalink: (post && cfg.findPermalink ? cfg.findPermalink(post, U) : "") || location.href,
            });
          } catch (e) { try { sendResponse({ ok: true, image: "", rect: null }); } catch (e2) {} }
        } else { waited += 250; setTimeout(loop, 250); }
      })();
      return true;   // keep the message channel open for the async sendResponse
    });
  }

  console.log("[Interests] capture engine active (" + cfg.id + ")");
})();
