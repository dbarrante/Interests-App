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
    // Imported identity is now the card's stable id (F3, final review round 3) —
    // the already-tagged card needs one BEFORE the call, matching a real card
    // that's been rendered before; the never-tagged ones get theirs from the
    // injected newId() stub, just like the real function assigns lazily.
    const importedArr = [{ id: "i-existing", tags: ["stl files"], title: "Already in" }, { tags: [], title: "Candidate A", desc: "" }];
    const savedArr = [{ id: "s0", tags: [], title: "Candidate B", desc: "" }];
    const body = [fn(src, "tabsFilteredList"), fn(src, "aiSuggestCardsForTab")].join("\n");
    const factory = new Function(
      "imported", "saved", "cardHasTag", "callAI", "newId", "Store", "filterCat", "CATS", "save",
      body + "\nreturn aiSuggestCardsForTab;"
    );
    let sentPrompt = "";
    let nextId = 0;
    const aiSuggestCardsForTab = factory(
      importedArr, savedArr,
      (it,tag)=>!!(it&&it.tags&&it.tags.includes(tag)),
      async (prompt) => { sentPrompt = prompt; return "[0,1]"; },   // both remaining candidates picked
      () => "gen_" + (nextId++),
      { putCards: () => {} },
      "", [], () => {}
    );
    const picks = await aiSuggestCardsForTab({ name: "STL files", tag: "stl files" });
    assert.ok(!sentPrompt.includes("Already in"), "the already-tagged card must not be sent as a candidate");
    assert.strictEqual(picks.length, 2);
    assert.ok(picks.some(p=>p.title==="Candidate A" && p.scope==="imported"));
    assert.ok(picks.some(p=>p.title==="Candidate B" && p.scope==="saved"));
  });

  t(label + ": aiSuggestCardsForTab's exclusion set is NOT narrowed by an active category filter (Task 1 regression)", () => {
    // Task 1 taught tabsFilteredList to narrow by filterCat for DISPLAY. That
    // narrowing must never leak into aiSuggestCardsForTab's "already in this tab"
    // membership check — if it did, an already-tagged card sitting in a category
    // other than the active filter would silently drop out of the exclusion set
    // and get offered back to the AI as a candidate to re-add.
    const importedArr = [{ id: "i-existing", tags: ["stl files"], title: "Already in", category: "Work initiatives" }];
    const savedArr = [];
    const CATS = [{ key: "personal", name: "Personal projects & hobbies" }, { key: "work", name: "Work initiatives" }];
    const body = [fn(src, "tabsFilteredList"), fn(src, "aiSuggestCardsForTab")].join("\n");
    const factory = new Function(
      "imported", "saved", "cardHasTag", "callAI", "newId", "Store", "filterCat", "CATS", "save",
      body + "\nreturn aiSuggestCardsForTab;"
    );
    const aiSuggestCardsForTab = factory(
      importedArr, savedArr,
      (it,tag)=>!!(it&&it.tags&&it.tags.includes(tag)),
      async () => { throw new Error("must not be called — nothing left to suggest"); },
      () => "gen_id",
      { putCards: () => {} },
      "personal", CATS, () => {}   // filterCat="personal" — the already-tagged card is in "work"
    );
    return assert.rejects(
      () => aiSuggestCardsForTab({ name: "STL files", tag: "stl files" }),
      /Nothing left to suggest/,
      "the already-tagged card (in a different category than the active filter) must still be excluded"
    );
  });

  t(label + ": aiSuggestCardsForTab throws a clear error when the AI returns nothing parseable", async () => {
    const body = [fn(src, "tabsFilteredList"), fn(src, "aiSuggestCardsForTab")].join("\n");
    const factory = new Function(
      "imported", "saved", "cardHasTag", "callAI", "newId", "Store", "filterCat", "CATS", "save",
      body + "\nreturn aiSuggestCardsForTab;"
    );
    const aiSuggestCardsForTab = factory(
      [{ tags: [], title: "A" }], [],
      (it,tag)=>!!(it&&it.tags&&it.tags.includes(tag)),
      async () => "not json at all",
      () => "gen_id",
      { putCards: () => {} },
      "", [], () => {}
    );
    await assert.rejects(() => aiSuggestCardsForTab({ name: "STL files", tag: "stl files" }));
  });

  t(label + ": tabSugAccept applies the tab's tag to selected (or all, if none selected) candidates", () => {
    // Imported identity is now the card's stable id, not its array index (F3,
    // final review round 3) — resolved via imported.find(x=>x.id===identity).
    const importedArr = [{ id: "i0", tags: [] }];
    const savedArr = [{ id: "s0", tags: [] }];
    const calls = [];
    const body = [fn(src, "tabSugAccept")].join("\n");
    const factory = new Function(
      "tabs", "openTabId", "_tabSug", "imported", "saved", "Store", "toast", "renderTabsView",
      body + "\nreturn tabSugAccept;"
    );
    const tabSugAccept = factory(
      [{ id: "t1", name: "STL files", tag: "stl files", reserved: false }], "t1",
      [ { scope: "imported", identity: "i0", title: "A", sel: false }, { scope: "saved", identity: "s0", title: "B", sel: false } ],
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

  t(label + ": openTabSuggest discards a stale response if the user switched tabs while the AI call was in flight", async () => {
    // The mock callAI (declared INSIDE the same generated scope, so it shares
    // the closure over openTabId with openTabSuggest itself) simulates the
    // exact race: the "user" switches tabs mid-flight, before the AI call
    // resolves.
    const mockCallAI = `function callAI(prompt) { openTabId = "t2"; return Promise.resolve("[0]"); }\n`;
    const body = mockCallAI + [fn(src, "tabsFilteredList"), fn(src, "aiSuggestCardsForTab"), fn(src, "openTabSuggest")].join("\n");
    const factory = new Function(
      "tabs", "openTabId", "imported", "saved", "cardHasTag",
      "IA_AI", "PROVIDERS", "S", "toast", "renderTabsView", "newId", "Store",
      "_tabSug", "_tabSugErr", "_tabSugLoading", "filterCat", "CATS", "save",
      body + "\nreturn { run: openTabSuggest, getTabSug: () => _tabSug, getOpenTabId: () => openTabId };"
    );
    const importedArr = [{ id: "i0", tags: [], title: "Candidate", desc: "" }];
    const api = factory(
      [{ id: "t1", name: "STL files", tag: "stl files", reserved: false }], "t1",
      importedArr, [], (it,tag)=>!!(it&&it.tags&&it.tags.includes(tag)),
      { hasAIKey: () => true }, { p: { keyName: "key" } }, { provider: "p" },
      () => {}, () => {}, () => "gen_id", { putCards: () => {} },
      [], "", false, "", [], () => {}
    );
    api.run();
    await new Promise(r => setTimeout(r, 0));   // let the pending promise chain settle
    await new Promise(r => setTimeout(r, 0));
    assert.strictEqual(api.getOpenTabId(), "t2", "sanity: the simulated tab switch actually happened");
    assert.deepStrictEqual(api.getTabSug(), [], "stale suggestions for the abandoned tab must NOT populate _tabSug once a different tab is open");
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
