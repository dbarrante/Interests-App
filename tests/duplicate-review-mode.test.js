const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { loadFns, extractFn } = require("./_extract");

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
  assert.match(source, /let _dupeReviewMode\s*=\s*"all"/, name + " defaults to showing every detected duplicate at once (all-groups)");
  assert.match(source, /let _dupeSafetyCache\s*=\s*\{\s*at:\s*0,\s*safety:\s*null\s*\};/, name + " declares the safety-snapshot reuse cache");
  assert.match(source, /const DUPE_SAFETY_REUSE_MS\s*=\s*5\*60\*1000;/, name + " throttles safety-snapshot reuse to 5 minutes");
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
  // data-safety review F-4: a restore replaces the WHOLE library, so the
  // frozen _dupeGroups from the last "Scan for duplicates" click can reference
  // stale content. Must trigger a real rescan (runDupeScan), not just reset a
  // flag that nothing else reads under manual-scan-only duplicates.
  assert.match(extractFn(source, "restoreDupeSafetySnapshot"), /if\(_healthTab===\"dupes\"\) runDupeScan\(\)/,
    name + " must explicitly rescan for duplicates after a restore, not just reset a flag");
  assert.doesNotMatch(extractFn(source, "restoreDupeSafetySnapshot"), /_healthScanned\.dupes\s*=\s*false/,
    name + " must not rely on the now-inert _healthScanned.dupes=false reset");
  assert.match(block, /function mergeDupeMetadata\(/, name + " defines the keeper metadata merge policy");
  assert.match(block, /await createDupeSafetySnapshot\(\);[\s\S]*?if\(!safety\)\{[\s\S]*?return;[\s\S]*?\}/,
    name + " fails closed when the safety snapshot cannot be verified");
  assert.ok(block.indexOf("await createDupeSafetySnapshot()") < block.indexOf("const keep=g.members.find(m=>dupeMemberKey(m)===g.keepKey)"),
    name + " verifies the safety snapshot before processing removals");
  assert.match(block, /shouldReuseDupeSafety\(_dupeSafetyCache, ?Date\.now\(\), ?!!window\.IA_IDB\)/,
    name + " reuses a recently-verified desktop safety snapshot instead of taking a fresh one on every card");
  assert.match(block, /_dupeSafetyCache\s*=\s*\{\s*at:\s*Date\.now\(\),\s*safety\s*\}/,
    name + " only arms the reuse cache after a fresh confirmed snapshot, never a reused or failed one");
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
  assert.match(block, /for\(const g of applyGroups\)\{\s*const tags=dupePeerTagsFor\(g\.members\);[\s\S]{0,120}await Store\.markNotDuplicates\(tags\.slice\(/,
    name + "persists each group's peer tags with the narrow additive operation, chunked so a large group can't wedge against the server's entry cap");
  assert.match(block, /function dupePeerTagsFor\(members\)/,
    name + " derives stable (scope,id) peer tags rather than a content-bearing group key");
  assert.match(block, /showBusyOverlay\("Saving your keep choices/, name + "shows visible progress instead of appearing frozen");
  // Duplicates is manual-scan-only (see runDupeScan/dupeScanClick): applying a
  // decision must NOT force a fresh scan. It used to (_healthScanned.dupes=false;
  // renderHealth()), which was the dominant cause of "Checking pictures for
  // duplicates…" reappearing on every keep-only decision -- see runDupeScan.
  // Scoped to applyDupeRemoval itself, not the whole feature block: restoring
  // from a safety-snapshot backup legitimately forces a rescan elsewhere
  // (restoreDupeSafetySnapshot) since the whole library just changed underneath it.
  assert.doesNotMatch(extractFn(source, "applyDupeRemoval"), /_healthScanned\.dupes\s*=\s*false/,
    name + " must never force a rescan from inside applyDupeRemoval -- only the explicit Scan/Rescan button may");
  assert.match(block, /const applySet=new Set\(applyGroups\);[\s\S]{0,120}_dupeGroups\s*=\s*_dupeGroups\s*\n?\s*\.filter\(g=>!applySet\.has\(g\)\)/,
    name + " prunes the frozen group list in place instead of rescanning");
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
// This feature edited pwa/index.html, which the service worker caches
// cache-first, so it required a shell bump to v51. Assert a FLOOR, not the
// literal version: pinning the exact string made every later, unrelated bump
// fail this test (it broke on v52), which trains people to edit the assertion
// rather than think about it. A floor still catches the real regression --
// someone lowering or reverting the bump.
const swVer = /SHELL_CACHE = "interests-pwa-shell-v(\d+)"/.exec(sw);
assert.ok(swVer, "SHELL_CACHE version not found in pwa/sw.js");
assert.ok(Number(swVer[1]) >= 51,
  "PWA cache must stay bumped for the cached index edit (>= v51, found v" + swVer[1] + ")");

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
// data-safety review F-2: pairwise dismissal tags accumulate faster than the
// old one-key-per-group scheme, so the persisted cap must match the web/pwa
// client's 200 (see tests/db.test.js for the desktop-side behavioral proof) --
// a lower persisted cap would silently evict a decision the UI thinks is saved.
assert.match(pwaIdb, /item\.dupeNotDuplicateGroups = prior\.concat\(\[entry\.key\]\)\.slice\(-200\)/,
  "PWA's persisted cap must be 200, matching web/pwa index.html's client-side cap");

const { mergeDupeMetadata, dupeSnapshotSignature, dupeGroupKey, dupeGroupDismissed, markDupeGroupNotDuplicate, dupePeerTagsFor, dupeMemberKey, shouldReuseDupeSafety } = loadFns(["mergeDupeMetadata", "dupeSnapshotSignature", "dupeGroupKey", "dupeGroupDismissed", "markDupeGroupNotDuplicate", "dupePeerTagsFor", "dupeMemberKey", "shouldReuseDupeSafety"]);
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

// Dismissal is keyed PAIRWISE by stable (scope,id) identity only -- never
// url/title -- so a later content edit or an unrelated member disappearing
// cannot silently un-dismiss a decision the user already made. dupeGroupKey
// itself is unchanged (still used for the separate _dupeImageTouched
// bookkeeping, which is deliberately session-local and content-keyed).
const members = [
  {scope:"imported",card:{id:"a"}},
  {scope:"saved",card:{id:"b"}},
];
const importedById = new Map([["a", members[0].card]]);
const savedById = new Map([["b", members[1].card]]);
assert.strictEqual(dupeGroupDismissed(members), false, "an unmarked group remains reviewable");
assert.strictEqual(markDupeGroupNotDuplicate(members, importedById, savedById), true, "retained group metadata is added");
assert.deepStrictEqual(members[0].card.dupeNotDuplicateGroups, ["p:saved:b"], "member a records a peer tag naming b, not a content-bearing group key");
assert.deepStrictEqual(members[1].card.dupeNotDuplicateGroups, ["p:imported:a"], "member b records a peer tag naming a");
assert.strictEqual(dupeGroupDismissed(members), true, "the exact retained pair is suppressed");
const changedMembers = members.concat([{scope:"imported",card:{id:"new"}}]);
assert.strictEqual(dupeGroupDismissed(changedMembers), false, "a newly joined third card is not itself dismissed with either existing member");
// The fix this file exists for: a title edit on either member must NOT
// resurface a pair the user already declared not duplicates.
members[0].card.title = "Materially revised title";
assert.strictEqual(dupeGroupDismissed(members), true, "a title edit on either card must not un-dismiss the pair");
assert.notStrictEqual(dupeMemberKey({scope:"imported",card:{id:"same"}}), dupeMemberKey({scope:"saved",card:{id:"same"}}), "cross-collection id collisions cannot select the wrong keeper");
assert.strictEqual(markDupeGroupNotDuplicate(members, importedById, savedById), false, "repeating the same decision is idempotent");

/* ---------- shouldReuseDupeSafety ----------
   The real function defaults its 4th param (windowMs) to the module-level
   DUPE_SAFETY_REUSE_MS constant, which loadFns' isolated eval doesn't carry
   over — every call below passes the window explicitly (5*60*1000) so the
   default-value branch (the only thing that would reference the missing
   outer const) never runs in this standalone context. */
const REUSE_WINDOW_MS = 5*60*1000;
assert.strictEqual(shouldReuseDupeSafety({at:0, safety:null}, Date.now(), false, REUSE_WINDOW_MS), false, "no cached safety -> false");
{
  const now = 1000000;
  assert.strictEqual(shouldReuseDupeSafety({at: now - 60000, safety: {kind:"desktop", name:"interests-backup-before-cleanup-x"}}, now, false, REUSE_WINDOW_MS), true, "cached within the window, desktop -> true");
  assert.strictEqual(shouldReuseDupeSafety({at: now - (REUSE_WINDOW_MS + 1), safety: {kind:"desktop", name:"x"}}, now, false, REUSE_WINDOW_MS), false, "cached but past the 5-minute window -> false");
  assert.strictEqual(shouldReuseDupeSafety({at: now - 60000, safety: {kind:"desktop", name:"x"}}, now, true, REUSE_WINDOW_MS), false, "cached and within window, but PWA (IA_IDB) -> false");
  assert.strictEqual(shouldReuseDupeSafety({at: now - REUSE_WINDOW_MS, safety: {kind:"desktop", name:"x"}}, now, false, REUSE_WINDOW_MS), false, "exactly at the window boundary -> false (strictly less-than)");
}

console.log("duplicate review mode tests passed");
