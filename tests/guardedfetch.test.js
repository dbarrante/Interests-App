// Direct tests for core/guardedfetch.js — the ONE SSRF-guarded fetch transport that replaced
// the three copies in linkcheck/contentcheck/capturemeta. Real fetch against a local
// http.createServer on 127.0.0.1 where possible; a fetch stub for the redirect/SSRF cases
// (following into a real just-closed local port crashes undici on Windows exit, and real DNS
// is forbidden in tests). DNS is stubbed via linkcheck._setLookup so "public.example" resolves
// to a public IP without touching the resolver. No real network.
const assert = require("assert");
const http = require("http");
const gf = require("../core/guardedfetch");
const lc = require("../core/linkcheck");
let passed = 0, failed = 0;
function t(n, fn){ return Promise.resolve().then(fn).then(()=>{passed++;}).catch(e=>{failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); }); }
function listen(handler){ return new Promise(r=>{ const s=http.createServer(handler); s.listen(0,"127.0.0.1",()=>r({s,port:s.address().port})); }); }

(async () => {
  lc._setLookup(async () => [{ address: "93.184.216.34", family: 4 }]);
  const { s, port } = await listen((req, res) => {
    if (req.url === "/ok")    { res.statusCode = 200; res.end("hello world"); return; }
    if (req.url === "/big")   { res.statusCode = 200; res.end("Z".repeat(5000)); return; }
    if (req.url === "/gone")  { res.statusCode = 404; res.end("nope"); return; }
    res.statusCode = 200; res.end("x");
  });
  const base = "http://127.0.0.1:" + port;

  // --- fetchOnceGuarded: live server, real fetch ---
  await t("fetchOnceGuarded: 200 returns status + buffer body", async () => {
    const r = await gf.fetchOnceGuarded(base + "/ok", { timeoutMs: 3000 });
    assert.strictEqual(r.status, 200);
    assert.ok(Buffer.isBuffer(r.buffer));
    assert.strictEqual(r.buffer.toString("utf8"), "hello world");
    assert.strictEqual(r.error, null);
  });

  await t("fetchOnceGuarded: readBody:false skips the body (probe path)", async () => {
    const r = await gf.fetchOnceGuarded(base + "/ok", { timeoutMs: 3000, readBody: false });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.buffer, null);
  });

  await t("fetchOnceGuarded: body cap honored (bounded to maxBytes)", async () => {
    const r = await gf.fetchOnceGuarded(base + "/big", { timeoutMs: 3000, maxBytes: 100 });
    assert.strictEqual(r.status, 200);
    assert.ok(r.buffer.length <= 100, "buffer capped at 100, got " + r.buffer.length);
  });

  // --- drainCapped: drains an over-cap stream instead of cancelling (undici crash guard) ---
  await t("drainCapped: reads every chunk to completion (drain) and never cancels", async () => {
    const enc = new TextEncoder();
    const parts = []; for (let k = 0; k < 5; k++) parts.push(enc.encode("X".repeat(80))); // 400 bytes total
    let idx = 0, cancelled = false, reads = 0;
    const res = { body: new ReadableStream({
      pull(c){ if (idx < parts.length) { reads++; c.enqueue(parts[idx++]); } else c.close(); },
      cancel(){ cancelled = true; }
    }) };
    const buf = await gf.drainCapped(res, 100);
    assert.ok(buf.length <= 100, "kept bounded to 100, got " + buf.length);
    assert.strictEqual(cancelled, false, "must drain, not cancel (cancel pauses undici parser -> crash on socket end)");
    assert.strictEqual(reads, parts.length, "should read every chunk, got " + reads);
  });

  await t("drainCapped: arrayBuffer fallback (stub without a stream)", async () => {
    const res = { arrayBuffer: async () => new Uint8Array([1,2,3,4,5]).buffer };
    const buf = await gf.drainCapped(res, 3);
    assert.strictEqual(buf.length, 3);
  });

  await t("drainCapped: text fallback (stub without stream/arrayBuffer)", async () => {
    const res = { text: async () => "abcdef" };
    const buf = await gf.drainCapped(res, 4);
    assert.strictEqual(buf.toString("utf8"), "abcd");
  });

  // --- followRedirects: per-hop SSRF guard ---
  await t("followRedirects: follows a chain on a PUBLIC host to its terminal response", async () => {
    const real = global.fetch;
    global.fetch = async (u) => /\/start/.test(String(u))
      ? { status: 301, url: String(u), headers: { get: (h) => h === "location" ? "http://public.example/final" : null } }
      : { status: 200, url: String(u), headers: { get: () => null }, text: async () => "final page" };
    try {
      const walk = await gf.followRedirects("http://public.example/start", { timeoutMs: 1000 });
      assert.strictEqual(walk.stopReason, "terminal");
      assert.strictEqual(walk.result.status, 200);
      assert.strictEqual(walk.current, "http://public.example/final");
    } finally { global.fetch = real; }
  });

  await t("followRedirects: REFUSES a hop to a blocked (internal) address — SSRF, reports the 3xx", async () => {
    const real = global.fetch;
    // First hop 302s to the cloud-metadata address (169.254.169.254) which safeToFetch rejects.
    global.fetch = async () => ({ status: 302, url: "http://public.example/start",
      headers: { get: (h) => h === "location" ? "http://169.254.169.254/latest/meta-data/" : null } });
    try {
      const walk = await gf.followRedirects("http://public.example/start", { timeoutMs: 1000 });
      assert.strictEqual(walk.stopReason, "blocked", "must not follow into the internal host");
      assert.strictEqual(walk.result.status, 302, "reports the last 3xx, does not follow");
    } finally { global.fetch = real; }
  });

  await t("followRedirects: an explicit safeToFetch override rejecting the next hop is honored", async () => {
    const real = global.fetch;
    global.fetch = async () => ({ status: 302, url: "http://public.example/a",
      headers: { get: (h) => h === "location" ? "http://public.example/b" : null } });
    try {
      let asked = [];
      const walk = await gf.followRedirects("http://public.example/a", {
        timeoutMs: 1000, safeToFetch: async (u) => { asked.push(u); return false; }
      });
      assert.strictEqual(walk.stopReason, "blocked");
      assert.deepStrictEqual(asked, ["http://public.example/b"], "guard runs on the NEXT hop before fetching it");
    } finally { global.fetch = real; }
  });

  await t("followRedirects: maxhops on a redirect loop -> stopReason maxhops", async () => {
    const real = global.fetch;
    global.fetch = async (u) => ({ status: 302, url: String(u),
      headers: { get: (h) => h === "location" ? "http://public.example/loop?x=" + Math.random() : null } });
    try {
      const walk = await gf.followRedirects("http://public.example/loop", { timeoutMs: 1000, maxRedirects: 3 });
      assert.strictEqual(walk.stopReason, "maxhops");
      assert.strictEqual(walk.hop, 3);
    } finally { global.fetch = real; }
  });

  // --- timeout aborts ---
  await t("fetchOnceGuarded: a slow response aborts at the timeout (error surfaced)", async () => {
    const real = global.fetch;
    global.fetch = async (u, o) => new Promise((resolve, reject) => {
      o.signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); });
    });
    try {
      const r = await gf.fetchOnceGuarded("http://public.example/slow", { timeoutMs: 30 });
      assert.strictEqual(r.status, 0);
      assert.ok(r.error && r.error.name === "AbortError", "timeout should surface an AbortError");
    } finally { global.fetch = real; }
  });

  // --- runPool ---
  await t("runPool: results placed by index, bounded concurrency, never exceeds cap", async () => {
    const items = [1,2,3,4,5,6,7];
    let inFlight = 0, maxSeen = 0;
    const out = await gf.runPool(items, 3, async (n) => {
      inFlight++; maxSeen = Math.max(maxSeen, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return n * 10;
    });
    assert.deepStrictEqual(out, [10,20,30,40,50,60,70]);
    assert.ok(maxSeen <= 3, "concurrency should never exceed 3, saw " + maxSeen);
  });

  await t("runPool: empty / non-array input -> empty results", async () => {
    assert.deepStrictEqual(await gf.runPool([], 4, async () => 1), []);
    assert.deepStrictEqual(await gf.runPool(null, 4, async () => 1), []);
  });

  await new Promise(r => s.close(r));
  lc._setLookup(null);
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
