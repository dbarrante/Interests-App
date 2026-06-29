const assert = require("assert");
const sb = require("../core/safebrowse");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("buildLookupBody sets the 4 threat types + URL entries", () => {
  const b = sb.buildLookupBody(["http://a.test/", "http://b.test/"]);
  assert.deepStrictEqual(b.threatInfo.threatTypes, ["MALWARE","SOCIAL_ENGINEERING","UNWANTED_SOFTWARE","POTENTIALLY_HARMFUL_APPLICATION"]);
  assert.deepStrictEqual(b.threatInfo.platformTypes, ["ANY_PLATFORM"]);
  assert.deepStrictEqual(b.threatInfo.threatEntryTypes, ["URL"]);
  assert.deepStrictEqual(b.threatInfo.threatEntries, [{url:"http://a.test/"},{url:"http://b.test/"}]);
  assert.ok(b.client && b.client.clientId);
});
t("buildLookupBody tolerates non-array", () => {
  assert.deepStrictEqual(sb.buildLookupBody(null).threatInfo.threatEntries, []);
});
t("parseLookupResponse maps matched url -> threatType", () => {
  const m = sb.parseLookupResponse({ matches:[
    { threatType:"MALWARE", threat:{url:"http://bad.test/"} },
    { threatType:"SOCIAL_ENGINEERING", threat:{url:"http://phish.test/"} }
  ]});
  assert.strictEqual(m["http://bad.test/"], "MALWARE");
  assert.strictEqual(m["http://phish.test/"], "SOCIAL_ENGINEERING");
});
t("parseLookupResponse on no matches -> {}", () => {
  assert.deepStrictEqual(sb.parseLookupResponse({}), {});
  assert.deepStrictEqual(sb.parseLookupResponse({matches:[]}), {});
  assert.deepStrictEqual(sb.parseLookupResponse(null), {});
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
