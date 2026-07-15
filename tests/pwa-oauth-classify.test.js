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

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
