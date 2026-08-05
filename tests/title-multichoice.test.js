// tests/title-multichoice.test.js — regenerateTitleChoices generates up to
// `count` distinct candidates (never padded on partial failure), and
// edAiTitle wires it into the edit modal's chip picker.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

(async () => {
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  await t(label + ": regenerateTitleChoices returns up to `count` candidates, each avoiding all prior ones, fetching grounding exactly once", async () => {
    const seenAvoid = [];
    let groundCalls = 0;
    const factory = new Function(
      "IA_AI", "toast", "showBusyOverlay", "hideBusyOverlay", "requestAnimationFrame",
      "fetchGroundingExcerpt", "generateUniqueTitle", "titleFailReasonMessage",
      extractFn(src, "regenerateTitleChoices") + "\nreturn regenerateTitleChoices;"
    );
    let n = 0;
    const regenerateTitleChoices = factory(
      { hasAIKey: () => true }, () => {}, () => {}, () => {}, (cb) => cb(),
      async () => { groundCalls++; return "grounding text"; }, async (card, avoid) => { seenAvoid.push(avoid.slice()); n++; return { title: "Title " + n, failReason: "" }; },
      () => "fail message"
    );
    const out = await regenerateTitleChoices({ id: "c1", url: "https://example.test" }, [], 3);
    assert.deepStrictEqual(out, ["Title 1", "Title 2", "Title 3"]);
    assert.deepStrictEqual(seenAvoid, [[], ["Title 1"], ["Title 1", "Title 2"]]);
    assert.strictEqual(groundCalls, 1, "grounding is a property of the article, fetched once and reused across all attempts");
  });

  await t(label + ": regenerateTitleChoices returns fewer than `count` when an attempt fails the quality gate (never padded)", async () => {
    const factory = new Function(
      "IA_AI", "toast", "showBusyOverlay", "hideBusyOverlay", "requestAnimationFrame",
      "fetchGroundingExcerpt", "generateUniqueTitle", "titleFailReasonMessage",
      extractFn(src, "regenerateTitleChoices") + "\nreturn regenerateTitleChoices;"
    );
    let n = 0;
    const regenerateTitleChoices = factory(
      { hasAIKey: () => true }, () => {}, () => {}, () => {}, (cb) => cb(),
      async () => "", async () => { n++; return n===1 ? { title: "Only One", failReason: "" } : { title: null, failReason: "" }; },
      () => "fail message"
    );
    const out = await regenerateTitleChoices({ id: "c1", url: "https://example.test" }, [], 3);
    assert.deepStrictEqual(out, ["Only One"]);
  });

  await t(label + ": regenerateTitleChoices returns [] and toasts when no AI key is configured", async () => {
    let toasted = "";
    const factory = new Function(
      "IA_AI", "toast", "PROVIDERS", "S", "showBusyOverlay", "hideBusyOverlay", "requestAnimationFrame",
      "fetchGroundingExcerpt", "generateUniqueTitle", "titleFailReasonMessage",
      extractFn(src, "regenerateTitleChoices") + "\nreturn regenerateTitleChoices;"
    );
    const regenerateTitleChoices = factory(
      { hasAIKey: () => false }, (msg) => { toasted = msg; }, { anthropic: { keyName: "Anthropic key" } }, { provider: "anthropic" },
      () => {}, () => {}, (cb) => cb(), async () => "", async () => ({ title: "x" }), () => ""
    );
    const out = await regenerateTitleChoices({ id: "c1", url: "https://example.test" }, [], 3);
    assert.deepStrictEqual(out, []);
    assert.ok(toasted.indexOf("Anthropic key") >= 0);
  });

  await t(label + ": renderTitleChoices renders a clickable chip per candidate; edPickTitleChoice stages it into the title input", () => {
    let html2 = "";
    const box = { innerHTML: "" };
    Object.defineProperty(box, "innerHTML", { get: () => html2, set: (v) => { html2 = v; } });
    const editBox = { value: "", focus: () => {} };
    const els = { edTitleChoices: box, edTitle: editBox };
    const document = { getElementById: (id) => els[id] || null };
    const factory = new Function(
      "document", "esc",
      extractFn(src, "renderTitleChoices") + "\n" + extractFn(src, "edPickTitleChoice") + "\nreturn { renderTitleChoices, edPickTitleChoice };"
    );
    const esc = (s) => String(s);
    const mod = factory(document, esc);
    mod.renderTitleChoices(["First Choice", "Second Choice"]);
    assert.ok(html2.indexOf("First Choice") >= 0 && html2.indexOf("Second Choice") >= 0);
    mod.edPickTitleChoice({ getAttribute: () => "Second Choice" });
    assert.strictEqual(editBox.value, "Second Choice");
  });
}
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
})();
