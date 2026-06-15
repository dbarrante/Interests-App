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
  function isBlockedPage() {
    const t = (document.title || "").toLowerCase();
    if (/just a moment|attention required|access denied|you have been blocked|are you a robot|verify you are human|403 forbidden/.test(t)) return true;

    const fullText = (document.body && document.body.innerText) || "";
    const body = fullText.slice(0, 4000).toLowerCase();
    // visible challenge wording only appears on actual challenge screens
    if (/you have been blocked|checking your browser before access|verify you are human|are you a human|press *(?:&|and) *hold|complete the security check|enable javascript and cookies to continue|performance & security by cloudflare|verifying you are human|confirm you are a human|slide to verify|drag the slider to/.test(body)) return true;

    // full-page challenge containers (not embedded/invisible widgets)
    if (document.querySelector("#cf-wrapper, .cf-error-code, #challenge-running, #challenge-form, #challenge-stage, #px-captcha")) return true;

    // an iframe-based captcha that IS basically the whole page (short body) —
    // a content-rich page with an invisible captcha won't trip this
    if (fullText.trim().length < 600 &&
        document.querySelector("iframe[src*='hcaptcha'], iframe[src*='recaptcha'], iframe[src*='geetest'], iframe[title*='captcha' i], iframe[title*='challenge' i]")) return true;

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

  data;
})();
