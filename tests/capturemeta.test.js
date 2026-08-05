const assert = require("assert");
const cm = require("../core/capturemeta");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("extractOg pulls og:image/og:title/og:description", () => {
  const r = cm.extractOg('<meta property="og:image" content="https://x.com/a.jpg"><meta property="og:title" content="Hi"><meta property="og:description" content="desc">');
  assert.strictEqual(r.image, "https://x.com/a.jpg");
  assert.strictEqual(r.title, "Hi");
  assert.strictEqual(r.description, "desc");
});
t("extractOg tolerates reversed attribute order (content before property)", () => {
  const r = cm.extractOg('<meta content="https://x.com/b.png" property="og:image">');
  assert.strictEqual(r.image, "https://x.com/b.png");
});
t("extractOg falls back: twitter:image, then link image_src", () => {
  assert.strictEqual(cm.extractOg('<meta name="twitter:image" content="https://x/t.jpg">').image, "https://x/t.jpg");
  assert.strictEqual(cm.extractOg('<link rel="image_src" href="https://x/l.jpg">').image, "https://x/l.jpg");
});
t("extractOg title falls back to <title>; description to meta name=description", () => {
  const r = cm.extractOg('<title>  Page Title </title><meta name="description" content="d2">');
  assert.strictEqual(r.title, "Page Title");
  assert.strictEqual(r.description, "d2");
});
t("extractOg empty when nothing present", () => {
  assert.deepStrictEqual(cm.extractOg("<html><body>nothing</body></html>"), { image:"", title:"", description:"" });
  assert.deepStrictEqual(cm.extractOg(null), { image:"", title:"", description:"" });
});

t("extractArticleExcerpt joins <p> tag text and strips inner tags", () => {
  const html = "<html><body><nav>Menu Home About</nav>" +
    "<p>This is the <b>first</b> real paragraph of the article, long enough to count as real content for grounding purposes here.</p>" +
    "<p>And a second paragraph continuing the same thought with more real substance about the actual topic.</p>" +
    "</body></html>";
  const r = cm.extractArticleExcerpt(html);
  assert.ok(r.indexOf("first real paragraph") >= 0, "should include first <p> text: " + r);
  assert.ok(r.indexOf("second paragraph") >= 0, "should include second <p> text: " + r);
  assert.ok(r.indexOf("<b>") === -1, "inner tags must be stripped");
  assert.ok(r.indexOf("Menu Home About") === -1, "must prefer <p> text over nav chrome when <p> content is substantial");
});
t("extractArticleExcerpt falls back to whole-page text when there's little/no <p> content", () => {
  const html = "<html><body><div>Real article text with no paragraph tags at all, just a div wrapping everything the page actually says about its topic.</div></body></html>";
  const r = cm.extractArticleExcerpt(html);
  assert.ok(r.indexOf("Real article text") >= 0, "should fall back to contentcheck.extractText: " + r);
});
t("extractArticleExcerpt falls back to whole-page text when <p> tags exist but joined text is under 200 chars", () => {
  const html = "<html><body><nav>Navigation</nav><p>Short</p><footer>Footer text</footer><div>Longer article body with more context that provides real content about the topic.</div></body></html>";
  const r = cm.extractArticleExcerpt(html);
  // The <p> text "Short" is only 5 chars, well under 200 threshold, so it should fall back to contentcheck.extractText
  // which extracts the full page text including the footer and body
  assert.ok(r.length > 50, "should use full-page fallback: " + r);
  assert.ok(r.indexOf("article") >= 0 || r.indexOf("content") >= 0, "should include body/div text from fallback: " + r);
});
t("extractArticleExcerpt skips pathological unterminated-<p> tags without scanning (fast fallback)", () => {
  // A page with many open <p tags but few closes -- the regex would degrade to O(n²)
  // if we tried to scan it. The pathology guard should detect this and fall back to
  // contentcheck.extractText (fast, linear) without even attempting the <p> regex.
  const html = "<p><p><p><p><p><p><p><p><p><p><p><p><p><p><p><p><p><p><p><p><p><p><p><p>" +
    "This is the actual article text that the pathology guard allows to be extracted via fallback. " +
    "</p>";
  const start = Date.now();
  const r = cm.extractArticleExcerpt(html);
  const elapsed = Date.now() - start;
  // Should resolve in milliseconds (contentcheck.extractText is O(n)), not seconds (regex scan is O(n²))
  assert.ok(elapsed < 100, "pathology guard should make this sub-100ms; got " + elapsed + "ms");
  assert.ok(r.indexOf("actual article text") >= 0, "should fall back to full-page extraction: " + r);
});
t("extractArticleExcerpt handles real Wikipedia-shaped article with substantial content past early nav", () => {
  // A realistic page: nav chrome at the start (~45KB worth), then actual article body in <p> tags.
  // With the 50KB input truncation, this would cut off real <p> content. With the
  // pathology guard (which doesn't truncate), it should find the article paragraphs.
  // Use a nav simulation that pushes past but not past 300KB outer bound.
  var html = "<html><body><nav>";
  for (var i = 0; i < 1500; i++) html += "<li>Menu item</li>";  // ~45KB of nav
  html += "</nav>" +
    "<p>First paragraph of the real article with substantial content to extract as grounding.</p>" +
    "<p>Second paragraph continuing the discussion with more details and context.</p>" +
    "<p>Third paragraph completing the thought with additional information and analysis.</p>" +
    "</body></html>";
  const r = cm.extractArticleExcerpt(html);
  assert.ok(r.indexOf("First paragraph") >= 0, "should extract the real article <p> content, not nav");
  assert.ok(r.indexOf("Menu item") === -1, "should not include nav chrome");
});
t("extractArticleExcerpt caps at 1500 chars", () => {
  const html = "<p>" + "word ".repeat(2000) + "</p>";
  const r = cm.extractArticleExcerpt(html);
  assert.ok(r.length <= 1500, "got length " + r.length);
});
t("extractArticleExcerpt empty for empty/null input", () => {
  assert.strictEqual(cm.extractArticleExcerpt(""), "");
  assert.strictEqual(cm.extractArticleExcerpt(null), "");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
