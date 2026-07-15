// tests/pwa-oauth-classify.test.js — classifyDbxError() is a pure function
// with no external dependencies, so it can be extracted from pwa/oauth.js's
// source and eval'd standalone, same technique as tests/durable-cdn-image.test.js
// uses for extension/background.js (this codebase has no browser test harness).
const assert = require("assert");
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "pwa", "oauth.js"), "utf8");

function grab(source, name) {
  const idx = source.indexOf("function " + name + "(");
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
function t(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error("FAIL: " + name + "\n  " + (e && e.message)); }
}

const classifyDbxError = eval("(" + grab(src, "classifyDbxError") + ")");

t("classifyDbxError(401): AUTH_EXPIRED with a user-facing message", () => {
  const r = classifyDbxError(401);
  assert.strictEqual(r.code, "AUTH_EXPIRED");
  assert.strictEqual(typeof r.message, "string");
  assert.ok(r.message.length > 0);
});

t("classifyDbxError: 400/404/429/500 are all OTHER with no message", () => {
  for (const status of [400, 404, 429, 500]) {
    const r = classifyDbxError(status);
    assert.strictEqual(r.code, "OTHER", "status " + status);
    assert.strictEqual(r.message, null, "status " + status);
  }
});

t("dbxError: calls classifyDbxError, disconnects and tags AUTH_EXPIRED on 401", () => {
  const body = grab(src, "dbxError");
  assert.ok(body.indexOf("classifyDbxError(status)") >= 0, "must call classifyDbxError(status)");
  assert.ok(body.indexOf("disconnect()") >= 0, "must call disconnect() on the AUTH_EXPIRED path");
  assert.ok(/err\.status\s*=\s*status/.test(body), "must set err.status");
  assert.ok(/err\.code\s*=\s*info\.code/.test(body), "must set err.code from classifyDbxError's result");
});

t("every Dropbox-call throw site uses dbxError(...) instead of a bare new Error(...)", () => {
  for (const fn of ["dbxApiCall", "dbxDownload", "dbxDownloadBinary", "dbxUpload"]) {
    const body = grab(src, fn);
    assert.ok(/throw dbxError\(res\.status,/.test(body), fn + " must throw dbxError(res.status, ...)");
    assert.ok(!/throw new Error\(/.test(body), fn + " must not throw a bare Error anymore");
  }
});

t("refreshAccessToken tags a failed refresh AUTH_EXPIRED and disconnects", () => {
  const body = grab(src, "refreshAccessToken");
  // two failure paths: no refresh token on file, and a non-ok token-endpoint response
  const disconnectCount = (body.match(/disconnect\(\)/g) || []).length;
  assert.ok(disconnectCount >= 2, "both failure paths must call disconnect()");
  const codeCount = (body.match(/err\.code\s*=\s*"AUTH_EXPIRED"/g) || []).length;
  assert.ok(codeCount >= 2, "both failure paths must tag err.code = AUTH_EXPIRED");
});

t("listDeviceImageIds: re-throws AUTH_EXPIRED before the path/not_found swallow", () => {
  const body = grab(src, "listDeviceImageIds");
  assert.ok(/if\s*\(e\s*&&\s*e\.code\s*===\s*"AUTH_EXPIRED"\)\s*throw e/.test(body),
    "must re-throw AUTH_EXPIRED instead of absorbing it as \"no images yet\"");
  const authIdx = body.search(/e\.code\s*===\s*"AUTH_EXPIRED"/);
  const pathIdx = body.search(/path\/not_found/);
  assert.ok(authIdx >= 0 && pathIdx >= 0 && authIdx < pathIdx,
    "AUTH_EXPIRED check must come before the path/not_found check");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
