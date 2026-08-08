// tests/dupe-primary-titleset.test.js — dupePrimary() (the heuristic that
// auto-picks which duplicate survives a Duplicates-tab merge) never weighed
// whether a title was human-settled (titleSet). Two devices independently
// auto-importing the SAME post before they'd synced with each other is
// expected/inherent (per-device capture can't see what hasn't synced in
// yet) -- but when the user later runs Duplicates to merge the resulting
// pair, the old scoring (image/desc/tags/date only) could easily pick the
// UNEDITED copy as the survivor whenever it happened to have equal-or-richer
// incidental metadata (very common, since auto-import fills desc/tags the
// same way on every capture) -- silently discarding the user's edited or
// AI-picker-accepted title into dupeConflicts. Reported live: "one has the
// edited title, and the others are the original."
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { build } = require("./_dupe-harness");

const web = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwa = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, f) { try { f(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.message)); } }

for (const [label, src] of [["web", web], ["pwa", pwa]]) {
  t(label + ": dupePrimary keeps the titleSet (human-settled) copy even when the un-settled copy has richer incidental metadata", () => {
    const api = build(src);
    const edited = { scope: "imported", card: {
      id: "A", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Exercise Strategies to Reduce Belly Fat Effectively",
      titleSet: true, img: "idb:A",
      // deliberately WEAKER incidental signals than the un-settled copy below
    } };
    const original = { scope: "imported", card: {
      id: "B", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Who knew it was so simple 😲",
      img: "idb:B", desc: "A much longer saved-from-facebook description string", tags: ["a", "b", "c"], sdate: 12345,
    } };
    const primary = api.primary([edited, original]);
    assert.strictEqual(primary.card.id, "A", "the titleSet copy must win regardless of the other copy's richer desc/tags/sdate");
  });

  t(label + ": dupePrimary keeps a title changed by the BULK AI-refresh batch (origTitle set, titleSet never set by that path) over a richer untouched copy", () => {
    // runAiRefreshBatch's retitle loop calls applyGeneratedTitle, which stamps
    // origTitle (via captureOrigTitle) but deliberately never sets titleSet --
    // that flow is allowed to keep improving a title on a later run. Losing an
    // AI-bulk-improved title to a duplicate merge is just as bad as losing a
    // hand-typed one, so dupePrimary must treat origTitle-present (title
    // currently differs from its first-ever captured value) as the same
    // strong signal as titleSet, not require an explicit human "accept" click.
    const api = build(src);
    const aiRefreshed = { scope: "imported", card: {
      id: "A", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Exercise Strategies to Reduce Belly Fat Effectively",
      origTitle: "Who knew it was so simple 😲", img: "idb:A",
    } };
    const untouched = { scope: "imported", card: {
      id: "B", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Who knew it was so simple 😲",
      img: "idb:B", desc: "A much longer saved-from-facebook description string", tags: ["a", "b", "c"], sdate: 12345,
    } };
    const primary = api.primary([aiRefreshed, untouched]);
    assert.strictEqual(primary.card.id, "A", "an origTitle-present (AI-bulk-changed) copy must win over a richer never-changed copy");
  });

  t(label + ": dupePrimary falls back to the existing image/desc/tags/date scoring when NEITHER copy is titleSet (unchanged behavior)", () => {
    const api = build(src);
    const richer = { scope: "imported", card: {
      id: "A", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "some title",
      img: "idb:A", desc: "a real description here", tags: ["x"], sdate: 999,
    } };
    const sparser = { scope: "imported", card: {
      id: "B", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "some title",
    } };
    const primary = api.primary([richer, sparser]);
    assert.strictEqual(primary.card.id, "A", "with neither titleSet, the richer-metadata copy must still win (pre-existing behavior)");
  });

  t(label + ": dupePrimary falls back to existing tie-break (older wins) when BOTH copies are titleSet with otherwise-equal scores", () => {
    const api = build(src);
    const older = { scope: "imported", card: {
      id: "A", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Exercise Strategies to Reduce Belly Fat Effectively",
      titleSet: true, ts: 100,
    } };
    const newer = { scope: "imported", card: {
      id: "B", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "A different but also human-settled title",
      titleSet: true, ts: 200,
    } };
    const primary = api.primary([newer, older]);
    assert.strictEqual(primary.card.id, "A", "with both titleSet and otherwise equal scores, the older capture must still win the tie-break");
  });

  t(label + ": dupePrimary's tie-break is deterministic (id-based) when NEITHER copy has any date signal, not dependent on array order (data-safety review F5)", () => {
    // The old fallback (0 for the challenger's missing date, Infinity for the
    // incumbent's) made the challenger always "win" a same-score tie when
    // neither card had a date -- i.e. the survivor was really just whichever
    // array element came last, which differs by device (replaceCards persists
    // in whatever order the client's in-memory array happened to be in). Two
    // independently auto-imported copies of the same post commonly tie on
    // score with no date on either, so this was the COMMON case, not an edge
    // one -- every device pair would churn an extra delete/resurrect round
    // over a "different" survivor before finally converging.
    const api = build(src);
    const x = { scope: "imported", card: { id: "x", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "same title" } };
    const y = { scope: "imported", card: { id: "y", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "same title" } };
    const primaryXY = api.primary([x, y]).card.id;
    const primaryYX = api.primary([y, x]).card.id;
    assert.strictEqual(primaryXY, primaryYX, "the survivor must be the same regardless of which array position each copy started in");
  });

  t(label + ": dupePrimary's tie-break is ALSO deterministic when both copies share the SAME non-zero date (data-safety review N3)", () => {
    // A first fix only reached the id tiebreak when dCur||dBest was falsy --
    // i.e. only when BOTH sides were dateless. Two copies of one post that both
    // carry the source's original sdate (the common shape for one legacy export
    // imported on two devices) tie WITH a real date on both sides -- dCur<dBest
    // is false in both directions -- so this fell straight back to array order
    // too. Must compare by inequality (dCur!==dBest), not truthiness.
    const api = build(src);
    const x = { scope: "imported", card: { id: "x", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "same title", sdate: 5000 } };
    const y = { scope: "imported", card: { id: "y", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "same title", sdate: 5000 } };
    const primaryXY = api.primary([x, y]).card.id;
    const primaryYX = api.primary([y, x]).card.id;
    assert.strictEqual(primaryXY, primaryYX, "the survivor must be the same regardless of array order even when both copies share one non-zero date");
  });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
