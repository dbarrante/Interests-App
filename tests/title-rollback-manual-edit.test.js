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
    canonicalTag: extractFn(src, "canonicalTag"),
    mergeCleanTags: extractFn(src, "mergeCleanTags"),
    captureOutgoingHashtags: extractFn(src, "captureOutgoingHashtags"),
    [name]: extractFn(src, name),
  };
  Object.keys(parts).forEach(k => assert.ok(parts[k], k + " not found in source"));
  const body = Object.values(parts).join("\n");
  const factory = new Function("extractHashtags", "AI_TAB_TAG", "tagBadPattern", "allTags", ...(extraFreeVars || []), body + "\nreturn " + name + ";");
  return factory;
}

// Real resolveImg from source (needs a Store.imgUrl stub matching the real
// service-URL shape) -- used by every impEditSave test below so the new
// "did the image section actually change" check runs against real logic,
// not a guess at what resolveImg returns.
function loadResolveImg(src) {
  const resolveImgSrc = extractFn(src, "resolveImg");
  const factory = new Function("Store", resolveImgSrc + "\nreturn resolveImg;");
  return factory({ imgUrl: (id) => "/api/img/" + id });
}

(async () => {
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  const resolveImg = loadResolveImg(src);
  await t(label + ": cardEditSave captures origTitle on the first manual rename", async () => {
    const it = { id: "s1", title: "Original" };
    const saved = [it];
    const document = { getElementById: () => ({ value: "Renamed" }) };
    const factory = loadFn(src, "cardEditSave", ["document", "toast", "saved", "_edSavedId", "Store", "closeGuide", "refreshTabsViewIfShowing", "renderSaved"]);
    const cardEditSave = factory(extractHashtags, "interests", ()=>false, ()=>[], document, () => {}, saved, "s1", { putSaved: async () => {} }, () => {}, () => false, () => {});
    await cardEditSave();
    assert.strictEqual(it.title, "Renamed");
    assert.strictEqual(it.origTitle, "Original");
  });

  await t(label + ": cardEditSave captures hashtags from the outgoing title as tags", async () => {
    const it = { id: "s1", title: "Old #vintage", tags: [] };
    const saved = [it];
    const document = { getElementById: () => ({ value: "Renamed" }) };
    const factory = loadFn(src, "cardEditSave", ["document", "toast", "saved", "_edSavedId", "Store", "closeGuide", "refreshTabsViewIfShowing", "renderSaved"]);
    const cardEditSave = factory(extractHashtags, "interests", ()=>false, ()=>[], document, () => {}, saved, "s1", { putSaved: async () => {} }, () => {}, () => false, () => {});
    await cardEditSave();
    assert.strictEqual(it.title, "Renamed");
    assert.deepStrictEqual(it.tags, ["vintage"]);
  });

  await t(label + ": cardEditSave does not re-capture on a second rename", async () => {
    const it = { id: "s1", title: "Renamed Once", origTitle: "The True Original" };
    const saved = [it];
    const document = { getElementById: () => ({ value: "Renamed Twice" }) };
    const factory = loadFn(src, "cardEditSave", ["document", "toast", "saved", "_edSavedId", "Store", "closeGuide", "refreshTabsViewIfShowing", "renderSaved"]);
    const cardEditSave = factory(extractHashtags, "interests", ()=>false, ()=>[], document, () => {}, saved, "s1", { putSaved: async () => {} }, () => {}, () => false, () => {});
    await cardEditSave();
    assert.strictEqual(it.title, "Renamed Twice");
    assert.strictEqual(it.origTitle, "The True Original", "must stay the TRUE original");
  });

  await t(label + ": cardEditSave settles origTitle when the saved title restores the original", async () => {
    const it = { id: "s1", title: "Renamed", origTitle: "Original" };
    const saved = [it];
    const document = { getElementById: () => ({ value: "Original" }) };
    const factory = loadFn(src, "cardEditSave", ["document", "toast", "saved", "_edSavedId", "Store", "closeGuide", "refreshTabsViewIfShowing", "renderSaved"]);
    const cardEditSave = factory(extractHashtags, "interests", ()=>false, ()=>[], document, () => {}, saved, "s1", { putSaved: async () => {} }, () => {}, () => false, () => {});
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
      "document", "_editIdx", "imported", "setCardImage", "_editImg", "resolveImg", "persistCards", "closeGuide",
      "refreshTabsViewIfShowing", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "toast",
    ]);
    const impEditSave = factory(extractHashtags, "interests", ()=>false, ()=>[], document, 0, imported, () => {}, "", resolveImg, () => {}, () => {}, () => false, () => {}, () => {}, () => {}, () => {});
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
      "document", "_editIdx", "imported", "setCardImage", "_editImg", "resolveImg", "persistCards", "closeGuide",
      "refreshTabsViewIfShowing", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "toast",
    ]);
    const impEditSave = factory(extractHashtags, "interests", ()=>false, ()=>[], document, 0, imported, () => {}, "", resolveImg, () => {}, () => {}, () => false, () => {}, () => {}, () => {}, () => {});
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
      "document", "_editIdx", "imported", "setCardImage", "_editImg", "resolveImg", "persistCards", "closeGuide",
      "refreshTabsViewIfShowing", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "toast",
    ]);
    const impEditSave = factory(extractHashtags, "interests", ()=>false, ()=>[], document, 0, imported, () => {}, "", resolveImg, () => {}, () => {}, () => false, () => {}, () => {}, () => {}, () => {});
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
      "document", "_editIdx", "imported", "setCardImage", "_editImg", "resolveImg", "persistCards", "closeGuide",
      "refreshTabsViewIfShowing", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "toast",
    ]);
    const impEditSave = factory(extractHashtags, "interests", ()=>false, ()=>[], document, 0, imported, () => {}, "", resolveImg, () => {}, () => {}, () => false, () => {}, () => {}, () => {}, () => {});
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
      "document", "_editIdx", "imported", "setCardImage", "_editImg", "resolveImg", "persistCards", "closeGuide",
      "refreshTabsViewIfShowing", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "toast",
    ]);
    const impEditSave = factory(extractHashtags, "interests", ()=>false, ()=>[], document, 0, imported, () => {}, "", resolveImg, () => {}, () => {}, () => false, () => {}, () => {}, () => {}, () => {});
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
      "document", "_editIdx", "imported", "setCardImage", "_editImg", "resolveImg", "persistCards", "closeGuide",
      "refreshTabsViewIfShowing", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "toast",
    ]);
    const impEditSave = factory(extractHashtags, "interests", ()=>false, ()=>[], document, 0, imported, () => {}, "", resolveImg, () => {}, () => {}, () => false, () => {}, () => {}, () => {}, () => {});
    impEditSave();
    assert.strictEqual(it.title, "Original");
    assert.strictEqual(it.origTitle, undefined);
  });

  // Test the canonicalTag-aware deleted-tag guard with real canonicalTag:
  // a plural variant of a deleted canonical tag must not resurrect it
  await t(label + ": impEditSave prevents plural hashtag variants from resurrecting deleted canonical tags", async () => {
    const it = { id: "i1", title: "Vintage collection #vintages", tags: ["vintage"] };
    const imported = [it];
    // The user deleted "vintage" from the tags box while renaming the title.
    // The outgoing title has #vintages (plural). With real canonicalTag and
    // ["vintage"] in vocabulary, it maps to "vintage". The exclude guard must
    // prevent resurrection even though it's checking both raw and canonical forms.
    const els = { edTitle: { value: "Antique collection" }, edDesc: { value: "" }, edTags: { value: "" } };
    const document = { getElementById: (id) => els[id] };
    const factory = loadFn(src, "impEditSave", [
      "document", "_editIdx", "imported", "setCardImage", "_editImg", "resolveImg", "persistCards", "closeGuide",
      "refreshTabsViewIfShowing", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "toast",
    ]);
    // allTags() returns a vocabulary with the canonical forms
    const vocab = ["vintage", "modern", "retro"];
    const impEditSave = factory(extractHashtags, "interests", ()=>false, ()=>vocab, document, 0, imported, () => {}, "", resolveImg, () => {}, () => {}, () => false, () => {}, () => {}, () => {}, () => {});
    impEditSave();
    assert.strictEqual(it.title, "Antique collection");
    assert.deepStrictEqual(it.tags, [], "plural hashtag #vintages must NOT resurrect deleted 'vintage' after canonicalTag maps it");
  });

  // Test the other direction: a non-canonical stored tag must not get
  // resurrected in canonical form via a matching hashtag
  await t(label + ": impEditSave prevents non-canonical stored tags from being resurrected as canonical via hashtags", async () => {
    const it = { id: "i1", title: "Collection #vintage", tags: ["vintages"] };  // Stored as plural (non-canonical)
    const imported = [it];
    // The user deleted "vintages" from the tags box while renaming the title.
    // The outgoing title has #vintage (singular). With real canonicalTag and
    // ["vintage"] in vocabulary, it would map to "vintage", resurrecting the
    // tag. But mergeCleanTags must check exclude against BOTH rawKey ("vintage")
    // AND canonical ("vintage"), so it catches the deletion even when the stored
    // tag was non-canonical ("vintages").
    const els = { edTitle: { value: "New collection" }, edDesc: { value: "" }, edTags: { value: "" } };
    const document = { getElementById: (id) => els[id] };
    const factory = loadFn(src, "impEditSave", [
      "document", "_editIdx", "imported", "setCardImage", "_editImg", "resolveImg", "persistCards", "closeGuide",
      "refreshTabsViewIfShowing", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "toast",
    ]);
    const vocab = ["vintage", "modern", "retro"];
    const impEditSave = factory(extractHashtags, "interests", ()=>false, ()=>vocab, document, 0, imported, () => {}, "", resolveImg, () => {}, () => {}, () => false, () => {}, () => {}, () => {}, () => {});
    impEditSave();
    assert.strictEqual(it.title, "New collection");
    assert.deepStrictEqual(it.tags, [], "non-canonical stored 'vintages' must NOT be resurrected in canonical form 'vintage' via #vintage hashtag");
  });

  // Reported bug: editing ONLY the title (never touching the image section)
  // silently deleted the card's real, untouched image. Root cause: _editImg
  // is seeded from resolveImg(it.img) -- a RESOLVED display URL like
  // /api/img/<id>, never the raw "idb:<id>" the card stores -- so the old
  // unconditional setCardImage(it, _editImg) call always looked like "the
  // user changed the image to this URL", and setCardImage's own logic then
  // deletes the OLD idb file whenever the old id equals the card's own id
  // (true for every idb-backed image). impEditSave must skip setCardImage
  // entirely when _editImg still equals resolveImg(it.img) -- i.e. nothing
  // in the image section actually changed.
  await t(label + ": impEditSave does not touch an untouched idb-backed image when only the title changes", async () => {
    const it = { id: "i1", title: "Original", img: "idb:i1", tags: [] };
    const imported = [it];
    const els = { edTitle: { value: "Renamed" }, edDesc: { value: "" }, edTags: { value: "" } };
    const document = { getElementById: (id) => els[id] };
    let setCardImageCalled = false;
    const factory = loadFn(src, "impEditSave", [
      "document", "_editIdx", "imported", "setCardImage", "_editImg", "resolveImg", "persistCards", "closeGuide",
      "refreshTabsViewIfShowing", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "toast",
    ]);
    // _editImg exactly as impEdit() seeds it when the modal opens: the
    // RESOLVED form of the card's current image, not the raw "idb:" ref.
    const editImgAsSeeded = resolveImg(it.img);
    const impEditSave = factory(
      extractHashtags, "interests", ()=>false, ()=>[], document, 0, imported,
      () => { setCardImageCalled = true; }, editImgAsSeeded, resolveImg,
      () => {}, () => {}, () => false, () => {}, () => {}, () => {}, () => {}
    );
    impEditSave();
    assert.strictEqual(it.title, "Renamed");
    assert.strictEqual(setCardImageCalled, false, "setCardImage must not run when the image section was never touched");
    assert.strictEqual(it.img, "idb:i1", "the card's real image reference must survive an unrelated title edit");
  });

  await t(label + ": impEditSave still applies a genuine image removal", async () => {
    const it = { id: "i1", title: "Original", img: "idb:i1", tags: [] };
    const imported = [it];
    const els = { edTitle: { value: "Original" }, edDesc: { value: "" }, edTags: { value: "" } };
    const document = { getElementById: (id) => els[id] };
    let setCardImageArgs = null;
    const factory = loadFn(src, "impEditSave", [
      "document", "_editIdx", "imported", "setCardImage", "_editImg", "resolveImg", "persistCards", "closeGuide",
      "refreshTabsViewIfShowing", "anchorImpOnCard", "renderImported", "restoreImpScrollSettle", "toast",
    ]);
    // The user clicked "Remove image" (edRemoveImg sets _editImg="") -- this
    // is genuinely different from resolveImg(it.img), so the change must
    // still go through.
    const impEditSave = factory(
      extractHashtags, "interests", ()=>false, ()=>[], document, 0, imported,
      (card, src) => { setCardImageArgs = src; }, "", resolveImg,
      () => {}, () => {}, () => false, () => {}, () => {}, () => {}, () => {}
    );
    impEditSave();
    assert.strictEqual(setCardImageArgs, "", "a deliberate image removal must still call setCardImage");
  });
}
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
})();
