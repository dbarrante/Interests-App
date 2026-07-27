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
function loadRowRenderers(src) {
  // Minimal stand-ins for the globals these two render functions reach for.
  // esc/domain/dupeThumb/dupeOpenButtonHTML/dupeMemberKey are trivial and
  // safe to stub; _dupeSpared is the real mutable state shape (a Set).
  const factory = new Function(
    "esc", "domain", "dupeThumb", "dupeOpenButtonHTML", "dupeMemberKey", "_dupeSpared", "dupeToggleRemoval", "dupeSetKeep",
    fn(src, "dupeRowHTML") + "\n" + fn(src, "dupeLargeCardHTML") + "\nreturn { dupeRowHTML, dupeLargeCardHTML };"
  );
  return factory(
    (s) => String(s == null ? "" : s),
    () => "example.com",
    () => "<div class=ph></div>",
    () => "",
    (mem) => String(mem.scope) + ":" + String(mem.card.id),
    new Set(),
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
    const body = fn(src, "renderHealthDupes");
    assert.match(body, /_imgScanAbort/, "must check the abort flag before applying a finished scan's results");
    assert.match(body, /_imgScanGen/, "must guard against an OLDER scan's results landing after a newer one started");
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

// --- regression: applyDupeRemoval must not drop pending image-match groups
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": applyDupeRemoval preserves not-yet-processed image-match groups instead of silently dropping them", () => {
    // Found in review: after an apply, the removal path rebuilds _dupeGroups
    // from scanDuplicates() alone, which only ever returns url/title matches.
    // This code path never sets _healthScanned.dupes=false, so nothing
    // re-triggers scanImageDuplicates() to regenerate the lost groups -- in
    // "single" review mode, applying group 1 would make every OTHER
    // already-found image-match group vanish until the whole modal is closed
    // and reopened.
    const body = fn(src, "applyDupeRemoval");
    assert.match(body, /g\.imageMatch\s*&&\s*!groupsToProcess\.includes\(g\)/,
      "must carry forward image-match groups that were not part of THIS apply's groupsToProcess");
    assert.match(body, /_dupeGroups\s*=\s*scanDuplicates\(\)\.concat\(/,
      "the fresh url/title scan must be concatenated with survivors, not used as a full replacement");
  });
}

// --- byte-identical between web and pwa for every function this task touched
for (const name of ["renderHealthDupes", "dupeRowHTML", "dupeLargeCardHTML", "dupeCompactGroupHTML", "closeHealth", "applyDupeRemoval"]) {
  t(name + " is byte-identical between web and pwa", () => {
    const a = extractFn(html, name);
    const b = extractFn(pwaHtml, name);
    assert.ok(a && b, name + " not found in one or both sources");
    assert.strictEqual(a, b);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
