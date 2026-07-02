// Per-platform capture configs for the Interests capture engine (capture-core.js).
// Each config overrides only what differs for its site. Add a platform by adding
// a config object here + its host to the manifest content_scripts match list.
//
// A config may provide:
//   id                       string label (used in logs)
//   match(host)              -> bool   does this config apply to this site?
//   init(U)                  optional one-time setup (extra listeners/state)
//   saveTrigger(e, U)        -> Element|null   the clicked "Save" control, or null
//   findPost(trigger, U)     -> Element        the post container to capture
//   isSpecificUrl(href)      -> bool   is the page URL already the post permalink?
//   findPermalink(post, U)   -> url    scrape fallback (feed view)
//   extract(post, U)         -> { author, text }
//   title(author)            -> string
//   image                    strategy for background.js's clipSocialPost handler:
//                              "photo" (Facebook/Pinterest/YouTube) — try the post's own
//                                photo/thumbnail first, crop the post rect as fallback
//                              "region" (Instagram) — crop the post rect first, photo as
//                                fallback (its own photo is often the "Save To" overlay)
//                              "screenshot" — skip the rect (no crop; falls through to a
//                                page screenshot)
//   imageCdn                 RegExp for the image fallback
//   preCaptureDelayMs        wait before measuring (let native menus close)
//   hoverTimestamps          bool — coax lazy permalink hrefs (Facebook)
(function () {
  "use strict";

  /* ============================ Facebook ============================ */
  let fbLastPost = null;
  function fbItem(e) { return e.target.closest('[role="menuitem"], [role="menuitemcheckbox"], div[role="button"], a[role="link"]'); }
  function fbIsSpecific(h) { return /\/(posts|permalink\.php|permalink|videos|watch|reel|photo(\.php)?|photos|story\.php|share\/[pvr]|groups\/[^/]+\/(posts|permalink))/.test(h || "") || /story_fbid=|[?&]fbid=/.test(h || ""); }
  function fbIsPerma(h) {
    if (!h || h === "#" || /^javascript:/i.test(h) || /comment_id=|reply_comment_id=/.test(h)) return false;
    return /\/(posts|permalink\.php|permalink|videos|watch|reel\/|photo\.php|photos|story\.php|share\/[pvr]|groups\/[^/]+\/(posts|permalink))/.test(h) || /story_fbid=|[?&]fbid=/.test(h);
  }
  function fbGetPost(item, U) {
    try {
      const menu = item.closest('[role="menu"]');
      if (menu && menu.id) {
        const sel = '[aria-controls="' + (window.CSS && CSS.escape ? CSS.escape(menu.id) : menu.id) + '"]';
        const art = U.smallestArticleAt(document.querySelector(sel));
        if (art) return art;
      }
      const trigs = document.querySelectorAll('[aria-haspopup="menu"][aria-expanded="true"], [aria-expanded="true"][aria-label*="ction"]');
      const arts = [];
      for (let i = 0; i < trigs.length; i++) { const a = U.smallestArticleAt(trigs[i]); if (a) arts.push(a); }
      if (arts.length) { arts.sort(function (a, b) { return (a.innerText || "").length - (b.innerText || "").length; }); return arts[0]; }
    } catch (e) {}
    return fbLastPost || (item.closest && item.closest('[role="article"]')) || null;
  }
  const facebook = {
    id: "facebook",
    match: function (h) { return /facebook\.com/.test(h); },
    // "photo": save the post's own photo (ignores the "Save To" collection
    // dialog that floats over the post); region crop is only the text-post fallback.
    image: "photo", imageCdn: /scontent|fbcdn/, preCaptureDelayMs: 550, hoverTimestamps: true,
    init: function (U) {
      document.addEventListener("click", function (e) {
        try {
          const lbl = e.target.closest && e.target.closest('[aria-label]');
          if (!lbl) return;
          const a = (lbl.getAttribute("aria-label") || "").toLowerCase();
          if (/actions for this|more options|more actions/.test(a)) fbLastPost = lbl.closest('[role="article"]') || null;
        } catch (e) {}
      }, true);
    },
    saveTrigger: function (e, U) {
      const item = fbItem(e); if (!item) return null;
      const t = U.txtOf(item).toLowerCase().split("\n")[0];
      if (/(unsave|remove from saved)/.test(t)) return null;
      const explicit = /^save (post|video|reel|link)$|save to (your )?saved/.test(t);
      const bareSave = /^save$/.test(t);
      if (!explicit && !bareSave) return null;
      // a bare "Save" must be a real menu item in an open menu — otherwise a
      // generic on-page "Save" button (settings, composer, etc.) would fire a clip
      if (bareSave && !item.closest('[role="menu"]') && item.getAttribute("role") !== "menuitem" && item.getAttribute("role") !== "menuitemcheckbox") return null;
      return item;
    },
    // Is Facebook's "Save To" collection dialog currently floating over the post?
    overlayPresent: function (U) {
      try {
        const dlgs = document.querySelectorAll('[role="dialog"]');
        for (let i = 0; i < dlgs.length; i++) {
          if (/save to|new collection|your collections/i.test((dlgs[i].textContent || "").slice(0, 400))) return true;
        }
      } catch (e) {}
      return false;
    },
    // Close the "Save To" dialog by clicking only the POSITIVE confirm (Done/Save)
    // — which keeps the default save — so the region crop sees the post. Never
    // click X/Close/Cancel (that can close the post view or cancel the save).
    dismiss: function (U) {
      try {
        const dlgs = document.querySelectorAll('[role="dialog"]');
        for (let i = 0; i < dlgs.length; i++) {
          const d = dlgs[i];
          if (!/save to|new collection|your collections/i.test((d.textContent || "").slice(0, 400))) continue;
          const btns = d.querySelectorAll('[role="button"], button, [aria-label]');
          for (let j = 0; j < btns.length; j++) {
            const lab = ((btns[j].innerText || btns[j].getAttribute("aria-label") || "")).trim().toLowerCase();
            if (lab === "done" || lab === "save") { btns[j].click(); return; }
          }
          return;   // matched the dialog but no positive button — leave it (don't risk cancelling)
        }
      } catch (e) {}
    },
    findPost: function (item, U) { return fbGetPost(item, U); },
    isSpecificUrl: fbIsSpecific,
    findPermalink: function (post, U) {
      const anchors = Array.prototype.slice.call(post.querySelectorAll('a[role="link"], a[href]'));
      let perma = "";
      for (let i = 0; i < anchors.length; i++) { if (fbIsPerma(U.hrefOf(anchors[i])) && U.TIME_RE.test((anchors[i].innerText || "").trim())) { perma = U.hrefOf(anchors[i]); break; } }
      if (!perma) { for (let k = 0; k < anchors.length; k++) { if (fbIsPerma(U.hrefOf(anchors[k])) && (anchors[k].innerText || "").trim().length <= 16) { perma = U.hrefOf(anchors[k]); break; } } }
      if (!perma) { for (let j = 0; j < anchors.length; j++) { if (fbIsPerma(U.hrefOf(anchors[j]))) { perma = U.hrefOf(anchors[j]); break; } } }
      if (perma) return perma;
      // No post permalink (sponsored ads / timestamp-less posts): fall back to the
      // author/page header link so the card opens the poster's page, not the feed.
      const a = post.querySelector('h2 a[href], h3 a[href], h4 a[href], strong a[href]');
      const h = a ? U.hrefOf(a) : "";
      // a real page/profile link, not an in-post action (reactions/comments/photo viewer)
      // keep the query (profile.php?id=… needs it); just reject in-post action links
      if (h && /facebook\.com\//i.test(h) && !/comment_id=|reaction|\/photo|\/reactions/i.test(h)) return h;
      return "";
    },
    extract: function (post, U) {
      // strip Facebook header CTA cruft ("…, view story", "· Follow", "is live",
      // "Sponsored") so the author/title is just the name
      const cleanAuthor = function (s) {
        return (s || "").split("\n")[0]
          .replace(/\s*[,·|]\s*(view (story|reel|video)|follow|is (now )?live|sponsored|suggested for you).*$/i, "")
          .trim().slice(0, 120);
      };
      let author = cleanAuthor(U.txtOf(post.querySelector('h2 a, h3 a, h4 a, strong a, a[aria-label][role="link"]')));
      if (!author) author = cleanAuthor(U.txtOf(document.querySelector('[role="dialog"] h2 a, [role="dialog"] h3 a, [role="complementary"] a[role="link"]')));
      const text = (post.innerText || "").replace(/ /g, " ").trim().slice(0, 1200);
      return { author: author, text: text };
    },
    title: function (a) { return a ? ("Facebook · " + a) : "Facebook post"; },
  };

  /* ============================ Instagram ============================ */
  function igLabelNear(t) {
    const a = t.closest && t.closest("[aria-label]");
    if (a && a.getAttribute("aria-label")) return a.getAttribute("aria-label");
    const btn = t.closest && t.closest('div[role="button"], button, a[role="link"], span');
    const svg = btn && btn.querySelector("svg[aria-label]");
    return svg ? svg.getAttribute("aria-label") : "";
  }
  function igIsSpecific(h) { return /instagram\.com\/(p|reel|reels|tv)\/[\w.-]+/.test(h || ""); }
  const instagram = {
    id: "instagram",
    match: function (h) { return /instagram\.com/.test(h); },
    image: "region", imageCdn: /cdninstagram|fbcdn|scontent/, preCaptureDelayMs: 250,
    saveTrigger: function (e, U) {
      const label = (igLabelNear(e.target) || "").trim().toLowerCase();
      if (label !== "save") return null;
      return e.target.closest('div[role="button"], button, a[role="link"], span') || e.target;
    },
    findPost: function (trigger, U) {
      return trigger.closest("article") || trigger.closest('[role="dialog"] article') || trigger.closest('[role="dialog"]') || trigger.closest("main") || null;
    },
    isSpecificUrl: igIsSpecific,
    findPermalink: function (post, U) {
      const anchors = Array.prototype.slice.call(post.querySelectorAll('a[href]'));
      let perma = "";
      for (let i = 0; i < anchors.length; i++) { if (igIsSpecific(U.hrefOf(anchors[i])) && anchors[i].querySelector("time")) { perma = U.hrefOf(anchors[i]); break; } }
      if (!perma) { for (let j = 0; j < anchors.length; j++) { if (igIsSpecific(U.hrefOf(anchors[j]))) { perma = U.hrefOf(anchors[j]); break; } } }
      return perma;
    },
    extract: function (post, U) {
      const author = U.txtOf(post.querySelector('header a[role="link"], header a, a[role="link"]')).split("\n")[0].slice(0, 80);
      const text = (post.innerText || "").replace(/ /g, " ").trim().slice(0, 1000);
      return { author: author, text: text };
    },
    title: function (a) { return a ? ("Instagram · " + a) : "Instagram post"; },
  };

  /* ============================ Pinterest ============================ */
  // The SINGLE pin tile that owns the clicked Save button: the tightest ancestor
  // whose subtree contains exactly ONE /pin/ link (its own). Return null if the
  // nearest pin-link container holds several (a multi-pin grid, or the focused
  // pin's closeup with the related grid) — then the engine uses location.href,
  // which IS correct for the focused pin and avoids grabbing a neighbour's pin.
  function pinClosest(trigger) {
    let el = trigger;
    for (let i = 0; i < 12 && el && el !== document.body; i++) {
      if (el.querySelectorAll) {
        const n = el.querySelectorAll('a[href*="/pin/"]').length;
        if (n === 1) return el;     // a single-pin tile
        if (n > 1) return null;     // overshot into a multi-pin container — not a tile
      }
      el = el.parentElement;
    }
    return null;
  }
  const pinterest = {
    id: "pinterest",
    match: function (h) { return /pinterest\./.test(h); },
    // "photo": save the pin's own pinimg image (the tile's image), not a region
    // crop — avoids the rect snapping to a closeup dialog, and is higher quality.
    image: "photo", imageCdn: /pinimg/, preCaptureDelayMs: 300,
    saveTrigger: function (e, U) {
      const btn = e.target.closest('[data-test-id*="SaveButton"], [aria-label], div[role="button"], button');
      if (!btn) return null;
      const dtid = (btn.getAttribute && btn.getAttribute("data-test-id")) || "";
      if (/savebutton/i.test(dtid)) return btn;
      const label = ((btn.getAttribute && btn.getAttribute("aria-label")) || U.txtOf(btn) || "").toLowerCase().split("\n")[0].trim();
      if (/(unsave|saved|remove)/.test(label)) return null;
      return label === "save" ? btn : null;
    },
    findPost: function (trigger, U) { return pinClosest(trigger); },
    // a Pinterest page shows MANY pins — never trust location.href to say which
    // one was saved; always use findPermalink (the clicked tile's own /pin/ link)
    isSpecificUrl: function () { return false; },
    findPermalink: function (post, U) { const a = post.querySelector('a[href*="/pin/"]'); return a ? U.hrefOf(a) : ""; },
    extract: function (post, U) {
      const author = U.txtOf(post.querySelector('[data-test-id="pinTitle"], [data-test-id="pinrep-title"], a[href*="/pin/"]')).split("\n")[0].slice(0, 120);
      const text = (post.innerText || "").replace(/ /g, " ").trim().slice(0, 800);
      return { author: author, text: text };
    },
    title: function (a) { return a ? ("Pinterest · " + a) : "Pinterest pin"; },
  };

  /* ============================ YouTube ============================ */
  // The add-to-playlist dialog is a DETACHED popup with no link back to the video,
  // so remember which tile's ⋮ menu opened the save flow (mirrors fbLastPost). On a
  // watch page the video is resolvable from the URL, so no tracking is needed there.
  let _ytPending = null, _ytPendingAt = 0;
  const YT_TILE_SEL = "ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-reel-item-renderer, ytd-playlist-video-renderer, ytd-rich-grid-media";
  function ytTileFrom(el) {
    let node = (el && el.closest) ? el.closest(YT_TILE_SEL) : null;
    if (node) return node;
    node = el;
    while (node && node !== document.body) {
      if (node.querySelector && node.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]')) return node;
      node = node.parentElement;
    }
    return null;
  }
  function ytWatchVideo() {
    if (/[?&]v=/.test(location.href) || /\/shorts\//.test(location.href)) return document.querySelector("ytd-watch-flexy, #primary") || document.body;
    return null;
  }
  function ytInPlaylistDialog(el) {
    return !!(el && el.closest && el.closest('ytd-add-to-playlist-renderer, ytd-playlist-add-to-option-renderer'));
  }
  function ytPlaylistRow(el) { return (el && el.closest) ? el.closest('ytd-playlist-add-to-option-renderer') : null; }
  function ytLabelOf(el) {
    const b = (el && el.closest) ? el.closest('[aria-label], [title], ytd-menu-service-item-renderer, tp-yt-paper-item, a, button') : null;
    return (((b && b.getAttribute && (b.getAttribute("aria-label") || b.getAttribute("title"))) || (b && b.innerText) || (el && el.innerText) || "")).toLowerCase();
  }
  // Read a playlist row's current checked state. A freshly-listed row with no
  // explicit state defaults to UN-checked (so a click on it is "about to add").
  function ytRowChecked(row) {
    const cb = row.querySelector('tp-yt-paper-checkbox, [role="checkbox"], #checkbox') || row;
    const ac = (cb.getAttribute && cb.getAttribute("aria-checked")) || (row.getAttribute && row.getAttribute("aria-checked"));
    if (ac === "true") return true;
    if (ac === "false") return false;
    if (cb.hasAttribute && (cb.hasAttribute("checked") || cb.hasAttribute("active"))) return true;
    return false;
  }
  const youtube = {
    id: "youtube",
    match: function (h) { return /(^|\.)youtube\.com$/.test(h); },
    image: "photo", imageCdn: /ytimg/, preCaptureDelayMs: 0,
    // Remember which tile a save flow started from: clicking a tile's ⋮ "Action
    // menu" in the feed/grid/search/sidebar. Capture-phase so we see it first.
    init: function (U) {
      document.addEventListener("click", function (e) {
        try {
          const menu = e.target.closest && e.target.closest("ytd-menu-renderer");
          const lab = ytLabelOf(e.target);
          if (!menu && !/action menu|more actions/.test(lab)) return;
          const tile = ytTileFrom(menu || e.target);
          if (tile) { _ytPending = tile; _ytPendingAt = Date.now(); }
        } catch (err) { /* never break the page */ }
      }, true);
    },
    saveTrigger: function (e, U) {
      try {
        const t = e.target;
        const inDialog = ytInPlaylistDialog(t);
        const row = ytPlaylistRow(t);
        const lab = ytLabelOf(t);
        const isWatchLater = /save to watch later|add to watch later/.test(lab) && !/remove/.test(lab);
        const isOpener = (/^\s*save\s*$/.test(lab) || /save to playlist|add to playlist/.test(lab)) && !inDialog;
        const decide = (typeof window !== "undefined") && window.ytShouldFireAdd;
        if (!decide) return null;   // helper not loaded -> fail safe (capture nothing)
        const fire = decide({
          inPlaylistDialog: inDialog && !!row,
          ariaChecked: (inDialog && row) ? ytRowChecked(row) : undefined,
          isWatchLaterMenuItem: isWatchLater,
          isSavePlaylistOpener: isOpener,
        });
        if (!fire) return null;
        return row || t.closest('ytd-menu-service-item-renderer, tp-yt-paper-item, [role="menuitem"]') || t;
      } catch (err) { return null; }
    },
    // Dialog/Watch-later trigger -> the pending video (or the watch-page video).
    // A direct tile trigger (right-click captureCtxPost) -> resolve the tile as before.
    findPost: function (trigger, U) {
      try {
        if (ytInPlaylistDialog(trigger) || /save to watch later|add to watch later/.test(ytLabelOf(trigger))) {
          if (_ytPending && _ytPending.isConnected !== false && (Date.now() - _ytPendingAt) < 60000) return _ytPending;
          return ytWatchVideo();
        }
      } catch (err) {}
      const tile = ytTileFrom(trigger);
      if (tile) return tile;
      return ytWatchVideo();
    },
    isSpecificUrl: function (href) { return /[?&]v=/.test(href || "") || /\/shorts\//.test(href || ""); },
    findPermalink: function (post, U) {
      const a = post.querySelector ? post.querySelector('a[href*="/watch?v="], a[href*="/shorts/"]') : null;
      const href = a ? U.hrefOf(a) : (this.isSpecificUrl(location.href) ? location.href : "");
      try {
        const q = new URL(href, location.origin);
        const v = q.searchParams.get("v"); if (v) return "https://www.youtube.com/watch?v=" + v;
        const m = /\/shorts\/([^/?#]+)/.exec(q.pathname); if (m) return "https://www.youtube.com/shorts/" + m[1];
      } catch (e) {}
      return href || location.href;
    },
    extract: function (post, U) {
      const t = U.txtOf(post.querySelector ? post.querySelector('#video-title, a#video-title, yt-formatted-string#video-title, h1 yt-formatted-string, h1.title') : null);
      return { author: (t || "").split("\n")[0].slice(0, 200), text: "" };
    },
    title: function (a) { return a || "YouTube video"; },
  };

  window.INTERESTS_CAPTURE_CONFIGS = [facebook, instagram, pinterest, youtube];
})();
