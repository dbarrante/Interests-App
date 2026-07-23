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
  assert.match(source, /function dupeSetFullscreen\(on\)/, name + " exposes a viewport-filling duplicate review mode");
  assert.match(source, /classList\.toggle\("dupe-fullscreen",_dupeFullScreen\)/,
    name + "fullscreen mode is implemented as modal layout state without invoking browser fullscreen permissions");
  assert.match(source, /function dupeOpenOriginal\(button\)/, name + "opens a duplicate by collection and id");
  assert.match(source, /data-dupe-scope=/, name + "duplicate open controls carry collection identity");
  assert.match(source, /data-dupe-id=/, name + "duplicate open controls carry card identity");
  assert.match(source, />Open original<\//, name + "labels the per-duplicate confirmation action clearly");
  assert.match(source, /onclick="dupeOpenOriginal\(this\)"/, name + "wires every duplicate open action through safe lookup");
  assert.match(source, /ondblclick="dupeOpenOriginal\(this\)"/, name + "double-clicking a duplicate photo opens its original page");
  assert.match(source, /title="Double-click to open original"/, name + "duplicate photos advertise the double-click action");
  assert.match(source, /function dupeGroupKey\(members\)/, name + "defines an exact retained-group identity");
  assert.match(source, /function dupeGroupDismissed\(members\)/, name + "suppresses only explicitly dismissed duplicate groups");
  assert.match(source, /function markDupeGroupNotDuplicate\(members,importedById,savedById\)/,
    name + "persists not-duplicate decisions on every retained card");
  assert.match(source, /function dupeMemberKey\(mem\)/, name + "uses collection plus id for keeper identity");
  assert.match(source, /data-imgid="\$\{esc\(String\(it\.img\)\.slice\(4\)\)\}"/,
    name + "renders an imported survivor from its persisted image pointer");
  assert.match(source, /data-imgid="\$\{esc\(String\(v\)\.slice\(4\)\)\}"/,
    name + "renders duplicate thumbnails from the retained image pointer");
  assert.doesNotMatch(source, /data-imgid="\$\{esc\(it\.id\)\}"/,
    name + "never assumes an idb image pointer equals the card id");
  assert.match(source, /if\(oldId===String\(it\.id\)\)\{ Store\.imgDel\(oldId\); \}/,
    name + "does not delete a retained image pointer owned by a merged source card");

  const block = featureSlice(source);
  assert.match(block, /groupsToProcess\s*=\s*_dupeReviewMode==="single"\s*\?\s*\[_dupeGroups\[_dupeReviewIndex\]\]\.filter\(Boolean\)\s*:\s*_dupeGroups/,
    name + " scopes focused removal to the visible group only");
  assert.match(block, /async function createDupeSafetySnapshot\(\)/, name + " has an awaited, verifiable duplicate-cleanup snapshot");
  assert.match(block, /Store\.backupNow\(\{safety:true\}\)/, name + "requests a unique non-rotating desktop cleanup snapshot");
  assert.match(block, /function dupeSnapshotSignature\(/, name + " verifies journal content, not counts alone");
  assert.match(block, /async function restoreDupeSafetySnapshot\(/, name + " provides an actual PWA recovery path");
  assert.match(block, /function mergeDupeMetadata\(/, name + " defines the keeper metadata merge policy");
  assert.match(block, /const safety=await createDupeSafetySnapshot\(\);[\s\S]*?if\(!safety\)\{[\s\S]*?return;[\s\S]*?\}/,
    name + " fails closed when the safety snapshot cannot be verified");
  assert.ok(block.indexOf("await createDupeSafetySnapshot()") < block.indexOf("for(const g of groupsToProcess)"),
    name + " verifies the safety snapshot before processing removals");
  assert.match(block, /!window\.IA_IDB/, name + " retains PWA image bytes so its local journal remains recoverable");
  assert.match(block, /Store\.ensureImage\(id\)[\s\S]*?Store\.imgHas\(id\)/,
    name + " hydrates and verifies every referenced PWA image before snapshotting");
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
  assert.doesNotMatch(block, /if\(!checked\.size\)\{\s*toast\("Nothing selected to remove"\);\s*return;/,
    name + "can persist a not-duplicate decision when every remove box is unchecked");
  assert.ok(block.indexOf("markDupeGroupNotDuplicate(") < block.indexOf("await Store.putCards(nextImported,{confirm:true})"),
    name + "marks retained groups before the guarded collection writes");
  assert.ok(block.indexOf("if(!checked.size)") < block.indexOf("await createDupeSafetySnapshot()"),
    name + "routes keep-all decisions around the destructive backup and full-library rewrite path");
  assert.match(block, /for\(const batch of batches\.values\(\)\) await Store\.markNotDuplicates\(batch\)/,
    name + "persists each complete keep-all group with the narrow additive operation");
  assert.match(block, /g\.members\.forEach\(mem=>changes\.push\(/,
    name + "submits every member so a partially marked group remains retryable");
  assert.match(block, /showBusyOverlay\("Saving your keep choices/, name + "shows visible progress instead of appearing frozen");
  assert.match(block, /_healthScanned\.dupes=false;[\s\S]*?renderHealth\(\)/,
    name + "forces a fresh duplicate scan after the decision persists");
}

const webFeature = featureSlice(web);
const pwaFeature = featureSlice(pwa);
assert.strictEqual(pwaFeature, webFeature, "duplicate-review behavior must stay mirrored between web and PWA");

for (const [name, source] of [["web", web], ["pwa", pwa]]) {
  assert.match(source, /#healthModal\.dupe-fullscreen\{[^}]*padding:0/, name + " fullscreen removes modal gutters");
  assert.match(source, /#healthModal\.dupe-fullscreen \.dupe-box\{[^}]*width:100vw[^}]*height:100dvh/,
    name + " fullscreen fills the available viewport");
}

const sw = fs.readFileSync(path.join(root, "pwa", "sw.js"), "utf8");
assert.match(sw, /SHELL_CACHE = "interests-pwa-shell-v48"/, "PWA cache must be bumped for the cached index edit");

const pwaIdb = fs.readFileSync(path.join(root, "pwa", "idb.js"), "utf8");
const pwaStore = fs.readFileSync(path.join(root, "pwa", "storage-pwa.js"), "utf8");
assert.match(pwaIdb, /replaceAll\(storeName, values\)/, "PWA exposes an atomic full-store replacement transaction");
assert.match(pwaStore, /return idb\.replaceAll\(storeName, stamped\)/,
  "PWA guarded replacement must not clear and repopulate in separate transactions");
assert.doesNotMatch(pwaStore, /idb\.clear\(storeName\)\.then\(\(\) => idb\.putMany/,
  "PWA must not risk an empty collection between clear and repopulate");
assert.match(pwaStore, /markNotDuplicates\(entries\)/, "PWA exposes the same narrow additive decision operation");
assert.match(pwaStore, /return idb\.markNotDuplicates\(/,
  "PWA delegates keep choices to one read-modify-write transaction");
assert.match(pwaIdb, /markNotDuplicates\(entries\)[\s\S]*?db\.transaction\(\["cards", "saved"\], "readwrite"\)/,
  "PWA reads and writes card and saved markers inside one transaction");
assert.match(pwaIdb, /transaction\.onabort = \(\) => reject/,
  "PWA multi-row writes reject transaction aborts");

const { mergeDupeMetadata, dupeSnapshotSignature, dupeGroupKey, dupeGroupDismissed, markDupeGroupNotDuplicate, dupeMemberKey } = loadFns(["mergeDupeMetadata", "dupeSnapshotSignature", "dupeGroupKey", "dupeGroupDismissed", "markDupeGroupNotDuplicate", "dupeMemberKey"]);
const keeper = { id:"keep", image:"idb:keep", desc:"Primary description", tags:["one"], liked:false, captured:200, blocked:10, category:"Work", meta:{owner:"keeper"} };
const source = { id:"remove", image:"idb:remove", desc:"Unique source description", notes:"Personal note", tags:["one","two"], liked:true, captured:100, blocked:20, category:"Ideas", meta:{owner:"source",sourceOnly:true}, dupeNotDuplicateGroups:["old-unrelated-group"] };
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
assert.deepStrictEqual(keeper.dupeConflicts.meta, [{owner:"keeper"},{owner:"source",sourceOnly:true}], "conflicting nested metadata remains recoverable on the keeper");
assert.strictEqual(keeper.meta.sourceOnly, true, "source-only nested metadata survives");
assert.strictEqual(keeper.dupeNotDuplicateGroups, undefined, "a deleted card cannot transfer unrelated not-duplicate decisions to its keeper");

const sigA = dupeSnapshotSignature([{id:"a",title:"one"}], [{id:"s",title:"saved"}]);
const sigB = dupeSnapshotSignature([{id:"a",title:"changed"}], [{id:"s",title:"saved"}]);
assert.notStrictEqual(sigA, sigB, "journal signature detects content changes with unchanged counts");

const members = [
  {scope:"imported",card:{id:"a"}},
  {scope:"saved",card:{id:"b"}},
];
const importedById = new Map([["a", members[0].card]]);
const savedById = new Map([["b", members[1].card]]);
const groupKey = dupeGroupKey(members);
assert.strictEqual(dupeGroupDismissed(members), false, "an unmarked group remains reviewable");
assert.strictEqual(markDupeGroupNotDuplicate(members, importedById, savedById), true, "retained group metadata is added");
assert.deepStrictEqual(members[0].card.dupeNotDuplicateGroups, [groupKey]);
assert.deepStrictEqual(members[1].card.dupeNotDuplicateGroups, [groupKey]);
assert.strictEqual(dupeGroupDismissed(members), true, "the exact retained group is suppressed");
const changedMembers = members.concat([{scope:"imported",card:{id:"new",dupeNotDuplicateGroups:[groupKey]}}]);
assert.strictEqual(dupeGroupDismissed(changedMembers), false, "a newly joined matching card resurfaces the changed group");
members[0].card.title = "Materially revised title";
assert.notStrictEqual(dupeGroupKey(members), groupKey, "duplicate-relevant content changes invalidate the retained-group decision");
assert.strictEqual(dupeGroupDismissed(members), false, "the same cards resurface after duplicate evidence changes");
assert.notStrictEqual(dupeMemberKey({scope:"imported",card:{id:"same"}}), dupeMemberKey({scope:"saved",card:{id:"same"}}), "cross-collection id collisions cannot select the wrong keeper");
members[0].card.title = "";
assert.strictEqual(markDupeGroupNotDuplicate(members, importedById, savedById), false, "repeating the same decision is idempotent");

console.log("duplicate review mode tests passed");
