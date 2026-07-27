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
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": a group formed only by image similarity is labelled \"Same picture\" in the compact (all-groups) view", () => {
    const body = fn(src, "dupeCompactGroupHTML");
    assert.match(body, /imageMatch[\s\S]{0,200}?Same picture/i,
      "image-matched groups must say so — it is a weaker signal than a shared link/title");
  });
  t(label + ": a group formed only by image similarity is labelled \"Same picture\" in the one-at-a-time review view", () => {
    const body = fn(src, "renderHealthDupes");
    assert.match(body, /imageMatch[\s\S]{0,200}?Same picture/i);
  });
}

// --- structural: the scan is wired in with progress + abort guards --------
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": renderHealthDupes kicks off scanImageDuplicates and merges its groups into _dupeGroups", () => {
    const body = fn(src, "renderHealthDupes");
    assert.match(body, /scanImageDuplicates\(/);
    assert.match(body, /_dupeGroups\s*=\s*_dupeGroups\.concat\(/, "image-match groups must be ADDED to the url/title groups, not replace them");
  });
  t(label + ": renderHealthDupes bails on a stale/aborted scan before applying its results (closing/reopening the modal mid-scan must not corrupt the list)", () => {
    // A plain "does /_imgScanAbort/ and /_imgScanGen/ appear somewhere" check
    // would pass even if the two guards were reordered, or if one of them
    // didn't actually gate the _dupeGroups mutation below it. Pin the real
    // ordering instead, the same way the neighbouring "kept even if switched
    // tabs" test pins the concat-before-tab-check ordering: the newer-scan
    // guard must run before the abort guard, and both must run before a
    // (possibly stale) scan's groups are ever applied to _dupeGroups.
    const body = fn(src, "renderHealthDupes");
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
    const body = fn(src, "renderHealthDupes");
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
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": applyDupeRemoval derives its processing set from computeDupeApplyGroups and re-reads live _dupeGroups for survivors", () => {
    // The "which groups get folded into the not-duplicate sweep" decision is
    // proven behaviorally above against the real computeDupeApplyGroups.
    // What's left to prove here is wiring: that applyDupeRemoval actually
    // USES that decision (rather than re-deriving its own groupsToProcess-
    // based filter, which is the exact regression this replaces), and that
    // the final survivor line reads _dupeGroups LIVE rather than a
    // groupsToProcess/applyGroups snapshot taken before this function's
    // awaits -- the async image scan's own .then() can append newly-found
    // groups to _dupeGroups while a removal is mid-flight (proven by the
    // renderHealthDupes wiring tests above), and a snapshot taken before
    // that append would silently drop them. Exercising that live-read
    // property behaviorally would require mocking document.querySelectorAll,
    // Store, and the busy-overlay calls end to end; that DOM/Store coupling
    // makes a full behavioral test impractical, so this half stays a
    // structural source check rather than a claimed behavioral proof.
    const body = fn(src, "applyDupeRemoval");
    assert.match(body, /computeDupeApplyGroups\(groupsToProcess,\s*_dupeImageTouched,\s*dupeGroupKey\)/,
      "must derive applyGroups from the real touched-group decision, not reimplement it inline");
    assert.match(body, /for\(const g of applyGroups\)/,
      "the removal/retain loop must use applyGroups (touched-filtered), not the raw groupsToProcess snapshot");
    assert.match(body, /_dupeGroups\.filter\(g\s*=>\s*g\.imageMatch\s*&&\s*!applyGroups\.includes\(g\)\)/,
      "must read the LIVE _dupeGroups (which may have grown during the awaits above), filtered by applyGroups");
    assert.match(body, /_dupeGroups\s*=\s*scanDuplicates\(\)\.concat\(/,
      "the fresh url/title scan must be concatenated with survivors, not used as a full replacement");
  });
}

// --- byte-identical between web and pwa for every function this task touched
for (const name of ["renderHealthDupes", "dupeRowHTML", "dupeLargeCardHTML", "dupeCompactGroupHTML", "closeHealth", "applyDupeRemoval", "dupeToggleRemoval", "computeDupeApplyGroups"]) {
  t(name + " is byte-identical between web and pwa", () => {
    const a = extractFn(html, name);
    const b = extractFn(pwaHtml, name);
    assert.ok(a && b, name + " not found in one or both sources");
    assert.strictEqual(a, b);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
