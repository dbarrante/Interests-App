// tests/title-rollback-core.test.js — captureOrigTitle/settleOrigTitle, the
// shared pair every title-write site uses to track a card's true original
// title, plus their wiring into applyGeneratedTitle (the single choke point
// for every AI-driven rename).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");
const { extractHashtags } = require("../web/title-ai.js");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

function loadHelpers(src) {
  const parts = { captureOrigTitle: extractFn(src, "captureOrigTitle"), settleOrigTitle: extractFn(src, "settleOrigTitle") };
  Object.keys(parts).forEach(name => assert.ok(parts[name], name + " not found in source"));
  const body = Object.values(parts).join("\n");
  const factory = new Function(body + "\nreturn { captureOrigTitle, settleOrigTitle };");
  return factory();
}

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": captureOrigTitle captures the current title on the first real rename", () => {
    const { captureOrigTitle } = loadHelpers(src);
    const card = { title: "Original" };
    captureOrigTitle(card, "Renamed");
    assert.strictEqual(card.origTitle, "Original");
  });

  t(label + ": captureOrigTitle is a no-op when the new title equals the current one", () => {
    const { captureOrigTitle } = loadHelpers(src);
    const card = { title: "Same" };
    captureOrigTitle(card, "Same");
    assert.strictEqual(card.origTitle, undefined);
  });

  t(label + ": captureOrigTitle never overwrites an already-captured original across multiple renames", () => {
    const { captureOrigTitle } = loadHelpers(src);
    const card = { title: "Original", origTitle: "Original" };
    captureOrigTitle(card, "Second rename");
    assert.strictEqual(card.origTitle, "Original", "must stay the TRUE original, not the most recent prior title");
  });

  t(label + ": settleOrigTitle clears origTitle once the current title matches it again", () => {
    const { settleOrigTitle } = loadHelpers(src);
    const card = { title: "Original", origTitle: "Original" };
    settleOrigTitle(card);
    assert.strictEqual(card.origTitle, undefined);
  });

  t(label + ": settleOrigTitle leaves origTitle alone when the title still differs", () => {
    const { settleOrigTitle } = loadHelpers(src);
    const card = { title: "Renamed", origTitle: "Original" };
    settleOrigTitle(card);
    assert.strictEqual(card.origTitle, "Original");
  });

  t(label + ": settleOrigTitle is a no-op when origTitle was never set", () => {
    const { settleOrigTitle } = loadHelpers(src);
    const card = { title: "Whatever" };
    settleOrigTitle(card);
    assert.strictEqual(card.origTitle, undefined);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
