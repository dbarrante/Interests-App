// tests/pwa-oauth-authretry.test.js — the 'Dropbox keeps disconnecting' fix.
// A 401 mid-cycle used to disconnect() immediately (wiping the refresh token)
// even though the refresh token was valid — e.g. iOS suspends the PWA mid-sync
// and resumes after the 4h access token died. Now: fresh token resolved per
// call, one shared refresh + one retry on 401, and only a fresh-token 401 is
// treated as definitive. Functional tests eval the extracted functions with
// shimmed localStorage (direct-eval closure capture, same technique as
// tests/pwa-oauth-classify.test.js).
const assert = require("assert");
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "pwa", "oauth.js"), "utf8");

function grab(source, name) {
  let idx = source.indexOf("async function " + name + "(");
  if (idx < 0) idx = source.indexOf("function " + name + "(");
  if (idx < 0) throw new Error("not found: " + name);
  const open = source.indexOf("{", idx);
  let depth = 0, i = open;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return source.slice(idx, i);
}

let passed = 0, failed = 0;
const tests = [];
function t(name, fn) { tests.push([name, fn]); }

// --- shims the eval'd functions close over ---
const LS_KEYS = { appKey: "ia_pwa_app_key", redirectUri: "ia_pwa_redirect_uri", accessToken: "ia_pwa_access_token", refreshToken: "ia_pwa_refresh_token", expiresAt: "ia_pwa_expires_at" };
let store = {};
const localStorage = { getItem: (k) => (k in store ? store[k] : null) };
let refreshCalls = 0, refreshImpl = async () => { refreshCalls++; return "FRESH"; };
async function sharedRefreshAccessToken(appKey) { return refreshImpl(appKey); }
let getAccessTokenCalls = 0;
async function getAccessToken(appKey) { getAccessTokenCalls++; return "RESOLVED"; }

const canRefresh = eval("(" + grab(src, "canRefresh") + ")");
const resolveToken = eval("(" + grab(src, "resolveToken") + ")");
const dbxAuthedFetch = eval("(" + grab(src, "dbxAuthedFetch") + ")");

t("canRefresh: true only with BOTH app key and refresh token stored", async () => {
  store = {}; assert.strictEqual(canRefresh(), false);
  store = { ia_pwa_app_key: "k" }; assert.strictEqual(canRefresh(), false);
  store = { ia_pwa_app_key: "k", ia_pwa_refresh_token: "r" }; assert.strictEqual(canRefresh(), true);
});

t("resolveToken: prefers live getAccessToken when refreshable; falls back to the passed token; then stored token; then AUTH_EXPIRED", async () => {
  store = { ia_pwa_app_key: "k", ia_pwa_refresh_token: "r" };
  assert.strictEqual(await resolveToken("FALLBACK"), "RESOLVED");
  store = {};
  assert.strictEqual(await resolveToken("FALLBACK"), "FALLBACK");
  store = { ia_pwa_access_token: "STORED" };
  assert.strictEqual(await resolveToken(null), "STORED");
  store = {};
  await assert.rejects(() => resolveToken(null), (e) => e.code === "AUTH_EXPIRED");
});

t("dbxAuthedFetch: 401 -> ONE shared refresh -> exactly one retry with the fresh token", async () => {
  store = { ia_pwa_app_key: "k", ia_pwa_refresh_token: "r" };
  refreshCalls = 0; refreshImpl = async () => { refreshCalls++; return "FRESH"; };
  const seen = [];
  const res = await dbxAuthedFetch(null, async (token) => {
    seen.push(token);
    return seen.length === 1 ? { status: 401 } : { status: 200, ok: true };
  });
  assert.deepStrictEqual(seen, ["RESOLVED", "FRESH"]);
  assert.strictEqual(refreshCalls, 1);
  assert.strictEqual(res.status, 200);
});

t("dbxAuthedFetch: still-401 after the retry is returned (caller's dbxError path decides), NOT retried again", async () => {
  store = { ia_pwa_app_key: "k", ia_pwa_refresh_token: "r" };
  refreshImpl = async () => "FRESH";
  let calls = 0;
  const res = await dbxAuthedFetch(null, async () => { calls++; return { status: 401 }; });
  assert.strictEqual(calls, 2, "exactly one retry");
  assert.strictEqual(res.status, 401);
});

t("dbxAuthedFetch: a transient (OTHER) refresh failure propagates without a second request", async () => {
  store = { ia_pwa_app_key: "k", ia_pwa_refresh_token: "r" };
  refreshImpl = async () => { const e = new Error("503 from token endpoint"); e.code = "OTHER"; throw e; };
  let calls = 0;
  await assert.rejects(
    () => dbxAuthedFetch(null, async () => { calls++; return { status: 401 }; }),
    (e) => e.code === "OTHER"
  );
  assert.strictEqual(calls, 1);
});

t("dbxAuthedFetch: no refresh capability -> a 401 is returned as-is (no refresh attempt)", async () => {
  store = {};
  refreshCalls = 0; refreshImpl = async () => { refreshCalls++; return "FRESH"; };
  const res = await dbxAuthedFetch("FALLBACK", async () => ({ status: 401 }));
  assert.strictEqual(res.status, 401);
  assert.strictEqual(refreshCalls, 0);
});

t("all five Dropbox entry points route through dbxAuthedFetch", () => {
  for (const fn of ["dbxApiCall", "dbxDownload", "dbxDownloadBinary", "dbxUpload", "getCurrentAccount"]) {
    const body = grab(src, fn);
    assert.ok(/dbxAuthedFetch\(/.test(body), fn + " must route through dbxAuthedFetch");
    assert.ok(/Bearer \$\{token\}/.test(body), fn + " must use the per-call resolved token, not the stale parameter");
  }
});

t("getCurrentAccount failures now classify through dbxError (it used to throw a bare Error)", () => {
  const body = grab(src, "getCurrentAccount");
  assert.ok(/throw dbxError\(res\.status/.test(body), "must throw dbxError(res.status, ...)");
  assert.ok(!/throw new Error\(/.test(body), "no bare Error");
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; }
    catch (e) { failed++; console.error("FAIL: " + name + "\n  " + (e && e.message)); }
  }
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
