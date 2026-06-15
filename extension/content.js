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

  const data = {
    title: getMeta(["og:title", "twitter:title"]) || document.title || "",
    desc: getMeta(["og:description", "twitter:description", "description"]),
    ogImage: getMeta(["og:image", "twitter:image"]),
    contentImage: firstLargeImage(),
    url: document.location.href,
  };

  data;
})();
