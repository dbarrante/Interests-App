// tests/title-rollback-manual-edit.test.js — cardEditSave/impEditSave capture
// origTitle on the first manual rename, don't re-capture on a second, and
// settle it away when a save restores the original text.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

function loadFn(src, name, extraFreeVars) {
  const parts = { captureOrigTitle: extractFn(src, "captureOrigTitle"), settleOrigTitle: extractFn(src, "settleOrigTitle"), [name]: extractFn(src, name) };
  Object.keys(parts).forEach(k => assert.ok(parts[k], k + " not found in source"));
  const body = Object.values(parts).join("\n");
  const factory = new Function(...(extraFreeVars || []), body + "\nreturn " + name + ";");
  return factory;
}

(async () => {
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  await t(label + ": cardEditSave captures origTitle on the first manual rename", async () => {
    const it = { id: "s1", title: "Original" };
    const saved = [it];
    const document = { getElementById: () => ({ value: "Renamed" }) };
    const factory = loadFn(src, "cardEditSave", ["document", "toast", "saved", "_edSavedId", "Store", "closeGuide", "refreshTabsViewIfShowing", "renderSaved"]);
    const cardEditSave = factory(document, () => {}, saved, "s1", { putSaved: async () => {} }, () => {}, () => false, () => {});
    await cardEditSave();
    assert.strictEqual(it.title, "Renamed");
    assert.strictEqual(it.origTitle, "Original");
  });

  await t(label + ": cardEditSave does not re-capture on a second rename", async () => {
    const it = { id: "s1", title: "Renamed Once", origTitle: "The True Original" };
    const saved = [it];
    const document = { getElementById: () => ({ value: "Renamed Twice" }) };
    const factory = loadFn(src, "cardEditSave", ["document", "toast", "saved", "_edSavedId", "Store", "closeGuide", "refreshTabsViewIfShowing", "renderSaved"]);
    const cardEditSave = factory(document, () => {}, saved, "s1", { putSaved: async () => {} }, () => {}, () => false, () => {});
    await cardEditSave();
    assert.strictEqual(it.title, "Renamed Twice");
    assert.strictEqual(it.origTitle, "The True Original", "must stay the TRUE original");
  });

  await t(label + ": cardEditSave settles origTitle when the saved title restores the original", async () => {
    const it = { id: "s1", title: "Renamed", origTitle: "Original" };
    const saved = [it];
    const document = { getElementById: () => ({ value: "Original" }) };
    const factory = loadFn(src, "cardEditSave", ["document", "toast", "saved", "_edSavedId", "Store", "closeGuide", "refreshTabsViewIfShowing", "renderSaved"]);
    const cardEditSave = factory(document, () => {}, saved, "s1", { putSaved: async () => {} }, () => {}, () => false, () => {});
    await cardEditSave();
    assert.strictEqual(it.title, "Original");
    assert.strictEqual(it.origTitle, undefined);
  });

  await t(label + ": impEditSave captures origTitle on the first manual rename", async () => {
    const it = { id: "i1", title: "Original" };
    const imported = [it];
    const els = { edTitle: { value: "Renamed" }, edDesc: { value: "" }, edTags: { value: "" } };
    const document = { getElementById: (id) => els[id] };
    const factory = loadFn(src, "impEditSave", [
      "document", "_editIdx", "imported", "setCardImage", "_editImg", "persistCards", "closeGuide",
      "refreshTabsViewIfShowing", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "toast",
    ]);
    const impEditSave = factory(document, 0, imported, () => {}, "", () => {}, () => {}, () => false, () => {}, () => {}, () => {}, () => {});
    impEditSave();
    assert.strictEqual(it.title, "Renamed");
    assert.strictEqual(it.origTitle, "Original");
  });

  await t(label + ": impEditSave does not re-capture on a second rename", async () => {
    const it = { id: "i1", title: "Renamed Once", origTitle: "The True Original" };
    const imported = [it];
    const els = { edTitle: { value: "Renamed Twice" }, edDesc: { value: "" }, edTags: { value: "" } };
    const document = { getElementById: (id) => els[id] };
    const factory = loadFn(src, "impEditSave", [
      "document", "_editIdx", "imported", "setCardImage", "_editImg", "persistCards", "closeGuide",
      "refreshTabsViewIfShowing", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "toast",
    ]);
    const impEditSave = factory(document, 0, imported, () => {}, "", () => {}, () => {}, () => false, () => {}, () => {}, () => {}, () => {});
    impEditSave();
    assert.strictEqual(it.title, "Renamed Twice");
    assert.strictEqual(it.origTitle, "The True Original");
  });

  await t(label + ": impEditSave settles origTitle when the saved title restores the original", async () => {
    const it = { id: "i1", title: "Renamed", origTitle: "Original" };
    const imported = [it];
    const els = { edTitle: { value: "Original" }, edDesc: { value: "" }, edTags: { value: "" } };
    const document = { getElementById: (id) => els[id] };
    const factory = loadFn(src, "impEditSave", [
      "document", "_editIdx", "imported", "setCardImage", "_editImg", "persistCards", "closeGuide",
      "refreshTabsViewIfShowing", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "toast",
    ]);
    const impEditSave = factory(document, 0, imported, () => {}, "", () => {}, () => {}, () => false, () => {}, () => {}, () => {}, () => {});
    impEditSave();
    assert.strictEqual(it.title, "Original");
    assert.strictEqual(it.origTitle, undefined);
  });
}
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
})();
