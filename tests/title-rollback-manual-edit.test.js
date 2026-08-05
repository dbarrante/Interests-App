// tests/title-rollback-manual-edit.test.js — cardEditSave/impEditSave capture
// origTitle on the first manual rename, don't re-capture on a second, and
// settle it away when a save restores the original text.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");
const { extractHashtags } = require("../web/title-ai.js");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

function loadFn(src, name, extraFreeVars) {
  const parts = {
    captureOrigTitle: extractFn(src, "captureOrigTitle"),
    settleOrigTitle: extractFn(src, "settleOrigTitle"),
    mergeCleanTags: extractFn(src, "mergeCleanTags"),
    captureOutgoingHashtags: extractFn(src, "captureOutgoingHashtags"),
    [name]: extractFn(src, name),
  };
  Object.keys(parts).forEach(k => assert.ok(parts[k], k + " not found in source"));
  const body = Object.values(parts).join("\n");
  const factory = new Function("extractHashtags", "AI_TAB_TAG", "canonicalTag", "tagBadPattern", ...(extraFreeVars || []), body + "\nreturn " + name + ";");
  return factory;
}

(async () => {
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  await t(label + ": cardEditSave captures origTitle on the first manual rename", async () => {
    const it = { id: "s1", title: "Original" };
    const saved = [it];
    const document = { getElementById: () => ({ value: "Renamed" }) };
    const factory = loadFn(src, "cardEditSave", ["document", "toast", "saved", "_edSavedId", "Store", "closeGuide", "refreshTabsViewIfShowing", "renderSaved"]);
    const cardEditSave = factory(extractHashtags, "interests", (t)=>t.toLowerCase(), ()=>false, document, () => {}, saved, "s1", { putSaved: async () => {} }, () => {}, () => false, () => {});
    await cardEditSave();
    assert.strictEqual(it.title, "Renamed");
    assert.strictEqual(it.origTitle, "Original");
  });

  await t(label + ": cardEditSave captures hashtags from the outgoing title as tags", async () => {
    const it = { id: "s1", title: "Old #vintage", tags: [] };
    const saved = [it];
    const document = { getElementById: () => ({ value: "Renamed" }) };
    const factory = loadFn(src, "cardEditSave", ["document", "toast", "saved", "_edSavedId", "Store", "closeGuide", "refreshTabsViewIfShowing", "renderSaved"]);
    const cardEditSave = factory(extractHashtags, "interests", (t)=>t.toLowerCase(), ()=>false, document, () => {}, saved, "s1", { putSaved: async () => {} }, () => {}, () => false, () => {});
    await cardEditSave();
    assert.strictEqual(it.title, "Renamed");
    assert.deepStrictEqual(it.tags, ["vintage"]);
  });

  await t(label + ": cardEditSave does not re-capture on a second rename", async () => {
    const it = { id: "s1", title: "Renamed Once", origTitle: "The True Original" };
    const saved = [it];
    const document = { getElementById: () => ({ value: "Renamed Twice" }) };
    const factory = loadFn(src, "cardEditSave", ["document", "toast", "saved", "_edSavedId", "Store", "closeGuide", "refreshTabsViewIfShowing", "renderSaved"]);
    const cardEditSave = factory(extractHashtags, "interests", (t)=>t.toLowerCase(), ()=>false, document, () => {}, saved, "s1", { putSaved: async () => {} }, () => {}, () => false, () => {});
    await cardEditSave();
    assert.strictEqual(it.title, "Renamed Twice");
    assert.strictEqual(it.origTitle, "The True Original", "must stay the TRUE original");
  });

  await t(label + ": cardEditSave settles origTitle when the saved title restores the original", async () => {
    const it = { id: "s1", title: "Renamed", origTitle: "Original" };
    const saved = [it];
    const document = { getElementById: () => ({ value: "Original" }) };
    const factory = loadFn(src, "cardEditSave", ["document", "toast", "saved", "_edSavedId", "Store", "closeGuide", "refreshTabsViewIfShowing", "renderSaved"]);
    const cardEditSave = factory(extractHashtags, "interests", (t)=>t.toLowerCase(), ()=>false, document, () => {}, saved, "s1", { putSaved: async () => {} }, () => {}, () => false, () => {});
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
    const impEditSave = factory(extractHashtags, "interests", (t)=>t.toLowerCase(), ()=>false, document, 0, imported, () => {}, "", () => {}, () => {}, () => false, () => {}, () => {}, () => {}, () => {});
    impEditSave();
    assert.strictEqual(it.title, "Renamed");
    assert.strictEqual(it.origTitle, "Original");
  });

  await t(label + ": impEditSave captures hashtags from the outgoing title as tags, merged with the user's typed tags (not clobbered by the edTags-box write)", async () => {
    const it = { id: "i1", title: "Old #vintage", tags: [] };
    const imported = [it];
    const els = { edTitle: { value: "Renamed" }, edDesc: { value: "" }, edTags: { value: "typed" } };
    const document = { getElementById: (id) => els[id] };
    const factory = loadFn(src, "impEditSave", [
      "document", "_editIdx", "imported", "setCardImage", "_editImg", "persistCards", "closeGuide",
      "refreshTabsViewIfShowing", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "toast",
    ]);
    const impEditSave = factory(extractHashtags, "interests", (t)=>t.toLowerCase(), ()=>false, document, 0, imported, () => {}, "", () => {}, () => {}, () => false, () => {}, () => {}, () => {}, () => {});
    impEditSave();
    assert.strictEqual(it.title, "Renamed");
    assert.deepStrictEqual(it.tags.sort(), ["typed", "vintage"], "the outgoing title's hashtag must survive the edTags-box write, not be clobbered by it");
  });

  await t(label + ": impEditSave does not resurrect a tag the user just deleted from the box, even when it matches a hashtag in the outgoing title", async () => {
    const it = { id: "i1", title: "Beach day #vintage", tags: ["vintage"] };
    const imported = [it];
    // The user deleted "vintage" from the tags box (now empty) while also
    // renaming the title in the same save -- captureOutgoingHashtags must
    // treat that deletion as deliberate, not re-add "vintage" from the
    // #vintage hashtag still present in the OLD title.
    const els = { edTitle: { value: "Beach Day Redux" }, edDesc: { value: "" }, edTags: { value: "" } };
    const document = { getElementById: (id) => els[id] };
    const factory = loadFn(src, "impEditSave", [
      "document", "_editIdx", "imported", "setCardImage", "_editImg", "persistCards", "closeGuide",
      "refreshTabsViewIfShowing", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "toast",
    ]);
    const impEditSave = factory(extractHashtags, "interests", (t)=>t.toLowerCase(), ()=>false, document, 0, imported, () => {}, "", () => {}, () => {}, () => false, () => {}, () => {}, () => {}, () => {});
    impEditSave();
    assert.strictEqual(it.title, "Beach Day Redux");
    assert.deepStrictEqual(it.tags, [], "a tag the user just deleted from the box must not be resurrected by a matching hashtag in the title being replaced");
  });

  await t(label + ": impEditSave's deletion guard only suppresses the deleted tag, not an unrelated hashtag also in the outgoing title", async () => {
    const it = { id: "i1", title: "Beach day #vintage #sunny", tags: ["vintage", "sunny"] };
    const imported = [it];
    // The user deleted "vintage" but kept "sunny" in the box -- "vintage" must
    // stay gone, but "sunny" surviving (already present, re-merged as a no-op)
    // proves the guard is scoped to the specific deleted tag, not a blanket
    // "skip captureOutgoingHashtags entirely" fallback.
    const els = { edTitle: { value: "Beach Day Redux" }, edDesc: { value: "" }, edTags: { value: "sunny" } };
    const document = { getElementById: (id) => els[id] };
    const factory = loadFn(src, "impEditSave", [
      "document", "_editIdx", "imported", "setCardImage", "_editImg", "persistCards", "closeGuide",
      "refreshTabsViewIfShowing", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "toast",
    ]);
    const impEditSave = factory(extractHashtags, "interests", (t)=>t.toLowerCase(), ()=>false, document, 0, imported, () => {}, "", () => {}, () => {}, () => false, () => {}, () => {}, () => {}, () => {});
    impEditSave();
    assert.strictEqual(it.title, "Beach Day Redux");
    assert.deepStrictEqual(it.tags, ["sunny"], "\"vintage\" stays deleted; \"sunny\" (kept in the box) is unaffected");
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
    const impEditSave = factory(extractHashtags, "interests", (t)=>t.toLowerCase(), ()=>false, document, 0, imported, () => {}, "", () => {}, () => {}, () => false, () => {}, () => {}, () => {}, () => {});
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
    const impEditSave = factory(extractHashtags, "interests", (t)=>t.toLowerCase(), ()=>false, document, 0, imported, () => {}, "", () => {}, () => {}, () => false, () => {}, () => {}, () => {}, () => {});
    impEditSave();
    assert.strictEqual(it.title, "Original");
    assert.strictEqual(it.origTitle, undefined);
  });
}
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
})();
