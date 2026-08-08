// tests/auto-dedup-link.test.js — autoMergeLinkDuplicates() (web/pwa index.html):
// unattended duplicate cleanup that runs after a sync pulls in another
// device's data. Per-device auto-import can't see what another device
// captured before they'd synced with each other, so the SAME post
// legitimately lands as two cards with different ids -- this function
// resolves that automatically, but ONLY for exact/canonical-URL matches
// (scanDuplicates' "link" reason) that also identify a specific post (see
// isSpecificPostUrl, web/lib/urlkey.js). Fuzzy title-only matches (two
// DIFFERENT posts that happen to share a title) must NEVER be auto-deleted --
// that stays manual-review-only in the Duplicates tab. Reported live: "I
// don't ever want any dupes on any device."
//
// This file also covers the fixes from the pre-merge data-safety review:
// F1 (over-broad dupeKey fallback could merge unrelated posts), F2a/F2d
// (failure must be surfaced, not silent; must never arm the shared safety
// cache), F3 (shared _dupeMutationRunning guard vs. the manual flows),
// F4 (stale frozen _dupeGroups pruned after an auto-merge), F6 (a transient
// in-memory id collision with the keeper must never zero out the group).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { build } = require("./_dupe-harness");

const web = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwa = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
async function t(n, f) { try { await f(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.message)); } }

(async () => {
  for (const [label, src] of [["web", web], ["pwa", pwa]]) {
    await t(label + ": merges an exact-URL duplicate pair, keeping the titleSet copy, without any manual checkbox state", () => {
      const api = build(src);
      api.set({ imported: [
        { id: "A", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Who knew it was so simple 😲" },
        { id: "B", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Exercise Strategies to Reduce Belly Fat Effectively", titleSet: true },
      ], saved: [] });
      return api.autoMerge().then(() => {
        const { imported } = api.get();
        assert.strictEqual(imported.length, 1, "the duplicate must be removed automatically");
        assert.strictEqual(imported[0].id, "B", "the titleSet (edited) copy must survive");
        assert.strictEqual(api.log.putCards.length, 1, "must persist via Store.putCards");
      });
    });

    await t(label + ": does NOT touch a pair matched only by TITLE (different URLs) -- title-only matches stay manual-review-only", () => {
      const api = build(src);
      api.set({ imported: [
        { id: "A", url: "https://blog.com/post-one", title: "Sourdough starter guide" },
        { id: "B", url: "https://blog.com/post-two", title: "Sourdough starter guide" },
      ], saved: [] });
      return api.autoMerge().then(() => {
        const { imported } = api.get();
        assert.strictEqual(imported.length, 2, "a title-only match must never be auto-removed");
        assert.strictEqual(api.log.putCards.length, 0, "must not write anything for a title-only match");
      });
    });

    await t(label + ": no-op (no Store call at all) when there are no link-matched groups", () => {
      const api = build(src);
      api.set({ imported: [
        { id: "A", url: "https://blog.com/one", title: "One" },
        { id: "B", url: "https://blog.com/two", title: "Two" },
      ], saved: [] });
      return api.autoMerge().then(() => {
        assert.strictEqual(api.log.putCards.length, 0);
        assert.strictEqual(api.log.confirms.length, 0, "must never prompt -- this runs unattended");
      });
    });

    await t(label + ": does NOT merge distinct posts whose captured URL fell back to a bare profile page (F1, CRITICAL)", () => {
      // dupeKey falls back to bare host+path when no post-identifying query id
      // or path segment is found. A capture whose permalink never resolved is
      // stamped with the page URL itself (extension/capture-core.js) -- three
      // genuinely different posts clipped from the same profile grid would
      // otherwise share one dupeKey and get silently collapsed into one card.
      const api = build(src);
      api.set({ imported: [
        { id: "A", url: "https://www.instagram.com/natgeo/", title: "Snow leopard in Ladakh", img: "idb:A" },
        { id: "B", url: "https://www.instagram.com/natgeo/", title: "Coral bleaching on the reef", img: "idb:B" },
        { id: "C", url: "https://www.instagram.com/natgeo/", title: "Aurora over Iceland", img: "idb:C" },
      ], saved: [] });
      return api.autoMerge().then(() => {
        const { imported } = api.get();
        assert.strictEqual(imported.length, 3, "three distinct posts sharing a mis-stamped profile URL must never be collapsed into one");
        assert.strictEqual(api.log.putCards.length, 0);
      });
    });

    await t(label + ": copies the removed member's image onto the keeper when the keeper has none, and deletes the source image", () => {
      const api = build(src, { images: ["A"] });
      api.set({ imported: [
        { id: "keep", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Exercise Strategies to Reduce Belly Fat Effectively", titleSet: true },
        { id: "A", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Who knew it was so simple 😲", img: "idb:A" },
      ], saved: [] });
      return api.autoMerge().then(() => {
        const { imported } = api.get();
        assert.strictEqual(imported.length, 1);
        assert.strictEqual(imported[0].id, "keep");
        assert.strictEqual(imported[0].img, "idb:keep", "the keeper must adopt the removed member's image reference");
        assert.ok(api.log.imgCopy.some(s => s === "A->keep"), "the underlying image bytes must be copied to the keeper's id");
        assert.ok(api.log.imgDel.includes("A"), "the now-orphaned source image must be deleted, not left behind");
      });
    });

    await t(label + ": skips silently (no write) when a verified safety snapshot cannot be created", () => {
      const api = build(src, { createSnapshot: async () => null });
      api.set({ imported: [
        { id: "A", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Who knew it was so simple 😲" },
        { id: "B", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Exercise Strategies to Reduce Belly Fat Effectively", titleSet: true },
      ], saved: [] });
      return api.autoMerge().then(() => {
        const { imported } = api.get();
        assert.strictEqual(imported.length, 2, "nothing must be removed without a verified safety snapshot");
        assert.strictEqual(api.log.putCards.length, 0);
      });
    });

    await t(label + ": on a fresh snapshot, does NOT arm the shared _dupeSafetyCache a user-initiated flow relies on (F2d)", () => {
      // Before this fix, an UNATTENDED run could arm _dupeSafetyCache, which
      // applyDupeRemoval/applyDupeRemoveGroup then treat as "a human recently
      // verified this snapshot" and reuse for up to 5 minutes without taking a
      // fresh one -- a boot-time auto-merge (no human present) must never be
      // able to create that illusion for a later manual action.
      let snapshotCalls = 0;
      const api = build(src, { createSnapshot: async () => { snapshotCalls++; return { kind: "desktop", name: "safety-" + snapshotCalls }; } });
      api.set({ imported: [
        { id: "A", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Who knew it was so simple 😲" },
        { id: "B", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Exercise Strategies to Reduce Belly Fat Effectively", titleSet: true },
      ], saved: [] });
      return api.autoMerge().then(() => {
        assert.strictEqual(api.get()._dupeSafetyCache, null, "auto-merge must never write _dupeSafetyCache itself, even after successfully creating and using its own snapshot");
        assert.strictEqual(snapshotCalls, 1);
      });
    });

    await t(label + ": rollback is actually invoked (not just claimed) and the failure is surfaced to the user, on a failed persist", () => {
      let rollbackCalled = 0;
      const api = build(src, { failPutCards: true, rollback: async () => { rollbackCalled++; return true; } });
      api.set({ imported: [
        { id: "A", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Who knew it was so simple 😲" },
        { id: "B", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Exercise Strategies to Reduce Belly Fat Effectively", titleSet: true },
      ], saved: [] });
      return api.autoMerge().then(() => {
        const { imported } = api.get();
        assert.strictEqual(imported.length, 2, "in-memory state must be untouched by a failed persist -- the caller never sees a half-applied merge");
        assert.strictEqual(rollbackCalled, 1, "rollbackDupePersistence must actually be called, not just assumed");
        assert.ok(api.log.toasts.some(m => /restored/i.test(m)), "a successful rollback must be reported to the user (the old code only console.warn'd)");
      });
    });

    await t(label + ": a cross-scope group (keeper in saved, duplicate in imported) surfaces failure and rolls back if the SECOND write fails", () => {
      // The two scopes persist via separate Store calls. If putCards (imported)
      // succeeds and putSaved (saved, carrying the merged keeper) then fails,
      // the failure must still be surfaced and rollback invoked -- not left as
      // a silent partial write.
      let rollbackCalled = 0;
      const api = build(src, { failPutSaved: true, rollback: async () => { rollbackCalled++; return true; } });
      api.set({
        imported: [{ id: "dupe", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Who knew it was so simple 😲" }],
        saved: [{ id: "keep", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "my clipped copy", titleSet: true }],
      });
      return api.autoMerge().then(() => {
        const { imported, saved } = api.get();
        assert.strictEqual(imported.length, 1, "in-memory imported must be untouched by a failed cross-scope persist");
        assert.strictEqual(saved.length, 1, "in-memory saved must be untouched too");
        assert.strictEqual(rollbackCalled, 1, "a putSaved failure after putCards succeeded must still trigger rollback");
        assert.ok(api.log.toasts.some(m => /restored|failed/i.test(m)), "the failure must be surfaced, not silent");
      });
    });

    await t(label + ": a transient in-memory row sharing the keeper's own id+scope is never condemned alongside it (F6)", () => {
      const keepCard = { id: "K", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Exercise Strategies to Reduce Belly Fat Effectively", titleSet: true };
      const dupeOfKeep = { id: "K", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Exercise Strategies to Reduce Belly Fat Effectively", titleSet: true };
      const other = { id: "O", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Who knew it was so simple 😲" };
      const api = build(src);
      api.set({ imported: [keepCard, dupeOfKeep, other] });
      return api.autoMerge().then(() => {
        const { imported } = api.get();
        assert.ok(imported.some(c => c.id === "K"), "the keeper's id must survive -- must never be zeroed out by a same-id in-memory collision");
      });
    });

    await t(label + ": prunes a removed card out of a FROZEN _dupeGroups from the user's last manual scan, instead of leaving a stale reference (F4)", () => {
      const cardA = { id: "A", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Who knew it was so simple 😲" };
      const cardB = { id: "B", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Exercise Strategies to Reduce Belly Fat Effectively", titleSet: true };
      const api = build(src);
      api.set({
        imported: [cardA, cardB],
        groups: [{ members: [{ scope: "imported", card: cardA }, { scope: "imported", card: cardB }], keepKey: "imported:B", reason: "link" }],
      });
      return api.autoMerge().then(() => {
        const { _dupeGroups } = api.get();
        assert.strictEqual(_dupeGroups.length, 0, "a group that no longer has 2 live members must be dropped, not left pointing at a merged-away card");
      });
    });

    await t(label + ": relocates _dupeReviewIndex to the SAME on-screen group after an earlier frozen group is pruned away (N1 -- a numeric index alone silently pointed at a different group)", () => {
      // The user is one-at-a-time reviewing group[1] (C,D) on screen. Auto-merge
      // resolves an UNRELATED pair (X,Y) elsewhere in the library, which happens
      // to be group[0] in the frozen list -- pruning it away shifts every later
      // group's array position down by one. Without tracking the reviewed group
      // by reference, _dupeReviewIndex staying at 1 would silently now point at
      // group[2] (E,F) instead of the group the user is actually looking at.
      const cardX = { id: "X", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Who knew it was so simple 😲" };
      const cardY = { id: "Y", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Exercise Strategies to Reduce Belly Fat Effectively", titleSet: true };
      const cardC = { id: "C", url: "https://blog.com/unrelated-one" };
      const cardD = { id: "D", url: "https://blog.com/unrelated-one-again" };
      const cardE = { id: "E", url: "https://blog.com/unrelated-two" };
      const cardF = { id: "F", url: "https://blog.com/unrelated-two-again" };
      const groupCD = { members: [{ scope: "imported", card: cardC }, { scope: "imported", card: cardD }], keepKey: "imported:D", reason: "title" };
      const api = build(src);
      api.set({
        imported: [cardX, cardY, cardC, cardD, cardE, cardF],
        groups: [
          { members: [{ scope: "imported", card: cardX }, { scope: "imported", card: cardY }], keepKey: "imported:Y", reason: "link" },
          groupCD,
          { members: [{ scope: "imported", card: cardE }, { scope: "imported", card: cardF }], keepKey: "imported:F", reason: "title" },
        ],
        index: 1,   // reviewing group[1] (C,D) on screen
      });
      return api.autoMerge().then(() => {
        const { _dupeGroups, _dupeReviewIndex } = api.get();
        assert.strictEqual(_dupeGroups.length, 2, "only the X/Y group (auto-merged) should have been dropped from the frozen list");
        assert.strictEqual(_dupeGroups[_dupeReviewIndex], groupCD, "_dupeReviewIndex must still point at the C/D group the user was reviewing, not whatever now occupies the old numeric position");
      });
    });

    await t(label + ": a manual apply is blocked while an automatic merge is mid-flight (shared _dupeMutationRunning guard, F3)", async () => {
      let resolveSnapshot;
      const snapshotPromise = new Promise((res) => { resolveSnapshot = res; });
      const api = build(src, { createSnapshot: () => snapshotPromise });
      api.set({ imported: [
        { id: "A", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Who knew it was so simple 😲" },
        { id: "B", url: "https://facebook.com/LADbible/posts/1234567890123456", title: "Exercise Strategies to Reduce Belly Fat Effectively", titleSet: true },
      ], saved: [] });
      const autoMergeDone = api.autoMerge();   // synchronously runs up to the createSnapshot await, setting the shared guard
      await api.run();   // applyDupeRemoval must see the guard and bail before touching anything
      assert.ok(api.log.toasts.some(m => /already running/i.test(m)), "the manual apply must be told a cleanup is already running");
      assert.strictEqual(api.log.putCards.length, 0, "the manual apply must not have started any write while auto-merge is mid-flight");
      resolveSnapshot({ kind: "desktop", name: "safety-backup" });
      await autoMergeDone;
      assert.strictEqual(api.log.putCards.length, 1, "auto-merge itself must complete normally once unblocked");
    });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})();
