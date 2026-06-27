// tests/install-doc.test.js
// Asserts docs/INSTALL.md covers every required smoke-checklist step.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

const docPath = path.join(__dirname, "..", "docs", "INSTALL.md");
t("docs/INSTALL.md exists", () => {
  assert.ok(fs.existsSync(docPath), "docs/INSTALL.md missing");
});
const doc = fs.existsSync(docPath) ? fs.readFileSync(docPath, "utf8") : "";
const lc = doc.toLowerCase();
const required = [
  ["install step", /install/i],
  ["choose-directory wizard step", /choose.*(folder|directory|install)/i],
  ["launch step", /launch|start menu|open the app/i],
  ["migrate step", /migrate|import/i],
  ["see library step", /library|cards/i],
  ["capture via extension step", /capture/i],
  ["extension mention", /extension/i],
  ["backup step", /back ?up/i],
  ["restore step", /restore/i],
  ["move store step", /move.*(store|data|location)|data location/i],
  ["SmartScreen note", /smartscreen|unknown publisher/i],
];
required.forEach(([label, re]) => {
  t("checklist covers: " + label, () => {
    assert.ok(re.test(doc), "INSTALL.md is missing the " + label);
  });
});
t("is a non-trivial checklist (has checkbox items)", () => {
  assert.ok((doc.match(/- \[ \]/g) || []).length >= 8, "expected at least 8 checklist items");
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
