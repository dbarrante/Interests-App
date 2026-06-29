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
t("classifyContent: normal page -> likely-alive", () => {
  const r = cc.classifyContent({ originalUrl:"https://blog.com/post/good", finalUrl:"https://blog.com/post/good", status:200, title:"How to bake bread", text:"A long and useful article about baking sourdough bread at home with tips." });
  assert.strictEqual(r.verdict, "likely-alive");
  assert.strictEqual(r.signals.length, 0);
});
t("classifyContent: homepage->homepage is NOT redirect-home (no deep path)", () => {
  const r = cc.classifyContent({ originalUrl:"https://x.com/", finalUrl:"https://x.com/", status:200, title:"Home", text:"Welcome to the homepage with plenty of normal looking content here." });
  assert.strictEqual(r.signals.indexOf("redirect-home"), -1);
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
