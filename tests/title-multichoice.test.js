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

  await t(label + ": regenerateTitleChoices returns fewer than `count` when an attempt fails the quality gate (never padded), and stops trying after the first failure", async () => {
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
    // count=3 would allow a 3rd attempt if the code kept retrying after a
    // failure (break vs. continue) -- out alone can't distinguish those, since
    // a wrongly-continuing loop would ALSO end up with just ["Only One"] once
    // every later call keeps returning a null title. n pins down the call
    // count directly: exactly 2 attempts (the success, then the failure that
    // stops the loop), never a 3rd wasted (billed) attempt.
    assert.strictEqual(n, 2, "must stop at the first failure, not keep trying");
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

  await t(label + ": renderTitleChoices renders a clickable chip per candidate with a quote-escaped data-title; edPickTitleChoice reads THAT attribute to stage it into the title input", () => {
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
    // A non-identity esc mirroring the real one (escapes &<> but NOT ") so a
    // quote in a title only gets neutralized by the source's own explicit
    // .replace(/"/g,"&quot;") on the data-title attribute -- proving that
    // call is actually there, not just present in the brief.
    const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const mod = factory(document, esc);
    mod.renderTitleChoices(["First Choice", 'Second "Choice"']);
    assert.ok(html2.indexOf('data-title="First Choice"') >= 0, "plain title lands unescaped in data-title");
    assert.ok(html2.indexOf('data-title="Second &quot;Choice&quot;"') >= 0, "an embedded quote must not break out of the data-title attribute");
    // Stub keyed on attribute name (not the call's return value alone) so a
    // code change that read the wrong attribute (e.g. a typo'd data-* name)
    // would fail this test instead of passing by coincidence.
    mod.edPickTitleChoice({ getAttribute: (k) => k === "data-title" ? 'Second "Choice"' : null });
    assert.strictEqual(editBox.value, 'Second "Choice"');
  });

  await t(label + ": edAiTitle clears stale chips from a prior lookup before rendering the new lookup's results", async () => {
    const calls = [];
    const box = { value: "old title", focus: () => {} };
    const els = { edTitle: box };
    const document = { getElementById: (id) => els[id] || null };
    const saved = [{ id: "s1", title: "old title" }];
    const factory = new Function(
      "document", "saved", "imported", "_edScope", "_edSavedId", "_editIdx",
      "toast", "renderTitleChoices", "regenerateTitleChoices", "S",
      extractFn(src, "edAiTitle") + "\nreturn edAiTitle;"
    );
    const edAiTitle = factory(
      document, saved, [], "saved", "s1", -1,
      () => {},
      (list) => { calls.push(list && list.length ? "results:" + list.join(",") : "clear"); },
      async () => ["New Title 1", "New Title 2"],
      { aiTitleSuggestCount: 2 }
    );
    await edAiTitle();
    // The clear must happen BEFORE regenerateTitleChoices resolves and the
    // real results are rendered -- otherwise a second lookup in the same
    // modal session would show a stale + fresh mix, or the clear could land
    // AFTER the new results and wipe them.
    assert.deepStrictEqual(calls, ["clear", "results:New Title 1,New Title 2"]);
  });
}
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
})();
