const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadFns } = require("./_extract");

const root = path.join(__dirname, "..");
const web = fs.readFileSync(path.join(root, "web", "index.html"), "utf8");
const pwa = fs.readFileSync(path.join(root, "pwa", "index.html"), "utf8");

function featureSlice(source) {
  const start = source.indexOf("let _dupeReviewMode");
  const end = source.indexOf("// ---- Dead-link check", start);
  assert.ok(start >= 0 && end > start, "duplicate review feature block should exist");
  return source.slice(start, end);
}

for (const [name, source] of [["web", web], ["pwa", pwa]]) {
  assert.match(source, /let _dupeReviewMode\s*=\s*"single"/, name + " defaults to focused review");
  assert.match(source, /function dupeSetReviewMode\(mode\)/, name + " exposes the two review modes");
  assert.match(source, /One at a time/, name + " labels the focused mode clearly");
  assert.match(source, /All groups/, name + " retains the compact all-groups mode");
  assert.match(source, /function dupeLargeCardHTML\(/, name + " has the approved large visual card renderer");
  assert.match(source, /class="dupe-card-desc"/, name + " places description content beneath the image");
  assert.match(source, /function dupeReviewMove\(delta\)/, name + " provides non-destructive previous and skip navigation");
  assert.match(source, /function dupeToggleRemoval\(key,checked\)/, name + " preserves spared checkbox choices across re-renders");

  const block = featureSlice(source);
  assert.match(block, /groupsToProcess\s*=\s*_dupeReviewMode==="single"\s*\?\s*\[_dupeGroups\[_dupeReviewIndex\]\]\.filter\(Boolean\)\s*:\s*_dupeGroups/,
    name + " scopes focused removal to the visible group only");
  assert.match(block, /async function createDupeSafetySnapshot\(\)/, name + " has an awaited, verifiable duplicate-cleanup snapshot");
  assert.match(block, /function dupeSnapshotSignature\(/, name + " verifies journal content, not counts alone");
  assert.match(block, /async function restoreDupeSafetySnapshot\(/, name + " provides an actual PWA recovery path");
  assert.match(block, /function mergeDupeMetadata\(/, name + " defines the keeper metadata merge policy");
  assert.match(block, /const safety=await createDupeSafetySnapshot\(\);[\s\S]*?if\(!safety\)\{[\s\S]*?return;[\s\S]*?\}/,
    name + " fails closed when the safety snapshot cannot be verified");
  assert.ok(block.indexOf("await createDupeSafetySnapshot()") < block.indexOf("for(const g of groupsToProcess)"),
    name + " verifies the safety snapshot before processing removals");
  assert.match(block, /!window\.IA_IDB/, name + " retains PWA image bytes so its local journal remains recoverable");
  assert.match(block, /await Store\.putCards\(nextImported,\{confirm:true\}\)/, name + " awaits imported persistence");
  assert.match(block, /await Store\.putSaved\(nextSaved,\{confirm:true\}\)/, name + " awaits saved persistence even when the keeper crosses collections");
  assert.match(block, /_reconcileById\(nextImported,cardsResult\.preserved\)/,
    name + " folds concurrently preserved cards into the next live array");
  assert.match(block, /_reconcileById\(nextSaved,savedResult\.preserved\)/,
    name + " folds concurrently preserved saved items into the next live array");
  assert.match(block, /const liveImageRefs=dupeImageRefs\(nextImported,nextSaved\)/,
    name + " computes surviving image references before cleanup");
  assert.match(block, /if\(liveImageRefs\.has\(ref\.imageId\)\) continue/,
    name + " never deletes an image still referenced by a surviving card");
  assert.ok(block.indexOf("await Store.putSaved(nextSaved,{confirm:true})") < block.indexOf("await Store.imgDel(imageId)"),
    name + " deletes obsolete image bytes only after both collections persist");
}

const webFeature = featureSlice(web);
const pwaFeature = featureSlice(pwa);
assert.strictEqual(pwaFeature, webFeature, "duplicate-review behavior must stay mirrored between web and PWA");

const sw = fs.readFileSync(path.join(root, "pwa", "sw.js"), "utf8");
assert.match(sw, /SHELL_CACHE = "interests-pwa-shell-v40"/, "PWA cache must be bumped for the cached index edit");

const pwaIdb = fs.readFileSync(path.join(root, "pwa", "idb.js"), "utf8");
const pwaStore = fs.readFileSync(path.join(root, "pwa", "storage-pwa.js"), "utf8");
assert.match(pwaIdb, /replaceAll\(storeName, values\)/, "PWA exposes an atomic full-store replacement transaction");
assert.match(pwaStore, /return idb\.replaceAll\(storeName, stamped\)/,
  "PWA guarded replacement must not clear and repopulate in separate transactions");
assert.doesNotMatch(pwaStore, /idb\.clear\(storeName\)\.then\(\(\) => idb\.putMany/,
  "PWA must not risk an empty collection between clear and repopulate");

const { mergeDupeMetadata, dupeSnapshotSignature } = loadFns(["mergeDupeMetadata", "dupeSnapshotSignature"]);
const keeper = { id:"keep", image:"idb:keep", desc:"Primary description", tags:["one"], liked:false, captured:200, blocked:10, category:"Work" };
const source = { id:"remove", image:"idb:remove", desc:"Unique source description", notes:"Personal note", tags:["one","two"], liked:true, captured:100, blocked:20, category:"Ideas" };
mergeDupeMetadata(keeper, source);
assert.strictEqual(keeper.id, "keep", "keeper identity is never replaced");
assert.strictEqual(keeper.image, "idb:keep", "image ownership is handled separately");
assert.match(keeper.desc, /Primary description[\s\S]*Unique source description/, "both descriptions survive the merge");
assert.strictEqual(keeper.notes, "Personal note", "source-only notes survive");
assert.deepStrictEqual(keeper.tags, ["one","two"], "array metadata is unioned");
assert.strictEqual(keeper.liked, true, "positive user intent survives");
assert.strictEqual(keeper.captured, 100, "earliest capture time survives");
assert.strictEqual(keeper.blocked, 20, "latest block time survives");
assert.deepStrictEqual(keeper.dupeConflicts.category, ["Work","Ideas"], "conflicting scalar metadata remains recoverable on the keeper");

const sigA = dupeSnapshotSignature([{id:"a",title:"one"}], [{id:"s",title:"saved"}]);
const sigB = dupeSnapshotSignature([{id:"a",title:"changed"}], [{id:"s",title:"saved"}]);
assert.notStrictEqual(sigA, sigB, "journal signature detects content changes with unchanged counts");

console.log("duplicate review mode tests passed");
