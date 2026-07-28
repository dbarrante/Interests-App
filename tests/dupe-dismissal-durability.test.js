// tests/dupe-dismissal-durability.test.js — a "not duplicate" decision must survive
// the two things that used to silently undo it: a later title edit on either card,
// and a group's membership changing (e.g. a third duplicate later removed for an
// unrelated reason). The old dismissal key was the JSON of every group member's
// [scope,id,url,title] — mutable content baked into an identity key — so either
// change produced a NEW key that had never been dismissed, and the pair (or group)
// silently reappeared as a "new" duplicate. The fix keys dismissal PAIRWISE by
// stable (scope,id) identity only: every member records "not-a-duplicate-of" every
// other member it was dismissed alongside, so the relationship is unaffected by
// content edits or by an unrelated member later disappearing.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");
const { build } = require("./_dupe-harness");

const web = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwa = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, f) { try { f(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.message)); } }

function idsById(arr) { return new Map(arr.filter(Boolean).map(c => [c.id, c])); }

for (const [label, src] of [["web", web], ["pwa", pwa]]) {
  t(label + ": a dismissed pair stays dismissed after one member's title is edited later", () => {
    const api = build(src);
    api.set({ imported: [
      { id: "A", url: "https://blog.com/sourdough", title: "Sourdough starter guide" },
      { id: "B", url: "https://blog.com/sourdough?ref=pin", title: "Sourdough starter guide (repost)" },
    ], saved: [] });
    let groups = api.scan();
    assert.strictEqual(groups.length, 1, "the two cards must group before any dismissal");
    const { imported } = api.get();
    api.markNotDup(groups[0].members, idsById(imported), idsById([]));

    // Simulate later AI-title/enrichment editing one member's title in place.
    imported.find(c => c.id === "A").title = "Homemade sourdough starter, day-by-day guide";

    groups = api.scan();
    assert.strictEqual(groups.length, 0, "a title edit on either card must not un-dismiss the pair");
  });

  t(label + ": an upgrade does not resurface a pair dismissed under the OLD whole-group key (data-safety review F-1)", () => {
    // Before this file switched to pairwise tags, a decision was stored as one
    // shared key: JSON of every member's [scope,id,url,title]. If dismissed()
    // stopped recognizing that format entirely, every EXISTING user's past
    // decisions would resurface the moment they upgrade -- and since a
    // non-image group's non-keep member defaults to CHECKED, one "Apply
    // choices" click would delete a card the user had already explicitly
    // spared. The legacy key must still count as dismissed as long as nothing
    // about the group has changed since (exactly its pre-fix behavior).
    const api = build(src);
    const members = [
      { scope: "imported", card: { id: "A", url: "https://blog.com/sourdough", title: "Sourdough starter guide" } },
      { scope: "imported", card: { id: "B", url: "https://blog.com/sourdough?ref=pin", title: "Sourdough starter guide (repost)" } },
    ];
    const legacyKey = api.groupKey(members);
    api.set({ imported: [
      { id: "A", url: "https://blog.com/sourdough", title: "Sourdough starter guide", dupeNotDuplicateGroups: [legacyKey] },
      { id: "B", url: "https://blog.com/sourdough?ref=pin", title: "Sourdough starter guide (repost)", dupeNotDuplicateGroups: [legacyKey] },
    ], saved: [] });
    assert.strictEqual(api.scan().length, 0, "an old-format decision must still suppress the group when nothing about it has changed");
  });

  t(label + ": a dismissed relationship survives a group losing an unrelated member", () => {
    const api = build(src);
    api.set({ imported: [
      { id: "X", url: "https://a.com/1", title: "Same Title Here" },
      { id: "Y", url: "https://b.com/2", title: "Same Title Here" },
      { id: "Z", url: "https://c.com/3", title: "Same Title Here" },
    ], saved: [] });
    let groups = api.scan();
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].members.length, 3, "all three must group on the shared title");
    const { imported } = api.get();
    api.markNotDup(groups[0].members, idsById(imported), idsById([]));

    // Z is removed from the library for an unrelated reason (e.g. the user deleted
    // it outright). X and Y's own dismissal must not depend on Z still being present.
    api.set({ imported: imported.filter(c => c.id !== "Z"), saved: [] });

    groups = api.scan();
    assert.strictEqual(groups.length, 0, "X and Y's dismissal must survive Z's removal from the group");
  });
}

t("dupeGroupDismissed/markDupeGroupNotDuplicate are byte-identical between web and pwa", () => {
  for (const n of ["dupeGroupDismissed", "markDupeGroupNotDuplicate", "dupePeerTagsFor"]) {
    assert.strictEqual(extractFn(web, n), extractFn(pwa, n), n + " has drifted between web/ and pwa/");
  }
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
