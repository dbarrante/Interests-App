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

      const post = lastPost || (item.closest && item.closest('[role="article"]')) || null;
      const info = extractPost(post);
      chrome.runtime.sendMessage({ action: "clipFacebookPost", data: info }, function () {
        if (chrome.runtime.lastError) { /* SW asleep / reloading — ignore */ }
      });
    } catch (err) { /* never break the page */ }
  }, true);

  function extractPost(post) {
    let author = "", text = "", url = location.href, image = "";
    try {
      if (post) {
        // author — usually the first profile link near the top of the post
        const aEl = post.querySelector('h2 a, h3 a, h4 a, strong a, a[aria-label][role="link"]');
        author = txtOf(aEl).split("\n")[0].slice(0, 120);

        // permalink — the post's own link (timestamp). Prefer a real post URL.
        const hrefs = Array.prototype.map.call(post.querySelectorAll('a[href]'), function (x) { return x.href; });
        url = hrefs.find(function (h) {
          return /\/(posts|permalink|videos|photos|reel|watch|groups\/[^/]+\/(posts|permalink))\//.test(h) || /story_fbid=|[?&]fbid=/.test(h);
        }) || location.href;

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
