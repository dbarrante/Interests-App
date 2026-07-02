// tests/ext-content-return.test.js — regression: extension/content.js must return its
// metadata object as the script's completion value (review A4). chrome.scripting.executeScript
// reads InjectionResult.result from the last-evaluated expression in the injected function/file;
// a bare `data;` statement at the end of the IIFE still evaluates to `data`, but wrapping it in
// an assignment or losing the value at the top level makes the injected result undefined. This
// test runs the real content.js source in a minimal DOM sandbox via vm.runInNewContext and
// asserts the completion value is the metadata object (og:title/desc/image extraction and the
// blocked-page/CAPTCHA detector all hang off this).
const assert = require("assert");
const fs = require("fs"), path = require("path"), vm = require("vm");

let passed = 0, failed = 0;
function t(n, fn) {
  try { fn(); passed++; console.log("  ok  " + n); }
  catch (e) { failed++; console.error("  FAIL " + n + "\n    " + (e && e.message)); }
}

function makeDom(overrides) {
  const base = {
    document: {
      title: "Page Title",
      location: { href: "https://x.com/p" },
      querySelector: () => null,
      querySelectorAll: () => [],
      body: { innerText: "" },
    },
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  };
  return Object.assign(base, overrides);
}

t("content.js returns the metadata object as the script's completion value", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "extension", "content.js"), "utf8");
  const dom = makeDom();
  const result = vm.runInNewContext(src, dom);
  assert.ok(result, "completion value should be truthy (the metadata object), not undefined");
  assert.strictEqual(result.title, "Page Title");
  assert.strictEqual(result.url, "https://x.com/p");
  assert.strictEqual(result.blocked, false);
});

t("returned metadata carries og:image/desc extraction fields", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "extension", "content.js"), "utf8");
  const dom = makeDom();
  const result = vm.runInNewContext(src, dom);
  assert.ok(result, "completion value should be truthy");
  assert.ok("ogImage" in result, "result should carry ogImage");
  assert.ok("desc" in result, "result should carry desc");
  assert.ok("contentImage" in result, "result should carry contentImage");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
