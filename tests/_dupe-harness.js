// tests/_dupe-harness.js — sandbox harness for the duplicate-removal pipeline
// (applyDupeRemoval / scanDuplicates / mergeDupeMetadata / computeDupeApplyGroups
// and friends), extracted from the REAL web/pwa index.html source (not
// reimplemented) and run against scripted stand-ins for Store/document/toast/
// etc. — the same extraction technique tests/imagehash-cache-wiring.test.js
// uses for computeCardHash.
//
// Used by tests/image-dupes-ui.test.js for BEHAVIORAL (not just source-regex)
// proof that applyDupeRemoval's group bookkeeping holds under real execution:
// a source regex can prove a string exists somewhere in the file, but it
// cannot prove that running the actual removal logic never lets a card end
// up processed by two groups in the same or a following apply. build(src)
// takes the raw HTML text (web or pwa) so the same harness drives both.
const path = require("path");
const { extractFn } = require("./_extract");
const capState = require(path.join(__dirname, "..", "web", "lib", "capture-state.js"));
const { dupeKey } = require(path.join(__dirname, "..", "web", "lib", "urlkey.js"));
const isBadImg = capState.isBadImg;

const NAMES = [
  "applyDupeRemoval", "computeDupeApplyGroups", "shouldReuseDupeSafety",
  "scanDuplicates", "dupeGroupKey", "dupeGroupDismissed", "dupePeerTagsFor",
  "markDupeGroupNotDuplicate", "dupeMemberKey", "dupePrimary",
  "dupeImageRefs", "mergeDupeMetadata", "itemImg", "setItemImg",
  "setCardImage", "setSavedImage", "resolveImg", "normTitle",
];

function build(src, opts) {
  opts = opts || {};
  const srcs = NAMES.map(n => {
    const s = extractFn(src, n);
    if (!s) throw new Error("could not extract " + n + " from source");
    return s;
  });
  const log = { imgDel: [], putCards: [], putSaved: [], toasts: [], markNotDup: [], imgCopy: [] };
  const imgStore = new Set(opts.images || []);
  const Store = {
    imgUrl: id => "blob:img/" + id,
    imgPut: (id) => { imgStore.add(String(id)); },
    imgDel: async id => { log.imgDel.push(String(id)); imgStore.delete(String(id)); },
    imgHas: async id => imgStore.has(String(id)),
    imgCopy: async (a, b) => { log.imgCopy.push(a + "->" + b); imgStore.add(String(b)); },
    fpSet: () => {}, fpDel: async () => {},
    putCards: async rows => { log.putCards.push(rows.map(c => c.id)); return {}; },
    putSaved: async rows => { log.putSaved.push(rows.map(c => c.id)); return {}; },
    markNotDuplicates: async batch => { log.markNotDup.push(batch.map(b => b.scope + ":" + b.id)); },
  };
  const checkedKeys = new Set();
  const document = {
    querySelectorAll: () => Array.from(checkedKeys).map(k => ({ getAttribute: () => k })),
    getElementById: () => ({ classList: { contains: () => true }, textContent: "" }),
  };
  const body = srcs.join("\n") + `
    return {
      run: applyDupeRemoval,
      scan: scanDuplicates,
      groupKey: dupeGroupKey,
      dismissed: dupeGroupDismissed,
      markNotDup: markDupeGroupNotDuplicate,
      primary: dupePrimary,
      memberKey: dupeMemberKey,
      get: () => ({ imported, saved, _dupeGroups, _dupeImageTouched, _dupeImageChecked }),
      set: (o) => {
        if (o.imported) imported = o.imported;
        if (o.saved) saved = o.saved;
        if (o.groups) _dupeGroups = o.groups;
        if (o.mode) _dupeReviewMode = o.mode;
        if (o.index != null) _dupeReviewIndex = o.index;
        if (o.touched) o.touched.forEach(k => _dupeImageTouched.add(k));
        if (o.imgChecked) o.imgChecked.forEach(k => _dupeImageChecked.add(k));
      },
    };`;
  const factory = new Function(
    "document", "window", "Store", "toast", "showBusyOverlay", "hideBusyOverlay",
    "updateBusyOverlay", "requestAnimationFrame", "createDupeSafetySnapshot",
    "rollbackDupePersistence", "updateCounts", "_reconcileById", "renderHealth",
    "renderHealthDupes", "renderImported", "renderSaved", "isBadImg", "dupeKey",
    "DUPE_SAFETY_REUSE_MS", "imgFp", "_fpMap", "console", "__log",
    "let imported=[],saved=[],_dupeGroups=[],_dupeSpared=new Set(),_dupeImageChecked=new Set()," +
    "_dupeImageTouched=new Set(),_dupeReviewMode='all',_dupeReviewIndex=0,_dupeSafetyCache=null," +
    "_healthScanned={},curTab='none';\n" + body
  );
  const api = factory(
    document, {}, Store,
    (m) => log.toasts.push(m),
    () => {}, () => {}, () => {},
    (cb) => cb(),
    async () => ({ kind: "desktop", name: "safety-backup" }),   // snapshot always succeeds
    async () => false,
    () => {}, () => {}, () => {}, () => {}, () => {}, () => {},
    isBadImg, dupeKey, 5 * 60 * 1000, () => "fp", {}, console, log
  );
  api.log = log; api.checkedKeys = checkedKeys; api.imgStore = imgStore;
  return api;
}
module.exports = { build };
