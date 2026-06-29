const assert = require("assert");
const lc = require("../core/linkcheck");
let passed = 0, failed = 0;
function t(n, fn){ try{ fn(); passed++; }catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("classify: definitive-dead HTTP statuses", () => {
  [404,410,451].forEach(s => assert.strictEqual(lc.classify(s, null), "dead", "status "+s));
});
t("classify: definitive-dead error codes", () => {
  ["ENOTFOUND","ECONNREFUSED","ERR_NAME_NOT_RESOLVED"].forEach(c => assert.strictEqual(lc.classify(0, c), "dead", "code "+c));
});
t("classify: 2xx/3xx are alive", () => {
  [200,204,301,302,308,399].forEach(s => assert.strictEqual(lc.classify(s, null), "alive", "status "+s));
});
t("classify: ambiguous statuses/codes are unknown (never dead)", () => {
  [401,403,429,500,503,0].forEach(s => assert.strictEqual(lc.classify(s, null), "unknown", "status "+s));
  ["ETIMEDOUT","ECONNRESET","EAI_AGAIN","CERT_HAS_EXPIRED","ERR"].forEach(c => assert.strictEqual(lc.classify(0, c), "unknown", "code "+c));
});
t("isSkippedHost: social hosts + subdomains skipped, others not", () => {
  ["https://www.instagram.com/p/x/","https://facebook.com/y","https://m.facebook.com/z","https://fb.watch/a","https://youtube.com/watch?v=1","https://youtu.be/2","https://www.threads.net/@u"].forEach(u => assert.strictEqual(lc.isSkippedHost(u), true, u));
  ["https://www.pinterest.com/pin/1/","https://example.com/a","https://notinstagram.com.evil.com/"].forEach(u => assert.strictEqual(lc.isSkippedHost(u), false, u));
});
t("isSkippedHost: a custom skip-list is honored", () => {
  assert.strictEqual(lc.isSkippedHost("https://foo.com/x", ["foo.com"]), true);
  assert.strictEqual(lc.isSkippedHost("https://bar.com/x", ["foo.com"]), false);
});
t("isProbableHost: rejects non-http(s), localhost, private/loopback/link-local, .local", () => {
  ["ftp://example.com","javascript:alert(1)","http://localhost/x","https://localhost:3456/api","http://127.0.0.1/","http://127.5.5.5/","http://10.0.0.1/","http://172.16.0.1/","http://172.31.255.1/","http://192.168.1.1/","http://169.254.1.1/","http://[::1]/","https://printer.local/","http://0.0.0.0/"].forEach(u => assert.strictEqual(lc.isProbableHost(u), false, u));
});
t("isProbableHost: allows public http(s) hosts (incl. public IPs and 172.x outside private range)", () => {
  ["http://example.com/","https://www.recipes.example/x","https://8.8.8.8/","http://172.32.0.1/","http://172.15.0.1/"].forEach(u => assert.strictEqual(lc.isProbableHost(u), true, u));
});
t("isProbableHost / isSkippedHost: garbage input does not throw", () => {
  ["", null, undefined, "not a url", "http://"].forEach(v => { lc.isProbableHost(v); lc.isSkippedHost(v); });
  assert.ok(true);
});

console.log(passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
