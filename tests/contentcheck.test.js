const assert = require("assert");
const cc = require("../core/contentcheck");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("extractTitle pulls <title> and trims", () => {
  assert.strictEqual(cc.extractTitle("<html><head><title>  Hello World </title></head>"), "Hello World");
});
t("extractTitle returns '' when absent", () => {
  assert.strictEqual(cc.extractTitle("<html><body>no title</body></html>"), "");
});
t("extractText strips tags+scripts and collapses whitespace", () => {
  const html = "<style>.x{}</style><script>var a=1;</script><p>Hello   <b>there</b></p>";
  assert.strictEqual(cc.extractText(html), "Hello there");
});
t("extractText truncates to maxChars", () => {
  assert.strictEqual(cc.extractText("<p>"+"a".repeat(100)+"</p>", 10).length, 10);
});
t("classifyContent: dead phrase in title -> suspect", () => {
  const r = cc.classifyContent({ originalUrl:"https://x.com/p/1", finalUrl:"https://x.com/p/1", status:200, title:"Page Not Found", text:"whatever content here is fine" });
  assert.strictEqual(r.verdict, "suspect");
  assert.ok(r.signals.some(s => s.indexOf("phrase:") === 0));
});
t("classifyContent: deep path redirected to homepage -> suspect", () => {
  const r = cc.classifyContent({ originalUrl:"https://shop.com/item/12345", finalUrl:"https://shop.com/", status:200, title:"Shop Home", text:"Welcome to our store, browse categories and deals all day long." });
  assert.strictEqual(r.verdict, "suspect");
  assert.ok(r.signals.indexOf("redirect-home") >= 0);
});
t("classifyContent: near-empty body -> suspect", () => {
  const r = cc.classifyContent({ originalUrl:"https://x.com/a", finalUrl:"https://x.com/a", status:200, title:"", text:"  " });
  assert.strictEqual(r.verdict, "suspect");
  assert.ok(r.signals.indexOf("empty") >= 0);
});
t("classifyContent: creative not-found titles -> suspect (real-world: makezine's custom 404)", () => {
  // makezine.com serves HTTP 200 for missing articles with this title and a content-stuffed
  // body (nav/promos), which slipped both the phrase list and the old 1500-char text cap —
  // the feed then showed an mshots screenshot OF the 404 page (reported 2026-07-03).
  const r = cc.classifyContent({ originalUrl:"https://makezine.com/2023/08/x/", finalUrl:"https://makezine.com/2023/08/x/", status:200,
    title:"This is not the page you’re looking for... | Make: DIY Projects", text:"lots of nav text and shop promos ".repeat(5) });
  assert.strictEqual(r.verdict, "suspect");
  assert.ok(r.signals.some(s => s.indexOf("phrase:") === 0));
});
t("extractText default cap is >= 4000 so dead phrases deep in content-stuffed 404 pages are seen", () => {
  const html = "<p>" + "filler content words here ".repeat(80) + " Sorry Page not found</p>";  // phrase lands past 1500 chars
  assert.ok(cc.extractText(html).indexOf("Sorry Page not found") >= 0, "phrase beyond 1500 chars must survive the default cap");
});
t("classifyContent: HTML-ENTITY apostrophes in the title still match dead phrases (live makezine bug)", () => {
  // The live page serves the apostrophe as &#039; — the 1.10.3 phrase fix missed it because
  // nothing decoded entities before matching (verified against the RUNNING service 2026-07-03:
  // verdict came back likely-alive with title "This is not the page you&#039;re looking for...").
  const r = cc.classifyContent({ originalUrl:"https://makezine.com/2023/08/x/", finalUrl:"https://makezine.com/2023/08/x/", status:200,
    title:"This is not the page you&#039;re looking for... | Make: DIY", text:"nav text and shop promos ".repeat(6) });
  assert.strictEqual(r.verdict, "suspect");
  assert.ok(r.signals.some(s => s.indexOf("phrase:") === 0));
});
t("extractTitle decodes common HTML entities", () => {
  assert.strictEqual(cc.extractTitle("<title>You&#039;re here &amp; now &#x2019;ok&#x2019;</title>"), "You're here & now ’ok’");
});
t("classifyContent: bot-challenge pages get a 'challenge' signal but stay likely-alive (not dropped)", () => {
  // 403 + "Just a moment..." (Cloudflare) — the page may be fine for a real browser, so the feed
  // must KEEP the item; the signal exists so callers suppress the screenshot-proxy image (which
  // would otherwise show the challenge page as the card picture).
  const r = cc.classifyContent({ originalUrl:"https://x.com/a", finalUrl:"https://x.com/a", status:403,
    title:"Just a moment...", text:"Verifying you are human. This may take a few seconds. ".repeat(2) });
  assert.strictEqual(r.verdict, "likely-alive", "challenge is NOT dead");
  assert.ok(r.signals.indexOf("challenge") >= 0, "carries the challenge signal");
});
t("classifyContent: normal page -> likely-alive", () => {
  const r = cc.classifyContent({ originalUrl:"https://blog.com/post/good", finalUrl:"https://blog.com/post/good", status:200, title:"How to bake bread", text:"A long and useful article about baking sourdough bread at home with tips." });
  assert.strictEqual(r.verdict, "likely-alive");
  assert.strictEqual(r.signals.length, 0);
});
t("classifyContent: homepage->homepage is NOT redirect-home (no deep path)", () => {
  const r = cc.classifyContent({ originalUrl:"https://x.com/", finalUrl:"https://x.com/", status:200, title:"Home", text:"Welcome to the homepage with plenty of normal looking content here." });
  assert.strictEqual(r.signals.indexOf("redirect-home"), -1);
});
t("classifyContent: cross-domain redirect does NOT fire redirect-home", () => {
  const r = cc.classifyContent({originalUrl:"https://shop.com/item/1", finalUrl:"https://other.com/", status:200, title:"Other Home", text:"a totally different site homepage with lots of normal content here today"});
  assert.strictEqual(r.signals.indexOf("redirect-home"), -1);
});
t("classifyContent: curly-apostrophe dead phrase is matched (\\u2019 normalized to straight)", () => {
  // Real curly right-single-quote via \u escape so the test source is unambiguous.
  const r = cc.classifyContent({originalUrl:"https://x.com/p", finalUrl:"https://x.com/p", status:200, title:"This isn’t available", text:"some other text that is long enough to not be empty at all here"});
  assert.strictEqual(r.verdict, "suspect");
  assert.ok(r.signals.some(s => s.indexOf("phrase:") === 0));
});
t("DEAD_PHRASES is exported and non-empty", () => {
  assert.ok(Array.isArray(cc.DEAD_PHRASES));
  assert.ok(cc.DEAD_PHRASES.length > 0);
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
