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

  // detect Cloudflare / WAF block & challenge interstitials so we don't store
  // a screenshot of "Sorry, you have been blocked" as the card image
  function isBlockedPage() {
    const t = (document.title || "").toLowerCase();
    if (/just a moment|attention required|access denied|you have been blocked|are you a robot|verify you are human|security check|403 forbidden/.test(t)) return true;
    const body = ((document.body && document.body.innerText) || "").slice(0, 3000).toLowerCase();
    if (/you have been blocked|checking your browser before access|verify you are human|enable javascript and cookies to continue|complete the security check|performance & security by cloudflare/.test(body)) return true;
    if (document.querySelector("#cf-wrapper, .cf-error-code, #challenge-running, #challenge-form, #challenge-stage")) return true;
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
