// Mirror Instagram's native "Save" (bookmark) to the Interests app.
// When you tap the bookmark on a post/reel, we capture that post's AREA (a
// cropped screenshot) + its permalink and clip it (Instagram still saves it).
// Same method as fb-save.js; tuned for Instagram's DOM. Best-effort.
(function () {
  "use strict";

  let lastClipTs = 0;

  function txtOf(el) {
    return ((el && (el.innerText || el.getAttribute("aria-label"))) || "").trim();
  }

  // Already on a specific post/reel page? Then the page URL is the link.
  function isSpecificIgUrl(h) {
    return /instagram\.com\/(p|reel|tv)\/[\w.-]+/.test(h || "");
  }
  function isPermaIg(h) {
    return /instagram\.com\/(p|reel|tv)\/[\w.-]+/.test(h || "");
  }
  // on-screen rect (CSS px + dpr) for the background to crop the screenshot to
  function rectOf(el) {
    if (!el || !el.getBoundingClientRect) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return null;
    return { x: r.left, y: r.top, w: r.width, h: r.height, dpr: window.devicePixelRatio || 1 };
  }
  // largest Instagram CDN image inside a root (skips tiny avatars/icons)
  function largestImg(root) {
    let best = "", bestArea = 0;
    try {
      Array.prototype.forEach.call((root || document).querySelectorAll("img"), function (im) {
        const s = im.currentSrc || im.src || "";
        if (!/cdninstagram|fbcdn|scontent/.test(s)) return;
        const area = (im.naturalWidth || im.width || 0) * (im.naturalHeight || im.height || 0);
        if (area > bestArea) { bestArea = area; best = s; }
      });
    } catch (e) {}
    return bestArea >= 40000 ? best : "";
  }

  // the aria-label of the clicked control (the icon often carries it on an svg)
  function labelNear(t) {
    const a = t.closest && t.closest("[aria-label]");
    if (a && a.getAttribute("aria-label")) return a.getAttribute("aria-label");
    const btn = t.closest && t.closest('div[role="button"], button, a[role="link"], span');
    const svg = btn && btn.querySelector("svg[aria-label]");
    return svg ? svg.getAttribute("aria-label") : "";
  }

  // Detect a click on the "Save" bookmark (toggles to "Remove" once saved).
  document.addEventListener("click", function (e) {
    try {
      const label = (labelNear(e.target) || "").trim().toLowerCase();
      if (label !== "save") return;   // exact bookmark action only (not "Remove", not "Save to collection…")

      const now = Date.now();
      if (now - lastClipTs < 2500) return;   // debounce
      lastClipTs = now;

      const post = getPost(e.target);
      // small delay so any tap animation/overlay settles, then measure + send
      setTimeout(function () {
        const info = extractPost(post);
        info.rect = rectOf(post);
        console.log("[Interests] IG save | author=", JSON.stringify(info.author),
          "| url=", info.url, "| rect=", info.rect ? (Math.round(info.rect.w) + "x" + Math.round(info.rect.h)) : "none");
        chrome.runtime.sendMessage({ action: "clipSocialPost", data: info }, function () {
          if (chrome.runtime.lastError) { /* SW asleep / reloading — ignore */ }
        });
      }, 250);
    } catch (err) { /* never break the page */ }
  }, true);

  // The post that owns the clicked bookmark: Instagram wraps each post in an
  // <article>; in the opened-post modal it's an <article> inside a dialog.
  function getPost(target) {
    if (target && target.closest) {
      return target.closest("article")
        || target.closest('[role="dialog"] article')
        || target.closest('[role="dialog"]')
        || target.closest("main")
        || null;
    }
    return null;
  }

  function extractPost(post) {
    let author = "", text = "", perma = "", image = "";
    try {
      if (post) {
        // author — the username link in the post header
        const aEl = post.querySelector('header a[role="link"], header a, a[role="link"]');
        author = txtOf(aEl).split("\n")[0].slice(0, 80);

        // permalink — the timestamp link (an <a> wrapping a <time>), else any /p/ link
        const anchors = Array.prototype.slice.call(post.querySelectorAll('a[href]'));
        for (let i = 0; i < anchors.length; i++) {
          if (isPermaIg(anchors[i].href) && anchors[i].querySelector("time")) { perma = anchors[i].href; break; }
        }
        if (!perma) { for (let j = 0; j < anchors.length; j++) { if (isPermaIg(anchors[j].href)) { perma = anchors[j].href; break; } } }

        text = (post.innerText || "").replace(/ /g, " ").trim().slice(0, 1000);
        image = largestImg(post);
      }
      var url = isSpecificIgUrl(location.href) ? location.href : (perma || location.href);
      if (!image) image = largestImg(document);
    } catch (e) {}
    return {
      author: author,
      text: text,
      url: (typeof url !== "undefined" ? url : location.href),
      image: image,
      pageUrl: location.href,
      title: author ? ("Instagram · " + author) : "Instagram post",
    };
  }

  console.log("[Interests] Instagram Save mirror active");
})();
