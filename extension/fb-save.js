// Mirror Facebook's native "Save post" to the Interests app.
// When you click Save in a post's menu, we grab that post's author/text/
// permalink/photo and tell the extension to clip it (FB still saves it too).
//
// Facebook's markup is obfuscated and changes often, so this is best-effort:
// it matches on accessible labels/visible text (more stable than class names)
// and fails quietly if it can't find the post.
(function () {
  "use strict";

  let lastPost = null;       // the post whose action menu was last opened
  let lastClipTs = 0;        // debounce duplicate clicks

  function txtOf(el) {
    return ((el && (el.innerText || el.getAttribute("aria-label"))) || "").trim();
  }

  // A "timestamp" link (text like "5h", "2d", "Yesterday", "June 16") carries
  // the post permalink. Facebook lazy-fills its href on hover.
  const TIME_RE = /^\s*(just now|\d+\s*(s|m|h|d|w|hr|hrs|min|mins|y)\b|yesterday|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}|\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/i;

  // Is this URL already a specific post/photo/video page (theater or permalink
  // view) rather than the generic feed/home? If so it's the reliable link.
  function isSpecificFbUrl(h) {
    return /\/(posts|permalink\.php|permalink|videos|watch|reel|photo(\.php)?|photos|story\.php|share\/[pvr]|groups\/[^/]+\/(posts|permalink))/.test(h || "") || /story_fbid=|[?&]fbid=/.test(h || "");
  }
  function isPerma(h) {
    if (!h || h === "#" || /^javascript:/i.test(h) || /comment_id=|reply_comment_id=/.test(h)) return false;
    return /\/(posts|permalink\.php|permalink|videos|watch|reel\/|photo\.php|photos|story\.php|share\/[pvr]|groups\/[^/]+\/(posts|permalink))/.test(h) || /story_fbid=|[?&]fbid=/.test(h);
  }
  // the largest fbcdn image inside a root (skips tiny avatars/reaction icons)
  function largestImg(root) {
    let best = "", bestArea = 0;
    try {
      Array.prototype.forEach.call((root || document).querySelectorAll("img"), function (im) {
        const s = im.currentSrc || im.src || "";
        if (!/scontent|fbcdn/.test(s)) return;
        const area = (im.naturalWidth || im.width || 0) * (im.naturalHeight || im.height || 0);
        if (area > bestArea) { bestArea = area; best = s; }
      });
    } catch (e) {}
    return bestArea >= 40000 ? best : "";   // require ~200x200+
  }

  // Remember which post's action menu was just opened (fallback path).
  document.addEventListener("click", function (e) {
    try {
      const lbl = e.target.closest && e.target.closest('[aria-label]');
      if (!lbl) return;
      const a = (lbl.getAttribute("aria-label") || "").toLowerCase();
      if (/actions for this|more options|more actions/.test(a)) {
        lastPost = lbl.closest('[role="article"]') || null;
      }
    } catch (e) {}
  }, true);

  // Detect a click on a "Save post / Save video / Save" menu item.
  document.addEventListener("click", function (e) {
    try {
      const item = e.target.closest('[role="menuitem"], [role="menuitemcheckbox"], div[role="button"], a[role="link"]');
      if (!item) return;
      const t = txtOf(item).toLowerCase().split("\n")[0];
      if (/(unsave|remove from saved)/.test(t)) return;   // not the un-save action
      if (!/^save$|^save post$|^save video$|^save reel$|^save link$|save to (your )?saved/.test(t)) return;

      const now = Date.now();
      if (now - lastClipTs < 2500) return;   // debounce
      lastClipTs = now;

      const post = getPostForMenu(item);
      hoverTimestamps(post);   // coax Facebook to fill in lazy permalink hrefs
      setTimeout(function () {
        const info = extractPost(post);
        console.log("[Interests] FB save | author=", JSON.stringify(info.author),
          "| url=", info.url, "| textHead=", JSON.stringify((info.text || "").slice(0, 50)));
        chrome.runtime.sendMessage({ action: "clipFacebookPost", data: info }, function () {
          if (chrome.runtime.lastError) { /* SW asleep / reloading — ignore */ }
        });
      }, 250);
    } catch (err) { /* never break the page */ }
  }, true);

  function hoverTimestamps(post) {
    if (!post) return;
    try {
      const links = post.querySelectorAll('a[role="link"], a[href]');
      let nudged = 0;
      for (let i = 0; i < links.length && nudged < 6; i++) {
        const tx = (links[i].innerText || "").trim();
        if (tx && tx.length <= 24 && TIME_RE.test(tx)) {
          ["mouseover", "mouseenter", "pointerover", "focus"].forEach(function (ev) {
            try { links[i].dispatchEvent(new MouseEvent(ev, { bubbles: true })); } catch (e) {}
          });
          nudged++;
        }
      }
    } catch (e) {}
  }

  // Find the single post (role=article) that owns the clicked menu item. FB
  // nests/wraps articles, so a loose match grabs several posts at once.
  function getPostForMenu(item) {
    try {
      // 1) spec-correct: the menu's trigger is referenced by aria-controls
      const menu = item.closest('[role="menu"]');
      if (menu && menu.id) {
        const sel = '[aria-controls="' + (window.CSS && CSS.escape ? CSS.escape(menu.id) : menu.id) + '"]';
        const art = smallestArticleAt(document.querySelector(sel));
        if (art) return art;
      }
      // 2) the open menu trigger: an expanded button that pops a menu
      const trigs = document.querySelectorAll('[aria-haspopup="menu"][aria-expanded="true"], [aria-expanded="true"][aria-label*="ction"]');
      const arts = [];
      for (let i = 0; i < trigs.length; i++) { const a = smallestArticleAt(trigs[i]); if (a) arts.push(a); }
      if (arts.length) { arts.sort(function (a, b) { return (a.innerText || "").length - (b.innerText || "").length; }); return arts[0]; }
    } catch (e) {}
    return lastPost || (item.closest && item.closest('[role="article"]')) || null;
  }
  // innermost article ancestor of an element — a single post, not a container
  function smallestArticleAt(el) {
    const a = el && el.closest && el.closest('[role="article"]');
    if (!a) return null;
    const inner = a.querySelector('[role="article"]');
    if (inner && inner.contains(el)) return inner;
    return a;
  }

  function extractPost(post) {
    let author = "", text = "", perma = "", image = "";
    try {
      if (post) {
        const aEl = post.querySelector('h2 a, h3 a, h4 a, strong a, a[aria-label][role="link"]');
        author = txtOf(aEl).split("\n")[0].slice(0, 120);

        const anchors = Array.prototype.slice.call(post.querySelectorAll('a[role="link"], a[href]'));
        function hrefOf(a) { return a.href || a.getAttribute("href") || ""; }
        // prefer the short-text timestamp anchor, then any permalink
        for (let i = 0; i < anchors.length; i++) {
          if (isPerma(hrefOf(anchors[i])) && TIME_RE.test((anchors[i].innerText || "").trim())) { perma = hrefOf(anchors[i]); break; }
        }
        if (!perma) { for (let k = 0; k < anchors.length; k++) { if (isPerma(hrefOf(anchors[k])) && (anchors[k].innerText || "").trim().length <= 16) { perma = hrefOf(anchors[k]); break; } } }
        if (!perma) { for (let j = 0; j < anchors.length; j++) { if (isPerma(hrefOf(anchors[j]))) { perma = hrefOf(anchors[j]); break; } } }

        text = (post.innerText || "").replace(/ /g, " ").trim().slice(0, 1200);
        image = largestImg(post);
      }

      // On a specific post/photo page (theater or permalink view) the page URL
      // is the reliable link — prefer it over any scraped anchor.
      var url = isSpecificFbUrl(location.href) ? location.href : (perma || location.href);
      // theater/lightbox: the big photo lives outside the post node
      if (!image) image = largestImg(document);
      // theater author lives in a side panel/dialog
      if (!author) {
        const a2 = document.querySelector('[role="dialog"] h2 a, [role="dialog"] h3 a, [role="complementary"] a[role="link"]');
        author = txtOf(a2).split("\n")[0].slice(0, 120);
      }
    } catch (e) {}
    return {
      author: author,
      text: text,
      url: (typeof url !== "undefined" ? url : location.href),
      image: image,
      pageUrl: location.href,
      title: author ? ("Facebook · " + author) : "Facebook post",
    };
  }

  console.log("[Interests] Facebook Save mirror active");
})();
