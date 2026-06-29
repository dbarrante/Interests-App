// SSRF hardening: (1) DNS-rebinding — a public-looking hostname that RESOLVES to a
// private/loopback/link-local IP must never be fetched, on the initial url and on every
// redirect hop. (2) Non-dotted IPv4 literals (bare-integer / octal / hex) must never be
// treated as public. No real network: dns.lookup is injected as a stub everywhere.
const assert = require("assert");
const lc = require("../core/linkcheck");
const cc = require("../core/contentcheck");
let passed = 0, failed = 0;
function t(n, fn){ return Promise.resolve().then(fn).then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); }); }

// Build a stub matching dns.promises.lookup(host, {all:true}) -> [{address,family}].
function lookupReturning(map) {
  return async (host) => {
    if (!(host in map)) { const e = new Error("ENOTFOUND " + host); e.code = "ENOTFOUND"; throw e; }
    return map[host].map(a => ({ address: a, family: a.indexOf(":") >= 0 ? 6 : 4 }));
  };
}

(async () => {
  // ---- isPrivateAddr (pure IP classifier) ----
  await t("isPrivateAddr: flags loopback/private/link-local v4 + v6", () => {
    ["127.0.0.1","10.1.2.3","172.16.0.1","172.31.9.9","192.168.0.5","169.254.10.10","0.0.0.0",
     "::1","::","fe80::1","fc00::1","fd12:3456::1","fec0::1","::ffff:127.0.0.1"].forEach(ip =>
      assert.strictEqual(lc.isPrivateAddr(ip), true, ip));
  });
  await t("isPrivateAddr: passes genuine public v4 + v6", () => {
    ["8.8.8.8","1.1.1.1","172.32.0.1","172.15.0.1","93.184.216.34","2606:4700:4700::1111"].forEach(ip =>
      assert.strictEqual(lc.isPrivateAddr(ip), false, ip));
  });

  // ---- isProbableHost: gap #2 (non-dotted IPv4 literals) rejected end-to-end ----
  await t("isProbableHost: rejects bare-integer / octal / hex IPv4 literals", () => {
    ["http://2130706433/","http://0x7f000001/","http://017700000001/","http://2852039166/","http://0x7f.0.0.1/"]
      .forEach(u => assert.strictEqual(lc.isProbableHost(u), false, u));
  });

  // ---- safeToFetch: positively blocks ONLY a host that resolves to a private IP ----
  await t("safeToFetch: domain resolving to a private IP is blocked (DNS rebinding)", async () => {
    const lookup = lookupReturning({ "evil.example": ["127.0.0.1"] });
    assert.strictEqual(await lc.safeToFetch("http://evil.example/x", { lookup }), false);
  });
  await t("safeToFetch: domain resolving to a public IP is allowed", async () => {
    const lookup = lookupReturning({ "good.example": ["93.184.216.34"] });
    assert.strictEqual(await lc.safeToFetch("http://good.example/x", { lookup }), true);
  });
  await t("safeToFetch: ANY private address among the resolved set blocks", async () => {
    const lookup = lookupReturning({ "mixed.example": ["93.184.216.34","10.0.0.1"] });
    assert.strictEqual(await lc.safeToFetch("http://mixed.example/x", { lookup }), false);
  });
  await t("safeToFetch: a literal public IP needs no DNS and is allowed", async () => {
    let called = false; const lookup = async () => { called = true; return []; };
    assert.strictEqual(await lc.safeToFetch("https://8.8.8.8/", { lookup }), true);
    assert.strictEqual(called, false, "must not resolve a literal IP");
  });
  await t("safeToFetch: a literal private IP is blocked without DNS", async () => {
    let called = false; const lookup = async () => { called = true; return []; };
    assert.strictEqual(await lc.safeToFetch("http://127.0.0.1/", { lookup }), false);
    assert.strictEqual(called, false);
  });
  await t("safeToFetch: an unresolvable domain is NOT blocked (lets fetch surface the real error -> dead)", async () => {
    const lookup = lookupReturning({}); // every host throws ENOTFOUND
    assert.strictEqual(await lc.safeToFetch("http://gone.example/x", { lookup }), true);
  });

  // ---- probeUrl: refuses to FOLLOW a redirect into a rebinding host ----
  await t("probeUrl: a 30x to a domain that resolves private is NOT followed (reports 3xx, not dead)", async () => {
    const realFetch = global.fetch;
    global.fetch = async (u) => /\/start/.test(String(u))
      ? { status: 302, headers: { get: (h) => h === "location" ? "http://internal.example/secret" : null } }
      : { status: 404, headers: { get: () => null } };
    const lookup = lookupReturning({ "internal.example": ["10.0.0.7"] });
    try {
      const r = await lc.probeUrl("http://public.example/start", { timeoutMs: 1000, lookup });
      assert.strictEqual(r.status, 302, "did not follow into the rebinding host");
      assert.notStrictEqual(lc.classify(r.status, r.code), "dead");
    } finally { global.fetch = realFetch; }
  });

  // ---- checkChunk: an initial url whose host resolves private is skipped (no fetch) ----
  await t("checkChunk: a domain that resolves to a private IP is skipped without a request", async () => {
    const realFetch = global.fetch;
    let fetched = false; global.fetch = async () => { fetched = true; return { status: 200, headers: { get: () => null } }; };
    const lookup = lookupReturning({ "rebind.example": ["192.168.1.50"] });
    try {
      const r = await lc.checkChunk([{ id: "rb", url: "http://rebind.example/x" }], { concurrency: 1, timeoutMs: 1000, lookup });
      assert.strictEqual(r[0].status, "skipped");
      assert.strictEqual(fetched, false, "must not fetch a rebinding host");
    } finally { global.fetch = realFetch; }
  });

  // ---- contentcheck reuses the same guard ----
  await t("fetchContent: a domain that resolves private is not fetched", async () => {
    const realFetch = global.fetch;
    let fetched = false; global.fetch = async () => { fetched = true; return { status: 200, url: "x", headers: { get: () => null }, text: async () => "x" }; };
    const lookup = lookupReturning({ "rebind.example": ["127.0.0.1"] });
    try {
      const r = await cc.fetchContent("http://rebind.example/x", { lookup });
      assert.strictEqual(fetched, false, "must not fetch a rebinding host");
      assert.strictEqual(r.status, 0);
    } finally { global.fetch = realFetch; }
  });
  await t("checkContentChunk: a rebinding domain is skipped", async () => {
    const realFetch = global.fetch;
    let fetched = false; global.fetch = async () => { fetched = true; return { status: 200, url: "x", headers: { get: () => null }, text: async () => "x" }; };
    const lookup = lookupReturning({ "rebind.example": ["10.0.0.1"] });
    try {
      const out = await cc.checkContentChunk([{ id: "rb", url: "http://rebind.example/x" }], { lookup });
      assert.strictEqual(out[0].verdict, "skipped");
      assert.strictEqual(fetched, false);
    } finally { global.fetch = realFetch; }
  });

  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
