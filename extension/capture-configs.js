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
//   image                    "region" (crop the post rect) | other
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
      return (/^save$|^save post$|^save video$|^save reel$|^save link$|save to (your )?saved/.test(t)) ? item : null;
    },
    // Saving opens a "Save To" collection dialog that floats over the post.
    // Close it (Done keeps the default save) so the region crop sees the post.
    dismiss: function (U) {
      try {
        const dlgs = document.querySelectorAll('[role="dialog"]');
        for (let i = 0; i < dlgs.length; i++) {
          const d = dlgs[i];
          if (!/save to/i.test((d.textContent || "").slice(0, 200))) continue;
          const btns = d.querySelectorAll('[role="button"], button, a[role="link"], [aria-label]');
          let done = null, close = null;
          for (let j = 0; j < btns.length; j++) {
            const lab = ((btns[j].innerText || btns[j].getAttribute("aria-label") || "")).trim().toLowerCase();
            if (/^done$/.test(lab)) { done = btns[j]; break; }
            if (/^close$/.test(lab)) close = btns[j];
          }
          const btn = done || close;
          if (btn) btn.click();
          return;
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
      return perma;
    },
    extract: function (post, U) {
      let author = U.txtOf(post.querySelector('h2 a, h3 a, h4 a, strong a, a[aria-label][role="link"]')).split("\n")[0].slice(0, 120);
      if (!author) author = U.txtOf(document.querySelector('[role="dialog"] h2 a, [role="dialog"] h3 a, [role="complementary"] a[role="link"]')).split("\n")[0].slice(0, 120);
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
  function igIsSpecific(h) { return /instagram\.com\/(p|reel|tv)\/[\w.-]+/.test(h || ""); }
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
  function pinClosest(trigger) {
    let p = trigger.closest('[data-test-id="pin"], [data-test-id="pinWrapper"], [data-grid-item], [role="listitem"]');
    if (p) return p;
    let el = trigger;                                   // walk up to a node containing a /pin/ link
    for (let i = 0; i < 8 && el; i++) { if (el.querySelector && el.querySelector('a[href*="/pin/"]')) return el; el = el.parentElement; }
    return trigger.closest('[role="dialog"]') || trigger.closest("article") || null;
  }
  function pinIsSpecific(h) { return /pinterest\.[a-z.]+\/pin\/[\w-]+/.test(h || ""); }
  const pinterest = {
    id: "pinterest",
    match: function (h) { return /pinterest\./.test(h); },
    image: "region", imageCdn: /pinimg/, preCaptureDelayMs: 500,
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
    isSpecificUrl: pinIsSpecific,
    findPermalink: function (post, U) { const a = post.querySelector('a[href*="/pin/"]'); return a ? U.hrefOf(a) : ""; },
    extract: function (post, U) {
      const author = U.txtOf(post.querySelector('[data-test-id="pinTitle"], [data-test-id="pinrep-title"], a[href*="/pin/"]')).split("\n")[0].slice(0, 120);
      const text = (post.innerText || "").replace(/ /g, " ").trim().slice(0, 800);
      return { author: author, text: text };
    },
    title: function (a) { return a ? ("Pinterest · " + a) : "Pinterest pin"; },
  };

  window.INTERESTS_CAPTURE_CONFIGS = [facebook, instagram, pinterest];
})();
