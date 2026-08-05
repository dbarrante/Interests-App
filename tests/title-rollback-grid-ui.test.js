// tests/title-rollback-grid-ui.test.js — impRevertTitle (direct-apply, no
// review step, matching impRefreshTitle's precedent) and the conditional
// .imp-revert icon in impCardHTML.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": impRevertTitle restores origTitle, clears it, and persists", () => {
    const it = { id: "i1", title: "Renamed", origTitle: "Original" };
    const imported = [it];
    let persisted = false, toasted = "";
    const factory = new Function(
      "imported", "persistCards", "curTab", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "refreshTabsViewIfShowing", "toast",
      extractFn(src, "settleOrigTitle") + "\n" + extractFn(src, "impRevertTitle") + "\nreturn impRevertTitle;"
    );
    const impRevertTitle = factory(imported, () => { persisted = true; }, "imported", () => {}, () => {}, () => {}, () => false, (msg) => { toasted = msg; });
    impRevertTitle(0);
    assert.strictEqual(it.title, "Original");
    assert.strictEqual(it.origTitle, undefined);
    assert.ok(persisted);
    assert.ok(toasted.indexOf("Original") >= 0);
  });

  t(label + ": impRevertTitle is a no-op when the card has no origTitle", () => {
    const it = { id: "i1", title: "Never Renamed" };
    const imported = [it];
    let persisted = false;
    const factory = new Function(
      "imported", "persistCards", "curTab", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "refreshTabsViewIfShowing", "toast",
      extractFn(src, "settleOrigTitle") + "\n" + extractFn(src, "impRevertTitle") + "\nreturn impRevertTitle;"
    );
    const impRevertTitle = factory(imported, () => { persisted = true; }, "imported", () => {}, () => {}, () => {}, () => false, () => {});
    impRevertTitle(0);
    assert.strictEqual(it.title, "Never Renamed");
    assert.strictEqual(persisted, false);
  });

  t(label + ": impCardHTML renders the revert icon only when origTitle is set", () => {
    const withOrig = extractFn(src, "impCardHTML");
    assert.match(withOrig, /it\.origTitle\s*!==\s*undefined[\s\S]*?impRevertTitle\(\$\{idx\}\)/,
      "impCardHTML must conditionally emit an impRevertTitle(...) trigger keyed on it.origTitle");
  });

  t(label + ": .imp-revert joins the shared hover-reveal CSS group", () => {
    assert.match(src, /\.imp-edit,\.imp-refresh,\.imp-reader,\.imp-title,\.imp-revert\{/);
    assert.match(src, /\.imp-card:hover \.imp-edit,\.imp-card:hover \.imp-refresh,\.imp-card:hover \.imp-reader,\.imp-card:hover \.imp-title,\.imp-card:hover \.imp-revert\{display:flex\}/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
