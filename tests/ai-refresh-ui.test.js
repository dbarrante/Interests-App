// tests/ai-refresh-ui.test.js — the "AI refresh" Library Health tab's static
// UI: tab-strip entry, dispatch, and renderHealthAiRefresh's markup/state.
// The Process button's actual batch logic (runAiRefreshBatch) is Task 8.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": HEALTH_TABS includes an airefresh entry labeled 'AI refresh'", () => {
    assert.match(src, /\{\s*id:"airefresh",\s*label:"AI refresh"\s*\}/);
  });

  t(label + ": renderHealth dispatches to renderHealthAiRefresh for the airefresh tab", () => {
    assert.match(src, /if\(tab==="airefresh"\)\s*return\s*renderHealthAiRefresh\(list\);/);
  });

  t(label + ": renderHealthAiRefresh shows the eligible count and a working day-threshold input", () => {
    const el = { innerHTML: "" };
    const document = { getElementById: () => el };
    const S = { aiRefreshDays: 30 };
    const aiRefreshCandidates = () => [{ id: "a" }, { id: "b" }];
    const factory = new Function(
      "S", "aiRefreshCandidates", "_airefreshRetag", "_airefreshRetitle",
      extractFn(src, "renderHealthAiRefresh") + "\nreturn renderHealthAiRefresh;"
    );
    const renderHealthAiRefresh = factory(S, aiRefreshCandidates, true, true);
    const list = { innerHTML: "" };
    renderHealthAiRefresh(list);
    assert.ok(list.innerHTML.indexOf("2 card") >= 0, "must show the eligible count");
    assert.ok(list.innerHTML.indexOf('value="30"') >= 0, "must show the current threshold");
    assert.ok(list.innerHTML.indexOf("runAiRefreshBatch()") >= 0, "Process button must call runAiRefreshBatch");
  });

  t(label + ": renderHealthAiRefresh disables the Process button when there is nothing eligible", () => {
    const S = { aiRefreshDays: 30 };
    const aiRefreshCandidates = () => [];
    const factory = new Function(
      "S", "aiRefreshCandidates", "_airefreshRetag", "_airefreshRetitle",
      extractFn(src, "renderHealthAiRefresh") + "\nreturn renderHealthAiRefresh;"
    );
    const renderHealthAiRefresh = factory(S, aiRefreshCandidates, true, true);
    const list = { innerHTML: "" };
    renderHealthAiRefresh(list);
    assert.match(list.innerHTML, /id="airefreshBtn"[^>]*disabled/);
  });

  t(label + ": renderHealthAiRefresh disables the Process button when both checkboxes are off", () => {
    const S = { aiRefreshDays: 30 };
    const aiRefreshCandidates = () => [{ id: "a" }];
    const factory = new Function(
      "S", "aiRefreshCandidates", "_airefreshRetag", "_airefreshRetitle",
      extractFn(src, "renderHealthAiRefresh") + "\nreturn renderHealthAiRefresh;"
    );
    const renderHealthAiRefresh = factory(S, aiRefreshCandidates, false, false);
    const list = { innerHTML: "" };
    renderHealthAiRefresh(list);
    assert.match(list.innerHTML, /id="airefreshBtn"[^>]*disabled/);
  });

  t(label + ": airefreshSetDays clamps below 1 up to 1 and saves settings", () => {
    const S = { aiRefreshDays: 30 };
    let saved = null;
    const save = (k, v) => { saved = [k, v]; };
    const factory = new Function(
      "S", "save", "_healthTab", "document",
      extractFn(src, "airefreshSetDays") + "\nreturn { airefreshSetDays, S };"
    );
    const mod = factory(S, save, "dupes", { getElementById: () => null });
    mod.airefreshSetDays("-5");
    assert.strictEqual(mod.S.aiRefreshDays, 1);
    assert.deepStrictEqual(saved, ["settings", mod.S]);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
