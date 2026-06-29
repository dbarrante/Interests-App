const assert = require("assert");
const sb = require("../core/safebrowse");
let passed = 0, failed = 0;
function t(n, fn){ return Promise.resolve().then(fn).then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message));}); }

(async () => {
  const realFetch = global.fetch;

  await t("flags bad url, leaves clean url null", async () => {
    global.fetch = async () => ({ ok:true, json: async () => ({ matches:[{ threatType:"MALWARE", threat:{url:"http://bad.test/"} }] }) });
    const r = await sb.checkUrls(["http://bad.test/","http://good.test/"], "KEY");
    const by = {}; r.forEach(x => by[x.url] = x);
    assert.strictEqual(by["http://bad.test/"].threat, "MALWARE");
    assert.strictEqual(by["http://good.test/"].threat, null);
  });

  await t("HTTP error -> fail-open (threat null, error true)", async () => {
    global.fetch = async () => ({ ok:false, status:429, json: async () => ({}) });
    const r = await sb.checkUrls(["http://x.test/"], "KEY");
    assert.strictEqual(r[0].threat, null);
    assert.strictEqual(r[0].error, true);
  });

  await t("network throw -> fail-open", async () => {
    global.fetch = async () => { throw new Error("boom"); };
    const r = await sb.checkUrls(["http://y.test/"], "KEY");
    assert.strictEqual(r[0].threat, null);
    assert.strictEqual(r[0].error, true);
  });

  await t("batches >500 urls into multiple calls", async () => {
    let calls = 0;
    global.fetch = async () => { calls++; return { ok:true, json: async () => ({}) }; };
    const many = []; for (let i=0;i<1100;i++) many.push("http://u"+i+".test/");
    const r = await sb.checkUrls(many, "KEY");
    assert.strictEqual(r.length, 1100);
    assert.strictEqual(calls, 3, "1100/500 -> 3 batches, got "+calls);
  });

  global.fetch = realFetch;
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
