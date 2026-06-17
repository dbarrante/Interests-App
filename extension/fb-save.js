// Mirror Facebook's native "Save post" to the Interests app.
// When you click Save in a post's ⋯ menu, we grab that post's author/text/
// permalink and tell the extension to clip it (FB still saves it normally).
//
// Facebook's markup is obfuscated and changes often, so this is best-effort:
// it matches on accessible labels/visible text (more stable than class names)
// and fails quietly if it can't find the post.
(function () {
  "use strict";

  let lastPost = null;       // the post whose action (⋯) menu was last opened
  let lastClipTs = 0;        // debounce duplicate clicks

  function txtOf(el) {
    return ((el && (el.innerText || el.getAttribute("aria-label"))) || "").trim();
  }

  // Remember which post's "⋯" menu was just opened, so a later "Save" click in
  // the floating menu can be tied back to the right post.
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
      // only the "save" action — not "unsave" / "remove from saved"
      if (/(unsave|remove from saved)/.test(t)) return;
      if (!/^save$|^save post$|^save video$|^save reel$|^save link$|save to (your )?saved/.test(t)) return;

      const now = Date.now();
      if (now - lastClipTs < 2500) return;   // debounce
      lastClipTs = now;

      // Identify the post: the most reliable signal is the ⋯ trigger of the
      // currently-open menu, which is still aria-expanded="true" at click time.
      // Fall back to the last-opened post, then the item's own article.
      const post = getPostForMenu(item);
      // Facebook lazy-fills the timestamp link's href only on hover, so nudge
      // those links first, then read after a tick once the href is populated.
      hoverTimestamps(post);
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

  // A post permalink is on a "timestamp" link (text like "5h", "2d", "Yesterday",
  // "June 16"). Dispatch hover events on those so Facebook fills in the real href.
  const TIME_RE = /^\s*(just now|\d+\s*(s|m|h|d|w|hr|hrs|min|mins|y)\b|yesterday|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}|\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))/i;
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

  // Find the post (role=article) that owns the just-clicked menu item, as
  // precisely as possible — Facebook nests/wraps articles, so a loose match
  // grabs several posts at once.
  function getPostForMenu(item) {
    try {
      // 1) spec-correct: the menu's trigger is referenced by aria-controls
      const menu = item.closest('[role="menu"]');
      if (menu && menu.id) {
        const sel = '[aria-controls="' + (window.CSS && CSS.escape ? CSS.escape(menu.id) : menu.id) + '"]';
        const trig = document.querySelector(sel);
        const art = trig && smallestArticleAt(trig);
        if (art) return art;
      }
      // 2) the open menu trigger: an expanded button that pops a menu
      const trigs = document.querySelectorAll('[aria-haspopup="menu"][aria-expanded="true"], [aria-expanded="true"][aria-label*="ction"]');
      const arts = [];
      for (let i = 0; i < trigs.length; i++) { const a = smallestArticleAt(trigs[i]); if (a) arts.push(a); }
      if (arts.length) { arts.sort(function (a, b) { return (a.innerText || "").length - (b.innerText || "").length; }); return arts[0]; }
    } catch (e) {}
    // 3) fallbacks
    return lastPost || (item.closest && item.closest('[role="article"]')) || null;
  }
  // innermost (smallest) article ancestor of an element — a single post, not a
  // feed container that holds many posts.
  function smallestArticleAt(el) {
    const a = el && el.closest && el.closest('[role="article"]');
    if (!a) return null;
    const inner = a.querySelector('[role="article"]');
    if (inner && inner.contains(el)) return inner;
    return a;
  }

  function extractPost(post) {
    let author = "", text = "", url = location.href, image = "";
    try {
      if (post) {
        // author — usually the first profile link near the top of the post
        const aEl = post.querySelector('h2 a, h3 a, h4 a, strong a, a[aria-label][role="link"]');
        author = txtOf(aEl).split("\n")[0].slice(0, 120);

        // permalink — the post's OWN link. Facebook lazy-fills timestamp hrefs
        // on hover (done just before this runs). Embedded/shared posts also
        // carry permalink-shaped links, so prefer the short-text timestamp
        // anchor, then any permalink. Covers post/permalink/video/reel/photo/
        // story/share and group post URLs.
        function isPerma(h) {
          if (!h || h === "#" || /^javascript:/i.test(h) || /comment_id=|reply_comment_id=/.test(h)) return false;
          return /\/(posts|permalink\.php|permalink|videos|watch|reel\/|photo\.php|photos|story\.php|share\/[pvr]|groups\/[^/]+\/(posts|permalink))/.test(h) || /story_fbid=|[?&]fbid=/.test(h);
        }
        const anchors = Array.prototype.slice.call(post.querySelectorAll('a[role="link"], a[href]'));
        function hrefOf(a) { return a.href || a.getAttribute("href") || ""; }
        let perma = "";
        for (let i = 0; i < anchors.length; i++) {
          if (isPerma(hrefOf(anchors[i])) && TIME_RE.test((anchors[i].innerText || "").trim())) { perma = hrefOf(anchors[i]); break; }
        }
        if (!perma) { for (let k = 0; k < anchors.length; k++) { if (isPerma(hrefOf(anchors[k])) && (anchors[k].innerText || "").trim().length <= 16) { perma = hrefOf(anchors[k]); break; } } }
        if (!perma) { for (let j = 0; j < anchors.length; j++) { if (isPerma(hrefOf(anchors[j]))) { perma = hrefOf(anchors[j]); break; } } }
        url = perma || location.href;

        // body text (strip the trailing reaction/comment chrome as best we can)
        text = (post.innerText || "").replace(/ /g, " ").trim().slice(0, 1200);

        // the post's main photo — pick the LARGEST fbcdn image so we skip the
        // tiny author avatar / reaction icons and grab the actual content image
        let best = "", bestArea = 0;
        Array.prototype.forEach.call(post.querySelectorAll("img"), function (im) {
          const s = im.currentSrc || im.src || "";
          if (!/scontent|fbcdn/.test(s)) return;
          const area = (im.naturalWidth || im.width || 0) * (im.naturalHeight || im.height || 0);
          if (area > bestArea) { bestArea = area; best = s; }
        });
        image = bestArea >= 40000 ? best : "";   // require ~200x200+ (skip avatars/icons)
      }
    } catch (e) {}
    return {
      author: author,
      text: text,
      url: url,
      image: image,
      pageUrl: location.href,
      title: author ? ("Facebook · " + author) : "Facebook post",
    };
  }

  console.log("[Interests] Facebook Save mirror active");
})();
