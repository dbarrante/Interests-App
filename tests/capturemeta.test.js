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

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
