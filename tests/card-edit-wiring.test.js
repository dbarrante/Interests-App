// tests/card-edit-wiring.test.js — structural checks (regex against the shipped
// source, no build step) for the per-card title editor. Same convention as
// tests/title-quality-wiring.test.js and tests/backup-ui.test.js.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": saved cards get a hover edit icon", () => {
    assert.match(src, /<button class="card-edit" title="Edit title" onclick="event\.stopPropagation\(\);cardEdit\('\$\{id\}'\)"/,
      "cardHTML must emit the edit button, and it must stopPropagation so it doesn't open the article");
    assert.match(src, /\.card:hover \.card-edit\{display:flex\}/, "the icon reveals on card hover");
  });
  t(label + ": the hover icon is reachable on touch devices", () => {
    // Touch has no hover state, so a hover-only control is otherwise unreachable —
    // the imported cards' icons already carry this exact rule.
    assert.match(src, /@media\(max-width:760px\)\{\.card-edit\{display:flex\}\}/,
      "a <=760px rule must show the icon unconditionally");
  });
  t(label + ": both editors expose an AI title lookup", () => {
    const hits = src.match(/onclick="edAiTitle\(\)"/g) || [];
    assert.strictEqual(hits.length, 2,
      "one in the imported editor (impEdit) and one in the saved editor (cardEdit), got " + hits.length);
  });
  t(label + ": AI lookup stages into the input, it does not write the card", () => {
    const m = /async function edAiTitle\(\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "edAiTitle not found");
    assert.match(m[1], /box\.value = out\.slice\(0,250\)/,
      "the suggestion must land in the Title input for review");
    assert.doesNotMatch(m[1], /putSaved|persistCards|putCards/,
      "nothing may be persisted until the user hits Save — same contract as the Title-issues panel");
  });
  t(label + ": AI lookup reads the right card for whichever editor is open", () => {
    const m = /async function edAiTitle\(\)\{([\s\S]*?)\n\}/.exec(src);
    assert.match(m[1], /_edScope==="saved"[\s\S]*?saved\.find[\s\S]*?imported\[_editIdx\]/,
      "must branch on _edScope — the two editors address their cards differently (id vs index)");
  });
  t(label + ": impEdit sets the scope so the shared helper can't read the wrong list", () => {
    assert.match(src, /_editIdx = idx; _edScope = "imported"; _edSavedId = "";/,
      "impEdit must claim the scope, or a prior cardEdit would leave it stale");
  });
  t(label + ": saving a title persists and re-renders", () => {
    const m = /async function cardEditSave\(\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "cardEditSave not found");
    assert.match(m[1], /await Store\.putSaved\(saved\)/, "must persist through the Store");
    assert.match(m[1], /renderSaved\(\)/, "and re-render so the change is visible");
    assert.match(m[1], /if\(!title\)\{/, "must refuse to blank out a title");
  });
}

t("the per-card editor is byte-identical between web and pwa (binding parity)", () => {
  for (const fn of ["function cardEdit", "async function cardEditSave", "async function edAiTitle"]) {
    const re = new RegExp(fn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s\\S]*?\\n\\}");
    const a = re.exec(html), b = re.exec(pwaHtml);
    assert.ok(a && b, fn + " missing from one of the files");
    assert.strictEqual(a[0], b[0], fn + " has drifted between web/ and pwa/");
  }
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
