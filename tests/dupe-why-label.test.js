// tests/dupe-why-label.test.js — the "why matched" diagnostic on duplicate groups.
// scanDuplicates tags each group with reason "link"/"title"; scanImageDuplicates
// tags image groups reason "image" + imageDistance; dupeWhyHTML renders the label.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");
const { build } = require("./_dupe-harness");

const web = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwa = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, f) { try { f(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.message)); } }

for (const [label, src] of [["web", web], ["pwa", pwa]]) {
  t(label + ": scanDuplicates tags a link-matched group with reason 'link'", () => {
    const api = build(src);
    api.set({ imported: [{ id: "L1", url: "https://blog.com/a/1", title: "x" }, { id: "L2", url: "https://blog.com/a/1", title: "y" }], saved: [] });
    const g = api.scan();
    assert.strictEqual(g.length, 1);
    assert.strictEqual(g[0].reason, "link", "a shared-URL group must be tagged reason:link");
  });

  t(label + ": scanDuplicates tags a title-matched group with reason 'title'", () => {
    const api = build(src);
    api.set({ imported: [{ id: "T1", url: "https://a.com/1", title: "Ten Great Camping Spots" }, { id: "T2", url: "https://b.com/2", title: "Ten Great Camping Spots" }], saved: [] });
    const g = api.scan();
    assert.strictEqual(g.length, 1);
    assert.strictEqual(g[0].reason, "title", "a shared-title group must be tagged reason:title");
  });

  t(label + ": dupeWhyHTML renders the right label for each reason", () => {
    const dupeWhyHTML = eval("(" + extractFn(src, "dupeWhyHTML") + ")");
    assert.match(dupeWhyHTML({ reason: "link" }), /matched: same link/);
    assert.match(dupeWhyHTML({ reason: "title" }), /matched: same title/);
    const img = dupeWhyHTML({ imageMatch: true, imageDistance: 4 });
    assert.match(img, /Same picture/);
    assert.match(img, /distance 4/, "an image group's label must show the hamming distance");
    assert.strictEqual(dupeWhyHTML({}), "", "a reasonless group renders no label");
  });
}

// --- the FB fallback title "<page> post by <author>" must not group ---------
for (const [label, src] of [["web", web], ["pwa", pwa]]) {
  t(label + ": two DIFFERENT posts sharing the '<page> post by <author>' fallback title do NOT group", () => {
    // The reported false positive: caption-less FB-export posts get an invented
    // "<page> post by <author>" title that many distinct posts share verbatim.
    // Different URLs (so the link pass doesn't group them) + same fallback title.
    const api = build(src);
    api.set({ imported: [
      { id: "P1", url: "https://facebook.com/p/aaa", title: "Old Made New post by Luis Chambers" },
      { id: "P2", url: "https://facebook.com/p/bbb", title: "Old Made New post by Luis Chambers" },
    ], saved: [] });
    assert.strictEqual(api.scan().length, 0, "a shared 'post by' fallback title must not form a duplicate group");
  });

  t(label + ": a real shared title still groups (the fix is scoped to the 'post by' fallback)", () => {
    const api = build(src);
    api.set({ imported: [
      { id: "R1", url: "https://a.com/1", title: "Braided Pesto Bread Recipe" },
      { id: "R2", url: "https://b.com/2", title: "Braided Pesto Bread Recipe" },
    ], saved: [] });
    assert.strictEqual(api.scan().length, 1, "a genuine shared content title must still group");
  });
}

t("dupeWhyHTML + the scan/render functions it feeds are byte-identical between web and pwa", () => {
  for (const n of ["dupeWhyHTML", "scanDuplicates", "scanImageDuplicates", "dupeCompactGroupHTML"]) {
    assert.strictEqual(extractFn(web, n), extractFn(pwa, n), n + " has drifted between web/ and pwa/");
  }
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
