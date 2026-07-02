(function () {
  function getMeta(names) {
    for (const n of names) {
      const el = document.querySelector(
        `meta[property="${n}"],meta[name="${n}"]`
      );
      if (el && el.content) return el.content.trim();
    }
    return "";
  }

  function firstLargeImage() {
    const imgs = document.querySelectorAll("body img");
    for (const img of imgs) {
      if (img.naturalWidth > 200 && img.naturalHeight > 200) return img.src;
    }
    return "";
  }

  // detect block / CAPTCHA / "press & hold" challenge interstitials (Cloudflare,
  // hCaptcha, reCAPTCHA, GeeTest, PerimeterX, Temu, etc.) so we don't store a
  // screenshot of the challenge as the card image. Tuned to avoid false
  // positives on normal pages that merely embed an invisible captcha widget.
  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) return false;        // hidden/zero-size widgets
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity || "1") === 0) return false;
    return true;
  }
  function anyVisible(sel) {
    const els = document.querySelectorAll(sel);
    for (const el of els) if (isVisible(el)) return true;
    return false;
  }
  function isBlockedPage() {
    const t = (document.title || "").toLowerCase();
    if (/just a moment|attention required|access denied|you have been blocked|are you a robot|verify you are human|403 forbidden/.test(t)) return true;

    const fullText = (document.body && document.body.innerText) || "";
    const body = fullText.slice(0, 4000).toLowerCase();
    // innerText is visible-only, so this only fires on actual challenge screens.
    // The last three phrases are Instagram's rate-limit / throttle interstitials
    // ("Please wait a few minutes before you try again.", the "Action Blocked"
    // dialog, "We restrict certain activity to protect our community") — since
    // v1.8.0 dropped the webRequest HTTP-status probe, this visible-text check is
    // what keeps a painted 429 page from overwriting a good card image. Kept
    // deliberately specific (no bare "try again later") to avoid false positives
    // on ordinary post text.
    if (/you have been blocked|checking your browser before access|verify you are human|are you a human|press *(?:&|and) *hold|complete the security check|enable javascript and cookies to continue|performance & security by cloudflare|verifying you are human|confirm you are a human|slide to verify|drag the slider to|please wait a few minutes before you try again|action blocked|we restrict certain activity/.test(body)) return true;

    // full-page Cloudflare-style challenge containers only — must be VISIBLE.
    // We deliberately do NOT match captcha iframes/widgets here: sites like
    // Temu keep persistent verification iframes on normal pages, and flagging
    // those would wrongly discard real-page captures. Modal challenges that
    // slip through can be fixed via Edit -> upload/paste an image.
    if (anyVisible("#cf-wrapper, #challenge-running, #challenge-form, #challenge-stage")) return true;

    return false;
  }

  const data = {
    title: getMeta(["og:title", "twitter:title"]) || document.title || "",
    desc: getMeta(["og:description", "twitter:description", "description"]),
    ogImage: getMeta(["og:image", "twitter:image"]),
    contentImage: firstLargeImage(),
    url: document.location.href,
    blocked: isBlockedPage(),
  };

  return data;
})();
