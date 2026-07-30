// tests/tabs-ai-suggest.test.js — Task 6: the AI-suggest-cards-for-a-tab batching
// (candidate building, excluding cards already in the tab, capping at 40) and the
// accept/reject review state, mirroring aiSuggestTags/openAutoTag/autoAccept's
// established pattern (Plan 1) but for CARDS instead of tags. Uses the queued
// async-runner pattern (see tests/ai-module.test.js) since several assertions here
// are themselves async — a plain synchronous t() never awaits its callback, so an
// async test body's assertions would silently never run.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let passed = 0, failed = 0;
const queue = [];
function t(n, fn) { queue.push([n, fn]); }
function fn(src, name) { const m = extractFn(src, name); assert.ok(m, name + " not found in source"); return m; }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": aiSuggestCardsForTab excludes cards already in the tab from its candidate batch", async () => {
    const importedArr = [{ tags: ["stl files"], title: "Already in" }, { tags: [], title: "Candidate A", desc: "" }];
    const savedArr = [{ id: "s0", tags: [], title: "Candidate B", desc: "" }];
    const body = [fn(src, "tabsFilteredList"), fn(src, "aiSuggestCardsForTab")].join("\n");
    const factory = new Function(
      "imported", "saved", "cardHasTag", "callAI",
      body + "\nreturn aiSuggestCardsForTab;"
    );
    let sentPrompt = "";
    const aiSuggestCardsForTab = factory(
      importedArr, savedArr,
      (it,tag)=>!!(it&&it.tags&&it.tags.includes(tag)),
      async (prompt) => { sentPrompt = prompt; return "[0,1]"; }   // both remaining candidates picked
    );
    const picks = await aiSuggestCardsForTab({ name: "STL files", tag: "stl files" });
    assert.ok(!sentPrompt.includes("Already in"), "the already-tagged card must not be sent as a candidate");
    assert.strictEqual(picks.length, 2);
    assert.ok(picks.some(p=>p.title==="Candidate A" && p.scope==="imported"));
    assert.ok(picks.some(p=>p.title==="Candidate B" && p.scope==="saved"));
  });

  t(label + ": aiSuggestCardsForTab throws a clear error when the AI returns nothing parseable", async () => {
    const body = [fn(src, "tabsFilteredList"), fn(src, "aiSuggestCardsForTab")].join("\n");
    const factory = new Function(
      "imported", "saved", "cardHasTag", "callAI",
      body + "\nreturn aiSuggestCardsForTab;"
    );
    const aiSuggestCardsForTab = factory(
      [{ tags: [], title: "A" }], [],
      (it,tag)=>!!(it&&it.tags&&it.tags.includes(tag)),
      async () => "not json at all"
    );
    await assert.rejects(() => aiSuggestCardsForTab({ name: "STL files", tag: "stl files" }));
  });

  t(label + ": tabSugAccept applies the tab's tag to selected (or all, if none selected) candidates", () => {
    const importedArr = [{ tags: [] }];
    const savedArr = [{ id: "s0", tags: [] }];
    const calls = [];
    const body = [fn(src, "tabSugAccept")].join("\n");
    const factory = new Function(
      "tabs", "openTabId", "_tabSug", "imported", "saved", "Store", "toast", "renderTabsView",
      body + "\nreturn tabSugAccept;"
    );
    const tabSugAccept = factory(
      [{ id: "t1", name: "STL files", tag: "stl files", reserved: false }], "t1",
      [ { scope: "imported", identity: 0, title: "A", sel: false }, { scope: "saved", identity: "s0", title: "B", sel: false } ],
      importedArr, savedArr,
      { putCards: (arr)=>calls.push(["putCards",arr]), putSaved: (arr)=>calls.push(["putSaved",arr]) },
      ()=>calls.push("toast"), ()=>calls.push("render")
    );
    tabSugAccept();   // none selected -> accept all
    assert.deepStrictEqual(importedArr[0].tags, ["stl files"]);
    assert.deepStrictEqual(savedArr[0].tags, ["stl files"]);
  });

  t(label + ": tabSuggestPanelHTML renders nothing when idle (no suggestions, not loading, no error)", () => {
    const factory = new Function(
      "_tabSug", "_tabSugErr", "_tabSugLoading", "esc",
      fn(src, "tabSuggestPanelHTML") + "\nreturn tabSuggestPanelHTML;"
    );
    const tabSuggestPanelHTML = factory([], "", false, (s)=>s);
    assert.strictEqual(tabSuggestPanelHTML(), "");
  });
}

// Run queued tests sequentially, awaiting each (some are async).
(async () => {
  for (const [n, fn] of queue) {
    try { await fn(); passed++; console.log("  ok  " + n); }
    catch (e) { failed++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); }
  }
  console.log(passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
