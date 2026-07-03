// Tests for web/lib/capture-state.js — truth tables per predicate. Byte-equivalent
// logic is the binding requirement (Phase-1 B8: predicate drift = bulk actions on
// the wrong cards), so these pin each state and its boundary cases.
const assert = require("assert");
const CS = require("../web/lib/capture-state.js");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.stack||e)); } }

const WEB = "https://example.com/a";      // web-proxy-capturable url
const FB  = "https://www.facebook.com/x"; // login-walled

/* ---------- isFavicon ---------- */
t("isFavicon: favicon/touch-icon urls true; a real image false", () => {
  assert.ok(CS.isFavicon("https://x.com/favicon.ico"));
  assert.ok(CS.isFavicon("https://x.com/apple-touch-icon.png"));
  assert.ok(CS.isFavicon("https://icons.duckduckgo.com/ip3/x.com.ico"));
  assert.ok(!CS.isFavicon("https://x.com/real-photo.jpg"));
  assert.ok(!CS.isFavicon(""));
});

/* ---------- isBadImg (boundary: empty vs placeholder vs http img) ---------- */
t("isBadImg: empty -> bad", () => { assert.ok(CS.isBadImg("")); assert.ok(CS.isBadImg(undefined)); });
t("isBadImg: favicon -> bad", () => { assert.ok(CS.isBadImg("https://x.com/favicon.ico")); });
t("isBadImg: mshots/thum.io/microlink/webcache placeholders -> bad", () => {
  assert.ok(CS.isBadImg("https://s0.wp.com/mshots/v1/http%3A%2F%2Fx.com"));
  assert.ok(CS.isBadImg("https://thum.io/get/x.com"));
  assert.ok(CS.isBadImg("https://api.microlink.io/?url=x"));
  assert.ok(CS.isBadImg("https://webcache.googleusercontent.com/x"));
});
t("isBadImg: a real http(s) image -> good (false)", () => {
  assert.ok(!CS.isBadImg("https://cdn.example.com/photo.jpg"));
});

/* ---------- captureable (web, not FB) ---------- */
t("captureable: web url + bad img + not capDone/blocked -> true", () => {
  assert.ok(CS.captureable({ url: WEB, img: "" }));
});
t("captureable: FB url -> false (that's the extension's job)", () => {
  assert.ok(!CS.captureable({ url: FB, img: "" }));
});
t("captureable: capDone/blocked/good-img/no-url -> false", () => {
  assert.ok(!CS.captureable({ url: WEB, img: "", capDone: true }));
  assert.ok(!CS.captureable({ url: WEB, img: "", blocked: true }));
  assert.ok(!CS.captureable({ url: WEB, img: "https://cdn/x.jpg" }));
  assert.ok(!CS.captureable({ url: "", img: "" }));
});

/* ---------- captureableFb (FB mirror) ---------- */
t("captureableFb: FB url + bad img -> true; web url -> false", () => {
  assert.ok(CS.captureableFb({ url: FB, img: "" }));
  assert.ok(!CS.captureableFb({ url: WEB, img: "" }));
});

/* ---------- needsCapture (captureable + never tried) ---------- */
t("needsCapture: never tried -> true", () => {
  assert.ok(CS.needsCapture({ url: WEB, img: "" }));
});
t("needsCapture: already tried (lastUpdate or captured) -> false", () => {
  assert.ok(!CS.needsCapture({ url: WEB, img: "", lastUpdate: 123 }));
  assert.ok(!CS.needsCapture({ url: WEB, img: "", captured: 123 }));
});

/* ---------- needsRetry (captureable + tried) ---------- */
t("needsRetry: tried but still no image -> true", () => {
  assert.ok(CS.needsRetry({ url: WEB, img: "", lastUpdate: 123 }));
  assert.ok(CS.needsRetry({ url: WEB, img: "", captured: 123 }));
});
t("needsRetry: never tried -> false", () => {
  assert.ok(!CS.needsRetry({ url: WEB, img: "" }));
});
t("needsCapture and needsRetry are mutually exclusive over captureable cards", () => {
  const tried = { url: WEB, img: "", lastUpdate: 1 };
  const fresh = { url: WEB, img: "" };
  assert.ok(CS.needsRetry(tried) && !CS.needsCapture(tried));
  assert.ok(CS.needsCapture(fresh) && !CS.needsRetry(fresh));
});

/* ---------- needsFbCapture ---------- */
t("needsFbCapture: FB + bad img + never tried -> true", () => {
  assert.ok(CS.needsFbCapture({ url: FB, img: "" }));
});
t("needsFbCapture: FB tried -> false; web url -> false", () => {
  assert.ok(!CS.needsFbCapture({ url: FB, img: "", lastUpdate: 1 }));
  assert.ok(!CS.needsFbCapture({ url: WEB, img: "" }));
});

/* ---------- fbMiss ---------- */
t("fbMiss: FB card that tried (fail/lastUpdate/captured) and still no image -> true", () => {
  assert.ok(CS.fbMiss({ url: FB, img: "", lastResult: "fail" }));
  assert.ok(CS.fbMiss({ url: FB, img: "", lastUpdate: 1 }));
  assert.ok(CS.fbMiss({ url: FB, img: "", captured: 1 }));
});
t("fbMiss: FB card never tried -> false; web card -> false; good img -> false", () => {
  assert.ok(!CS.fbMiss({ url: FB, img: "" }));
  assert.ok(!CS.fbMiss({ url: WEB, img: "", lastUpdate: 1 }));
  assert.ok(!CS.fbMiss({ url: FB, img: "https://cdn/x.jpg", lastUpdate: 1 }));
});

console.log("capture-state.test.js: " + passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
