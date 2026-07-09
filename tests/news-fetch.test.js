// tests/news-fetch.test.js — fetchNews tags by interest, dedupes, sorts newest-first,
// caps, and survives a single failing feed. Fetch is injected (no real network).
const assert = require("assert");
const { fetchNews } = require("../core/news.js");

let pass = 0, fail = 0;
function t(name, p) { return p.then((c) => { if (c) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }).catch((e) => { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); }); }

function feed(items) {
  return "<rss><channel>" + items.map((it) =>
    "<item><title>" + it.t + "</title><link>" + it.u + "</link><pubDate>" + it.d +
    "</pubDate><source url='http://x'>" + it.s + "</source></item>").join("") + "</channel></rss>";
}

(async () => {
  // fetchImpl keyed on the interest embedded in the query string.
  const fetchImpl = async (url) => {
    if (/woodworking/.test(url)) return feed([
      { t: "Lathe news", u: "https://a.com/1", d: "Wed, 08 Jul 2026 12:00:00 GMT", s: "A" },
      { t: "Shared story", u: "https://dup.com/x", d: "Wed, 08 Jul 2026 10:00:00 GMT", s: "A" }]);
    if (/synths/.test(url)) return feed([
      { t: "New synth", u: "https://b.com/2", d: "Wed, 08 Jul 2026 15:00:00 GMT", s: "B" },
      { t: "Shared story", u: "https://dup.com/x", d: "Wed, 08 Jul 2026 10:00:00 GMT", s: "A" }]);
    throw new Error("feed down");   // the "broken" interest
  };

  await t("tags each item with its interest", fetchNews(["woodworking"], { fetchImpl }).then((r) =>
    r.length === 2 && r.every((i) => i.interest === "woodworking")));

  await t("merges interests, dedupes shared url, sorts newest-first", fetchNews(["woodworking", "synths"], { fetchImpl }).then((r) => {
    const urls = r.map((i) => i.url);
    const uniq = new Set(urls).size === urls.length;
    const sorted = r[0].url === "https://b.com/2";   // 15:00 newest
    const dedup = urls.filter((u) => u === "https://dup.com/x").length === 1;
    return uniq && sorted && dedup;
  }));

  await t("a failing feed doesn't break the batch", fetchNews(["broken", "synths"], { fetchImpl }).then((r) =>
    r.length === 2 && r.some((i) => i.url === "https://b.com/2")));

  await t("respects the total limit", fetchNews(["woodworking", "synths"], { fetchImpl, limit: 1 }).then((r) => r.length === 1));

  await t("empty interests → []", fetchNews([], { fetchImpl }).then((r) => r.length === 0));

  console.log("news-fetch: " + pass + " passed, " + fail + " failed");
  process.exitCode = fail ? 1 : 0;
})();
