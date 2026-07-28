// tests/image-dupes-ui.test.js — Task 8: wiring the image-similarity
// duplicate pass (Task 7's scanImageDuplicates) into the Library-health
// Duplicates tab.
//
// This is the first point where a wrong image-similarity grouping can cost
// the user a card: an imageMatch group's non-keep members MUST render
// unchecked by default (perceptual matching has false positives, and the
// checkbox state at render time is what applyDupeRemoval() reads straight
// out of the DOM via `#healthBody input[data-rm]:checked` — see
// applyDupeRemoval in web/index.html). A source-text regex proves a string
// exists somewhere in the file; it does NOT prove the actual rendered
// checkbox comes out unchecked. So the primary guard here extracts and RUNS
// the real dupeRowHTML/dupeLargeCardHTML (the two places a duplicate-member
// checkbox is ever rendered — compact "all groups" view and the large-card
// "one at a time" review view) against scripted stand-ins for the few
// globals they touch, the same technique tests/imagehash-cache-wiring.test.js
// uses for computeCardHash. That is the test that actually fails if a future
// edit flips the default; everything else here is a lighter structural check.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

function fn(src, name) {
  const m = extractFn(src, name);
  assert.ok(m, name + " not found in source");
  return m;
}

// --- behavioral: the real dupeRowHTML/dupeLargeCardHTML, executed ---------
function loadRowRenderers(src, opts) {
  // Minimal stand-ins for the globals these two render functions reach for.
  // esc/domain/dupeThumb/dupeOpenButtonHTML/dupeMemberKey are trivial and
  // safe to stub; _dupeSpared and _dupeImageChecked are the real mutable
  // state shapes (Sets) -- callers can seed them to prove state survives a
  // re-render instead of only proving the fresh-render default.
  opts = opts || {};
  const factory = new Function(
    "esc", "domain", "dupeThumb", "dupeOpenButtonHTML", "dupeMemberKey", "_dupeSpared", "_dupeImageChecked", "dupeToggleRemoval", "dupeSetKeep",
    fn(src, "dupeRowHTML") + "\n" + fn(src, "dupeLargeCardHTML") + "\nreturn { dupeRowHTML, dupeLargeCardHTML };"
  );
  return factory(
    (s) => String(s == null ? "" : s),
    () => "example.com",
    () => "<div class=ph></div>",
    () => "",
    (mem) => String(mem.scope) + ":" + String(mem.card.id),
    opts.dupeSpared || new Set(),
    opts.dupeImageChecked || new Set(),
    () => {},
    () => {}
  );
}
function checkboxTag(html) {
  const m = html.match(/<input[^>]*data-rm[^>]*>/);
  assert.ok(m, "no data-rm checkbox found in rendered HTML: " + html);
  return m[0];
}
// The `checked` BOOLEAN ATTRIBUTE, not just the substring "checked" anywhere
// in the tag — the onchange handler on this exact input reads
// `this.checked`, so a naive /\bchecked\b/ test matches THAT occurrence too
// (word boundaries don't stop at "."), which would make this check pass no
// matter what the template actually rendered. Requires whitespace before and
// whitespace/`>` after, matching how the template places the attribute.
function isChecked(tag) {
  return /\schecked(?=[\s>])/.test(tag);
}

const testMember = { scope: "imported", card: { id: "c1", title: "A card", url: "https://example.com/x" } };

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  const { dupeRowHTML, dupeLargeCardHTML } = loadRowRenderers(src);

  t(label + ": dupeRowHTML (compact/\"all groups\" view) renders an image-match non-keep member UNCHECKED", () => {
    const tag = checkboxTag(dupeRowHTML(testMember, 0, false, true));
    assert.ok(!isChecked(tag), "image-match row must not default to checked: " + tag);
  });
  t(label + ": dupeRowHTML preserves existing behaviour — a non-image-match (url/title) non-keep member still defaults to CHECKED", () => {
    const tag = checkboxTag(dupeRowHTML(testMember, 0, false, false));
    assert.ok(isChecked(tag), "url/title-match row must still default to checked: " + tag);
  });
  t(label + ": dupeLargeCardHTML (\"one at a time\" review view) renders an image-match non-keep member UNCHECKED", () => {
    const tag = checkboxTag(dupeLargeCardHTML(testMember, 0, false, true));
    assert.ok(!isChecked(tag), "image-match card must not default to checked: " + tag);
  });
  t(label + ": dupeLargeCardHTML preserves existing behaviour — a non-image-match non-keep member still defaults to CHECKED", () => {
    const tag = checkboxTag(dupeLargeCardHTML(testMember, 0, false, false));
    assert.ok(isChecked(tag), "url/title-match card must still default to checked: " + tag);
  });
  t(label + ": the KEEP member of a group never renders a removal checkbox at all, regardless of imageMatch", () => {
    assert.ok(!/data-rm/.test(dupeRowHTML(testMember, 0, true, true)));
    assert.ok(!/data-rm/.test(dupeLargeCardHTML(testMember, 0, true, true)));
  });
  t(label + ": a manually-CHECKED image-match member (present in _dupeImageChecked) renders CHECKED, surviving a re-render (dupeRowHTML)", () => {
    // Found in review: the row template used to gate the checked attribute on
    // `!imageMatch && !_dupeSpared.has(...)`, so once imageMatch was true it
    // ignored _dupeSpared (and any other per-member state) entirely -- a
    // manual check made via dupeToggleRemoval was thrown away the next time
    // renderHealthDupes ran (mode switch, "Keep this", dupeReviewMove, etc.),
    // because nothing about that click was ever consulted at render time.
    const key = testMember.scope + ":" + testMember.card.id;
    const { dupeRowHTML: renderRow } = loadRowRenderers(src, { dupeImageChecked: new Set([key]) });
    const tag = checkboxTag(renderRow(testMember, 0, false, true));
    assert.ok(isChecked(tag), "a member the user explicitly checked must still render checked on re-render: " + tag);
  });
  t(label + ": a manually-CHECKED image-match member (present in _dupeImageChecked) renders CHECKED, surviving a re-render (dupeLargeCardHTML)", () => {
    const key = testMember.scope + ":" + testMember.card.id;
    const { dupeLargeCardHTML: renderCard } = loadRowRenderers(src, { dupeImageChecked: new Set([key]) });
    const tag = checkboxTag(renderCard(testMember, 0, false, true));
    assert.ok(isChecked(tag), "a member the user explicitly checked must still render checked on re-render: " + tag);
  });
}

// --- structural: image-matched groups are visibly badged ------------------
// The "Same picture" badge now lives in the shared dupeWhyHTML label helper
// (which also labels link/title groups); both group views render it by calling
// dupeWhyHTML(g), so assert the badge in the helper AND the call in each view.
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": dupeWhyHTML badges an image-similarity group \"Same picture\" (weaker signal than a shared link/title)", () => {
    const body = fn(src, "dupeWhyHTML");
    assert.match(body, /imageMatch[\s\S]{0,200}?Same picture/i,
      "image-matched groups must say so — it is a weaker signal than a shared link/title");
  });
  t(label + ": the compact (all-groups) view renders the why-matched label via dupeWhyHTML", () => {
    assert.match(fn(src, "dupeCompactGroupHTML"), /dupeWhyHTML\(g\)/);
  });
  t(label + ": the one-at-a-time review view renders the why-matched label via dupeWhyHTML", () => {
    assert.match(fn(src, "renderHealthDupes"), /dupeWhyHTML\(g\)/);
  });
}

// --- structural: the scan is wired in with progress + abort guards --------
// Duplicates is manual-scan-only: the scan itself lives in runDupeScan, fired
// ONLY by dupeScanClick (the "Scan for duplicates" button) -- never by
// renderHealthDupes, opening the tab, or reopening the modal. See runDupeScan.
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": renderHealthDupes never kicks off a scan itself -- duplicates is manual-scan-only", () => {
    const body = fn(src, "renderHealthDupes");
    assert.doesNotMatch(body, /scanImageDuplicates\(/, "renderHealthDupes must be a pure render -- the scan belongs to runDupeScan, fired only by the button");
    assert.doesNotMatch(body, /scanDuplicates\(\)/, "renderHealthDupes must not run the url/title pass itself either");
  });
  t(label + ": runDupeScan kicks off scanImageDuplicates and merges its groups into _dupeGroups", () => {
    const body = fn(src, "runDupeScan");
    assert.match(body, /scanImageDuplicates\(/);
    assert.match(body, /_dupeGroups\s*=\s*_dupeGroups\.concat\(/, "image-match groups must be ADDED to the url/title groups, not replace them");
  });
  t(label + ": dupeScanClick is the ONLY caller of runDupeScan", () => {
    assert.match(fn(src, "dupeScanClick"), /runDupeScan\(\)/);
    // openHealth/closeHealth must not reset the scanned flag or the frozen
    // group list -- that reset-on-every-open was the dominant cause of
    // "Checking pictures for duplicates…" reappearing repeatedly.
    assert.doesNotMatch(fn(src, "openHealth"), /_dupeGroups\s*=\s*\[\]/);
    assert.doesNotMatch(fn(src, "closeHealth"), /_dupeGroups\s*=\s*\[\]/);
  });
  t(label + ": runDupeScan bails on a stale/aborted scan before applying its results (closing/reopening the modal mid-scan must not corrupt the list)", () => {
    // A plain "does /_imgScanAbort/ and /_imgScanGen/ appear somewhere" check
    // would pass even if the two guards were reordered, or if one of them
    // didn't actually gate the _dupeGroups mutation below it. Pin the real
    // ordering instead, the same way the neighbouring "kept even if switched
    // tabs" test pins the concat-before-tab-check ordering: the newer-scan
    // guard must run before the abort guard, and both must run before a
    // (possibly stale) scan's groups are ever applied to _dupeGroups.
    const body = fn(src, "runDupeScan");
    assert.match(body, /gen !== _imgScanGen\) return;[\s\S]{0,250}if\(_imgScanAbort\) return;[\s\S]{0,650}_dupeGroups = _dupeGroups\.concat\(imgGroups\);/,
      "the newer-scan guard must run before the abort guard, and both must run before a stale scan's groups are applied");
  });
  t(label + ": closeHealth sets _imgScanAbort so a scan in flight stops producing visible effects", () => {
    const body = fn(src, "closeHealth");
    assert.match(body, /_imgScanAbort\s*=\s*true/);
  });
  t(label + ": _imgScanAbort and _imgScanGen are declared at top level", () => {
    assert.match(src, /let _imgScanAbort\s*=\s*false;/);
    assert.match(src, /let _imgScanGen\s*=\s*0;/);
  });
  t(label + ": a finished image scan's results are kept even if the user switched health tabs while it ran (only the RE-RENDER may be skipped, not the state update)", () => {
    // Found in review: gating the `_dupeGroups = _dupeGroups.concat(imgGroups)`
    // line itself on `_healthTab==="dupes"` throws the scan's results away
    // permanently -- _healthScanned.dupes stays true, so nothing ever
    // re-fetches them, and switching back to Duplicates shows a stale,
    // image-match-free list until the whole modal is closed and reopened.
    const body = fn(src, "runDupeScan");
    assert.match(body, /_dupeGroups\s*=\s*_dupeGroups\.concat\(imgGroups\);[\s\S]{0,80}if\(_healthTab===/,
      "the concat must run unconditionally (once past abort/modal-open checks); only the re-render call may be gated on the active tab");
  });
}

// --- behavioral: computeDupeApplyGroups -- the untouched-image-group guard.
// Root cause (see review): image-match groups carry no record of whether the
// user actually engaged with them, because their members are deliberately
// UNCHECKED by default (perceptual matching has false positives). That makes
// "all members retained" indistinguishable from "the user never looked at
// this group" -- so applyDupeRemoval must not fold an image-match group into
// the not-duplicate sweep unless dupeToggleRemoval actually recorded a
// touch on it. groupKeyFn is loaded from the SAME source as the function
// under test (not reimplemented here) so this exercises the real
// dupeGroupKey derivation, the same precedent groupByImageHash's hammingFn
// parameter sets in tests/image-dupes.test.js.
function loadComputeDupeApplyGroups(src) {
  return eval("(" + fn(src, "computeDupeApplyGroups") + ")");
}
function loadDupeGroupKeyFn(src) {
  return eval("(" + fn(src, "dupeGroupKey") + ")");
}
// The round-trip neither the computeDupeApplyGroups tests below nor the row-
// render tests above actually prove: that dupeToggleRemoval -- the ONE place
// a real checkbox click reaches -- writes the exact key shapes those two
// consumers read. Both of those test groups hand computeDupeApplyGroups/the
// row templates a Set they built by hand; if dupeToggleRemoval wrote the
// wrong key, or its `_dupeGroups.find(...)` lookup missed, every other test
// here would still pass while the MEDIUM fix stayed inert end to end. Loads
// the real dupeToggleRemoval plus the real dupeGroupKey/dupeMemberKey it
// calls internally (not stand-ins), against a scripted _dupeGroups.
function loadDupeToggleRemoval(src) {
  const groupKeyFn = eval("(" + fn(src, "dupeGroupKey") + ")");
  const memberKeyFn = eval("(" + fn(src, "dupeMemberKey") + ")");
  const factory = new Function(
    "_dupeSpared", "_dupeImageChecked", "_dupeImageTouched", "_dupeGroups", "dupeMemberKey", "dupeGroupKey",
    fn(src, "dupeToggleRemoval") + "\nreturn dupeToggleRemoval;"
  );
  return { groupKeyFn, memberKeyFn, factory };
}

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": dupeToggleRemoval (the real function a checkbox click calls) records the exact dupeGroupKey computeDupeApplyGroups looks up", () => {
    const { groupKeyFn, memberKeyFn, factory } = loadDupeToggleRemoval(src);
    const keepMember = { scope: "imported", card: { id: "keep1" } };
    const nonKeepMember = { scope: "imported", card: { id: "rm1" } };
    const group = { imageMatch: true, members: [keepMember, nonKeepMember] };
    const dupeSpared = new Set(), dupeImageChecked = new Set(), dupeImageTouched = new Set();
    const dupeGroups = [group];
    const dupeToggleRemoval = factory(dupeSpared, dupeImageChecked, dupeImageTouched, dupeGroups, memberKeyFn, groupKeyFn);
    // Same key shape the onchange handler emits: mem.scope+":"+it.id.
    const key = nonKeepMember.scope + ":" + nonKeepMember.card.id;

    dupeToggleRemoval(key, true);   // simulates the user checking the box
    assert.ok(dupeImageChecked.has(key), "checking the box must record the member as explicitly checked");
    assert.strictEqual(dupeImageTouched.size, 1, "toggling a checkbox in an image-match group must record it as touched");
    assert.ok(dupeImageTouched.has(groupKeyFn(group.members)),
      "the recorded key must be the EXACT value computeDupeApplyGroups derives via groupKeyFn(g.members) -- a mismatched key would make the touch invisible to it");

    dupeToggleRemoval(key, false);   // user reconsiders and unchecks it again
    assert.ok(!dupeImageChecked.has(key), "unchecking must remove the live explicit-checked flag (row must render unchecked again)");
    assert.ok(dupeImageTouched.has(groupKeyFn(group.members)),
      "touched must stay sticky even after reverting to unchecked -- that's still a reviewed decision, not the unreviewed default");
  });
  t(label + ": dupeToggleRemoval leaves _dupeImageTouched alone for a url/title (non-image) group -- only image-match groups use this bookkeeping", () => {
    const { groupKeyFn, memberKeyFn, factory } = loadDupeToggleRemoval(src);
    const keepMember = { scope: "imported", card: { id: "keep2" } };
    const nonKeepMember = { scope: "imported", card: { id: "rm2" } };
    const group = { imageMatch: false, members: [keepMember, nonKeepMember] };
    const dupeSpared = new Set(), dupeImageChecked = new Set(), dupeImageTouched = new Set();
    const dupeGroups = [group];
    const dupeToggleRemoval = factory(dupeSpared, dupeImageChecked, dupeImageTouched, dupeGroups, memberKeyFn, groupKeyFn);
    const key = nonKeepMember.scope + ":" + nonKeepMember.card.id;

    dupeToggleRemoval(key, false);
    assert.strictEqual(dupeImageTouched.size, 0, "a url/title group toggle must not touch the image bookkeeping");
    assert.ok(dupeSpared.has(key), "existing url/title behavior is unchanged: unchecking spares the member");
  });
}

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  const computeDupeApplyGroups = loadComputeDupeApplyGroups(src);
  const groupKeyFn = loadDupeGroupKeyFn(src);

  const keepMem = { scope: "imported", card: { id: "keep1" } };
  const nonKeepMem = { scope: "imported", card: { id: "rm1" } };
  const imageGroup = { imageMatch: true, keepKey: "imported:keep1", members: [keepMem, nonKeepMem] };
  const urlGroup = {
    imageMatch: false, keepKey: "imported:keep2",
    members: [{ scope: "imported", card: { id: "keep2" } }, { scope: "imported", card: { id: "rm2" } }],
  };

  t(label + ": an UNTOUCHED image-match group is excluded from applyGroups -- left alone, not folded into the not-duplicate sweep", () => {
    const { applyGroups, untouchedImageGroups } = computeDupeApplyGroups([imageGroup], new Set(), groupKeyFn);
    assert.strictEqual(applyGroups.length, 0, "an image-match group the user never toggled a checkbox in must not be processed");
    assert.strictEqual(untouchedImageGroups, 1);
  });
  t(label + ": a TOUCHED image-match group IS included in applyGroups, dismissed as before", () => {
    const touched = new Set([groupKeyFn(imageGroup.members)]);
    const { applyGroups, untouchedImageGroups } = computeDupeApplyGroups([imageGroup], touched, groupKeyFn);
    assert.strictEqual(applyGroups.length, 1, "a group the user actually toggled a checkbox in must still be processed");
    assert.strictEqual(applyGroups[0], imageGroup);
    assert.strictEqual(untouchedImageGroups, 0);
  });
  t(label + ": a url/title (non-image) group is always included regardless of the touched set -- existing behavior is untouched", () => {
    const { applyGroups, untouchedImageGroups } = computeDupeApplyGroups([urlGroup], new Set(), groupKeyFn);
    assert.strictEqual(applyGroups.length, 1);
    assert.strictEqual(untouchedImageGroups, 0);
  });
  t(label + ": a mix of touched-image, untouched-image, and url/title groups is filtered correctly", () => {
    const untouchedImageGroup2 = {
      imageMatch: true, keepKey: "imported:keep3",
      members: [{ scope: "imported", card: { id: "keep3" } }, { scope: "imported", card: { id: "rm3" } }],
    };
    const touched = new Set([groupKeyFn(imageGroup.members)]);
    const { applyGroups, untouchedImageGroups } = computeDupeApplyGroups([imageGroup, untouchedImageGroup2, urlGroup], touched, groupKeyFn);
    assert.deepStrictEqual(applyGroups, [imageGroup, urlGroup]);
    assert.strictEqual(untouchedImageGroups, 1);
  });
}

// --- wiring: applyDupeRemoval must actually route through computeDupeApplyGroups
// A BEHAVIORAL proof that applyDupeRemoval never lets a card end up a member
// of two groups (F1) lives below, built on tests/_dupe-harness.js (the real
// applyDupeRemoval/scanDuplicates/mergeDupeMetadata, extracted and run
// against scripted Store/document stand-ins) -- an earlier version of this
// comment claimed that kind of test was impractical; it isn't, it just needs
// the same extraction technique the rest of this file already uses. What's
// left here is a lighter structural check that the SHAPE of the fix is wired
// up as described (derives from computeDupeApplyGroups, reads _dupeGroups
// live, filters survivors against the fresh scan, and has the belt-and-braces
// guard) -- the behavioral tests below are what actually prove it holds
// under execution.
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": applyDupeRemoval derives its processing set from computeDupeApplyGroups and prunes _dupeGroups in place (freeze-until-rescan)", () => {
    const body = fn(src, "applyDupeRemoval");
    assert.match(body, /computeDupeApplyGroups\(groupsToProcess,\s*_dupeImageTouched,\s*dupeGroupKey\)/,
      "must derive applyGroups from the real touched-group decision, not reimplement it inline");
    assert.match(body, /for\(const g of applyGroups\)/,
      "the removal/retain loop must use applyGroups (touched-filtered), not the raw groupsToProcess snapshot");
    assert.match(body, /if\(\(keep\.scope===\"saved\"\?rmSaved:rmImported\)\.has\(keep\.card\.id\)\) continue;/,
      "F1 belt-and-braces: a group whose keeper was already condemned by an earlier group in this SAME apply must be skipped, not processed against a stale map entry");
    assert.doesNotMatch(body, /=\s*scanDuplicates\(\)/,
      "duplicates is manual-scan-only: applying a choice must never re-run discovery -- only the explicit Scan/Rescan button may");
    assert.match(body, /const applySet\s*=\s*new Set\(applyGroups\);/,
      "processed groups must be dropped by identity, not rediscovered");
    assert.match(body, /\.filter\(g\s*=>\s*!applySet\.has\(g\)\)/,
      "a fully-processed group (removed and/or freshly marked not-duplicate) must be dropped outright");
    assert.match(body, /\.filter\(g\s*=>\s*g\.members\.length\s*>=\s*2\)/,
      "a surviving group that degenerates below 2 members after a belt-and-braces strip is no longer a duplicate set");
  });
}

// --- byte-identical between web and pwa for every function this task touched
for (const name of ["renderHealthDupes", "runDupeScan", "dupeScanClick", "dupeScanButtonHTML", "dupeRowHTML", "dupeLargeCardHTML", "dupeCompactGroupHTML", "openHealth", "closeHealth", "applyDupeRemoval", "dupeToggleRemoval", "computeDupeApplyGroups"]) {
  t(name + " is byte-identical between web and pwa", () => {
    const a = extractFn(html, name);
    const b = extractFn(pwaHtml, name);
    assert.ok(a && b, name + " not found in one or both sources");
    assert.strictEqual(a, b);
  });
}

console.log(pass + " passed, " + fail + " failed");

// --- behavioral (async): F1 double-membership, and F4 the .catch() on a
// thrown image scan. Both need real awaits, so they run in a trailing IIFE
// (same pattern tests/image-dupes.test.js uses for its own async section),
// sharing the same pass/fail counters and reporting once at the end.
const { build: buildDupeHarness } = require("./_dupe-harness");
async function at(n, fn) {
  try { await fn(); pass++; console.log("  ok  " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); }
}

// Sandbox for the F4 test: renderHealthDupes plus its ONE hard dependency
// for an empty-library scan (scanDuplicates), with scanImageDuplicates
// injected as a controllable mock. Deliberately uses EMPTY imported/saved so
// scanDuplicates() returns [] and the render body short-circuits at
// `if(!_dupeGroups.length)` right after the scan kickoff -- this test only
// needs to prove the async .then().catch() wiring around scanImageDuplicates,
// which is unaffected by which/how many groups eventually render (that's
// covered by the row/group-render tests elsewhere in this file already).
function loadRenderHealthDupesForCatch(src, scanImageDuplicatesMock) {
  const body = fn(src, "scanDuplicates") + "\n" + fn(src, "runDupeScan") + "\n" + fn(src, "dupeScanClick") +
    "\n" + fn(src, "dupeScanButtonHTML") + "\n" + fn(src, "renderHealthDupes") + `
    return {
      render: renderHealthDupes,
      scanClick: dupeScanClick,
      getProgress: () => _imgScanProgress,
      getScanned: () => _healthScanned.dupes,
    };`;
  const toasts = [];
  const warnCalls = [];
  const document = {
    getElementById: (id) => {
      if (id === "healthModal") return { classList: { contains: () => true } };   // modal stays open throughout
      return { textContent: "" };   // e.g. the #imgScanPct span / #healthList; unused here
    },
  };
  const consoleStub = { warn: (...a) => warnCalls.push(a), log: () => {}, error: () => {} };
  const factory = new Function(
    "document", "toast", "console", "scanImageDuplicates",
    "let imported=[],saved=[],_dupeGroups=[],_dupeSpared=new Set(),_dupeImageChecked=new Set()," +
    "_dupeImageTouched=new Set(),_healthScanned={},_imgScanAbort=false,_imgScanGen=0," +
    "_imgScanProgress=null,_healthTab='dupes',_dupeReviewIndex=0;\n" + body
  );
  const api = factory(document, (m) => toasts.push(m), consoleStub, scanImageDuplicatesMock);
  api.toasts = toasts; api.warnCalls = warnCalls;
  return api;
}

(async () => {

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {

  // ---- F1: a card must never end up a member of two _dupeGroups entries ---
  await at(label + ": applyDupeRemoval never lets a card end up in two groups, and a merge-created match is frozen out until the next explicit scan (F1 + freeze-until-rescan)", async () => {
    // Reproduces the reported incident: an image-match group's keeper (K)
    // has an EMPTY title; its non-keep member (M) gets removed and ticked,
    // and mergeDupeMetadata fills K's title from M's. A SEPARATE card (L)
    // already carries that exact title AND is independently the keeper of
    // its own untouched image-match group (with member P). Titles must be
    // >=10 chars / >=2 words to clear normTitle's grouping floor.
    //
    // Under freeze-until-rescan, K and L must NOT auto-join a fresh title
    // group after this apply -- applyDupeRemoval no longer re-runs discovery
    // (that rescan was deleted; see runDupeScan/dupeScanClick). The old F1 fix
    // caught this exact scenario by filtering the rescan's output; the new
    // design sidesteps it entirely by never rescanning. A later api.scan()
    // (the user explicitly clicking "Scan for duplicates" again) proves the
    // merge really did happen and the match is genuinely discoverable, just
    // not auto-surfaced mid-review.
    const memberKey = (scope, id) => scope + ":" + id;
    const K = { id: "K", title: "", ts: 1 };                         // older tie-break winner once titled
    const M = { id: "M", title: "Echo Cat Adventures" };
    const L = { id: "L", title: "Echo Cat Adventures", ts: 1000 };
    const P = { id: "P", desc: "P note aaaaaaaaaa" };

    const api = buildDupeHarness(src);
    const G1 = { imageMatch: true, keepKey: memberKey("imported", "K"), members: [{ scope: "imported", card: K }, { scope: "imported", card: M }] };
    const G3 = { imageMatch: true, keepKey: memberKey("imported", "L"), members: [{ scope: "imported", card: L }, { scope: "imported", card: P }] };
    api.set({ imported: [K, M, L, P], saved: [], groups: [G1, G3], mode: "all", touched: [api.groupKey(G1.members)] });
    api.checkedKeys.add("imported:M");

    await api.run();   // apply #1: only ticks M, in G1
    const st1 = api.get();

    // The core F1 property: no card is a member of two groups after an apply.
    const seen = new Map();
    for (const g of st1._dupeGroups) {
      for (const m of g.members) {
        const k = m.scope + ":" + m.card.id;
        assert.ok(!seen.has(k), "card " + k + " is a member of two _dupeGroups entries after one apply — the exact defect a later 'Apply choices' click would silently over-process");
        seen.set(k, g);
      }
    }
    assert.ok(!st1.imported.some(c => c.id === "M"), "M was ticked and must be removed");
    const kNow = st1.imported.find(c => c.id === "K");
    assert.strictEqual(kNow && kNow.title, "Echo Cat Adventures", "mergeDupeMetadata must still fill K's empty title from M's");

    // Freeze-until-rescan: G1 is fully processed and dropped; G3 was never
    // touched by this apply and must survive UNCHANGED -- no fresh title
    // group for K/L, even though their titles now match.
    assert.strictEqual(st1._dupeGroups.length, 1, "only G3 should remain -- G1 is done, and nothing re-discovers a K/L match mid-review");
    assert.strictEqual(st1._dupeGroups[0], G3, "the surviving group must be the SAME G3 reference, untouched by a rescan");
    assert.ok(!st1._dupeGroups.some(g => !g.imageMatch), "no fresh (non-image) title group may appear without an explicit rescan");

    // Prove the match is real and discoverable, just not auto-surfaced: an
    // explicit rescan (api.scan(), standing in for the user clicking "Scan for
    // duplicates" again) DOES find K and L now.
    const rescanned = api.scan();
    const kl = rescanned.find(g => g.members.some(m => m.card.id === "K") && g.members.some(m => m.card.id === "L"));
    assert.ok(kl, "an explicit rescan must find the K/L title match the merge created -- the data is correct, only auto-discovery is frozen");

    // apply #2: the user reviews the still-surviving G3 (touched + P ticked).
    api.checkedKeys.clear();
    api.checkedKeys.add("imported:P");
    api.set({ touched: [api.groupKey(G3.members)] });

    await api.run();   // apply #2
    const st2 = api.get();

    assert.ok(st2.imported.some(c => c.id === "K"), "K was never ticked in either apply and must survive");
    const pSurvives = st2.imported.some(c => c.id === "P");
    const pDataAbsorbed = st2.imported.some(c => c.desc && c.desc.indexOf("P note") >= 0);
    assert.ok(pSurvives || pDataAbsorbed, "P's card or the data merged from it must survive somewhere — losing both means a merge target was deleted with P's data still inside it (the exact 'merge target vanishes' failure from the report)");
  });

  // ---- F1: the belt-and-braces guard, independent of the primary fix ------
  await at(label + ": applyDupeRemoval skips a group whose keeper was already condemned by an earlier group in the SAME apply, rather than merging into a doomed card (F1 belt-and-braces)", async () => {
    // Hand-crafts the double-membership directly (bypassing the merge/rescan
    // mechanism the test above exercises) so this pins the LAST-RESORT guard
    // on its own: B is simultaneously the REMOVED member of group X and the
    // KEEP of group Y. X processes first and condemns B; Y's keeper lookup
    // must then be skipped, not treated as valid.
    const memberKey = (scope, id) => scope + ":" + id;
    const A = { id: "A" };
    const B = { id: "B" };
    const D = { id: "D", desc: "D note zzzzzzzzzz" };
    const api = buildDupeHarness(src);
    const X = { imageMatch: false, keepKey: memberKey("imported", "A"), members: [{ scope: "imported", card: A }, { scope: "imported", card: B }] };
    const Y = { imageMatch: false, keepKey: memberKey("imported", "B"), members: [{ scope: "imported", card: B }, { scope: "imported", card: D }] };
    api.set({ imported: [A, B, D], saved: [], groups: [X, Y], mode: "all" });
    api.checkedKeys.add("imported:B");   // remove B from X
    api.checkedKeys.add("imported:D");   // remove D from Y, keeping B — which X is about to delete

    await api.run();
    const st = api.get();
    const dSurvives = st.imported.some(c => c.id === "D");
    const dDataAbsorbed = st.imported.some(c => c.desc && c.desc.indexOf("D note") >= 0);
    assert.ok(dSurvives || dDataAbsorbed, "D's card or its merged data must survive — its merge target (B) was already condemned by group X earlier in the SAME apply");
  });

  // ---- single-mode Apply with nothing checked marks the current group OK and moves on ----
  await at(label + ": one-at-a-time Apply with NOTHING checked marks the current (untouched image) group not-duplicate", async () => {
    // The reported gap: in single review an image-match group renders all-unchecked
    // by default, so clicking Apply with nothing ticked used to hit "Nothing to
    // apply yet" and leave the group in place. The explicit per-group Apply IS the
    // review signal, so the current group is treated as touched -> marked
    // not-duplicate -> advanced past, exact AND image groups alike.
    const api = buildDupeHarness(src);
    const K = { id: "K", title: "Sunset Over Water" };
    const N = { id: "N", title: "Sunset Over Water" };
    const G = { imageMatch: true, keepKey: "imported:K", members: [{ scope: "imported", card: K }, { scope: "imported", card: N }] };
    api.set({ imported: [K, N], saved: [], groups: [G], mode: "single", index: 0 });   // nothing touched, nothing checked
    await api.run();
    const marked = api.log.markNotDup.flat();
    assert.ok(marked.includes("imported:K") && marked.includes("imported:N"),
      "both members of the reviewed image group must be marked not-duplicate, got: " + JSON.stringify(api.log.markNotDup));
    const st = api.get();
    assert.ok(st.imported.some(c => c.id === "K") && st.imported.some(c => c.id === "N"),
      "nothing was checked, so no card may be removed");
  });

  await at(label + ": all-groups Apply with nothing checked still leaves an UNTOUCHED image group alone (bulk safety unchanged)", async () => {
    // The scope boundary: the single-mode change must NOT bleed into the bulk
    // 'Apply choices' path, where an untouched image group may be off-screen and
    // must keep being offered rather than silently dismissed.
    const api = buildDupeHarness(src);
    const K2 = { id: "K2", title: "Harbor At Dawn" };
    const N2 = { id: "N2", title: "Harbor At Dawn" };
    const G = { imageMatch: true, keepKey: "imported:K2", members: [{ scope: "imported", card: K2 }, { scope: "imported", card: N2 }] };
    api.set({ imported: [K2, N2], saved: [], groups: [G], mode: "all" });   // nothing touched, nothing checked
    await api.run();
    assert.strictEqual(api.log.markNotDup.flat().length, 0,
      "a bulk 'Apply choices' must NOT dismiss an image group the user never touched");
  });

  // ---- data-safety review F-3: a large group must never wedge against the server's entry cap ----
  await at(label + ": a keep-all decision on a large group is chunked so it can never be permanently blocked (F-3)", async () => {
    // Pairwise tags grow O(n^2) with group size (n members -> n*(n-1) entries),
    // while core/server.js's /api/duplicates/not-duplicate caps a single
    // request's entries -- so a big shared-title group (e.g. many posts
    // sharing one FB fallback title, which this project has hit before) must
    // never be sent as ONE oversized call that permanently 400s.
    const api = buildDupeHarness(src);
    const N = 25;   // 25*24 = 600 pairwise entries -- 3+ chunks at 200/call
    const cards = Array.from({ length: N }, (_, i) => ({ id: "m" + i, title: "Shared Fallback Post Title Here" }));
    const G = { imageMatch: false, keepKey: "imported:m0", members: cards.map(c => ({ scope: "imported", card: c })) };
    api.set({ imported: cards, saved: [], groups: [G], mode: "all" });   // nothing checked -> keep-all path
    await api.run();

    assert.ok(api.log.markNotDup.length > 1, "a 600-entry decision must be split across multiple calls, not sent as one");
    for (const batch of api.log.markNotDup) {
      assert.ok(batch.length <= 200, "every chunk must stay comfortably under the server's per-request entry cap, got " + batch.length);
    }
    const totalEntries = api.log.markNotDup.reduce((n, b) => n + b.length, 0);
    assert.strictEqual(totalEntries, N * (N - 1), "every pairwise entry must still be sent, just chunked");
    assert.strictEqual(api.get().imported.length, N, "a keep-all decision must not remove any card");
  });

  // ---- scanDuplicates precision: no transitive chaining, no over-broad link keys ----
  await at(label + ": scanDuplicates does NOT chain unrelated cards through a shared intermediary", async () => {
    // A shares a TITLE with B; B shares a LINK with C; A and C share nothing. The old
    // union-find lumped {A,B,C}, so A and C -- totally unlike -- landed in one group.
    const api = buildDupeHarness(src);
    const A = { id: "A", url: "https://site-a.com/a-page", title: "Braided Pesto Bread Recipe" };
    const B = { id: "B", url: "https://shared.com/p/xyz", title: "Braided Pesto Bread Recipe" };
    const C = { id: "C", url: "https://shared.com/p/xyz", title: "Totally Different Article Text" };
    api.set({ imported: [A, B, C], saved: [] });
    for (const g of api.scan()) {
      const ids = g.members.map(m => m.card.id);
      assert.ok(!(ids.includes("A") && ids.includes("C")),
        "A (title-match to B) and C (link-match to B) share nothing and must not be chained together");
    }
  });

  await at(label + ": scanDuplicates ignores an over-broad bare-host link key (auto-import profile/home URL trap)", async () => {
    // Three unrelated posts all captured with the same bare profile URL. dupeKey ->
    // "instagram.com" (no path, no id) must not group them.
    const api = buildDupeHarness(src);
    const P1 = { id: "P1", url: "https://instagram.com/", title: "Sunset photography tips" };
    const P2 = { id: "P2", url: "https://instagram.com/", title: "Best pasta in Rome guide" };
    const P3 = { id: "P3", url: "https://instagram.com/", title: "How to fix a leaky faucet" };
    api.set({ imported: [P1, P2, P3], saved: [] });
    assert.strictEqual(api.scan().length, 0, "a bare-host link key must not group unrelated posts");
  });

  await at(label + ": scanDuplicates still groups a real shared link and a real shared title", async () => {
    const api = buildDupeHarness(src);
    const L1 = { id: "L1", url: "https://blog.com/article/123", title: "x" };
    const L2 = { id: "L2", url: "https://blog.com/article/123", title: "y" };
    const T1 = { id: "T1", url: "https://one.com/a", title: "Ten Great Camping Spots" };
    const T2 = { id: "T2", url: "https://two.com/b", title: "Ten Great Camping Spots" };
    api.set({ imported: [L1, L2, T1, T2], saved: [] });
    const groups = api.scan();
    const hasPair = (a, b) => groups.some(g => { const ids = g.members.map(m => m.card.id); return ids.includes(a) && ids.includes(b); });
    assert.ok(hasPair("L1", "L2"), "cards sharing a real link must still group");
    assert.ok(hasPair("T1", "T2"), "cards sharing a real long title must still group");
  });

  // ---- F4: a thrown image scan must not leave the progress banner up forever
  await at(label + ": renderHealthDupes clears the progress banner, logs, and toasts if scanImageDuplicates throws — instead of leaving 'Checking pictures…' on screen forever (F4)", async () => {
    let rejectFn;
    const scanImageDuplicatesMock = () => new Promise((resolve, reject) => { rejectFn = reject; });
    const api = loadRenderHealthDupesForCatch(src, scanImageDuplicatesMock);

    api.scanClick();   // kicks off the scan synchronously (the "Scan for duplicates" button)
    assert.deepStrictEqual(api.getProgress(), { done: 0, total: 0 }, "sanity: the scan must be marked in-progress immediately");
    assert.strictEqual(api.getScanned(), true, "sanity: _healthScanned.dupes is set before the async scan even starts");

    rejectFn(new Error("imagehash.js failed to load"));
    await new Promise(r => setTimeout(r, 0));   // let the microtask queue drain so .catch() runs

    assert.strictEqual(api.getProgress(), null, "a thrown scan must clear the progress banner — before this fix it stayed stuck at the last known percentage forever");
    assert.strictEqual(api.toasts.length, 1, "the user must be told the check failed, not left staring at a frozen progress line with no explanation");
    assert.match(api.toasts[0], /couldn.t check pictures/i);
    assert.strictEqual(api.warnCalls.length, 1, "the failure must be logged");
  });
}

console.log((pass) + " passed, " + fail + " failed (cumulative)");
process.exit(fail ? 1 : 0);

})();
