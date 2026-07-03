// Tests for web/lib/import-parsers.js — SYNTHETIC fixtures only (no real
// personal data). Covers the parsers, normTs, the CSV doubled-quote fix, and
// the pure dedupe core.
const assert = require("assert");
const IP = require("../web/lib/import-parsers.js");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.stack||e)); } }

// A pure entity decoder + identity fixTxt so parsePinterestSAR/clean are DOM-free here.
IP.configure({
  fixTxt: s => s,
  decode: s => String(s).replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'")
});

/* ---------- normTs ---------- */
t("normTs: unix seconds -> ms", () => {
  assert.strictEqual(IP.normTs(1600000000), 1600000000000);
});
t("normTs: unix ms passthrough", () => {
  assert.strictEqual(IP.normTs(1600000000000), 1600000000000);
});
t("normTs: date string", () => {
  assert.strictEqual(IP.normTs("2021-01-01T00:00:00Z"), Date.parse("2021-01-01T00:00:00Z"));
});
t("normTs: null/empty/garbage -> null", () => {
  assert.strictEqual(IP.normTs(null), null);
  assert.strictEqual(IP.normTs(""), null);
  assert.strictEqual(IP.normTs("not a date"), null);
});
t("normTs: out-of-range (pre-2000 / post-2100) -> null", () => {
  assert.strictEqual(IP.normTs(1), null);            // 1000ms — below the ~2000 floor
  assert.strictEqual(IP.normTs(5e12), null);         // above the ~2100 ceiling
});

/* ---------- CSV doubled-quote fix ---------- */
t("splitCsvLine: doubled quotes ('') become one literal quote (the fix)", () => {
  const cols = IP.splitCsvLine('"He said ""hi"" today",https://x.com');
  assert.strictEqual(cols[0], 'He said "hi" today', "quote preserved, not dropped");
  assert.strictEqual(cols[1], "https://x.com");
});
t("parseCSV: a YouTube-style CSV with a quoted title keeps the quotes", () => {
  // header without channel/video-id cols -> generic branch: find a title col + url col
  const csv = 'Title,URL\n"Watch ""this"" clip",https://youtube.com/watch?v=abc123';
  const r = IP.parseCSV(csv);
  const found = r.items.find(x => x.title && x.title.indexOf('"this"') >= 0);
  assert.ok(found, "quoted CSV title imported with quotes intact");
});

/* ---------- parseFacebookJSON: saves_v2 shape ---------- */
t("parseFacebookJSON: saves_v2 external_context -> item with title/url/ts", () => {
  const p = { saves_v2: [{
    timestamp: 1600000000,
    attachments: [{ data: [{ external_context: { name: "A cool article", source: "https://example.com/a" } }] }],
    data: [{ post: "Some post body text that is long enough to survive." }]
  }] };
  const out = IP.parseFacebookJSON(p);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].title, "A cool article");
  assert.strictEqual(out[0].url, "https://example.com/a");
  assert.strictEqual(out[0].ts, 1600000000000);
});

/* ---------- parseFacebookJSON: label_values / dict shape ---------- */
t("parseFacebookJSON: label_values Saves dict -> item", () => {
  const p = [{
    label_values: [
      { label: "Title", value: "My Collection" },
      { title: "Saves", dict: [
        { timestamp: 1600000000, dict: [
          { label: "URL", value: "https://example.com/post1" },
          { label: "Name", value: "Post one name" }
        ] }
      ] }
    ]
  }];
  const out = IP.parseFacebookJSON(p);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].url, "https://example.com/post1");
  assert.strictEqual(out[0].title, "Post one name");
});

/* ---------- parsePinterestSAR ---------- */
t("parsePinterestSAR: extracts a pin with title + canonical url + image", () => {
  const img = "0123456789abcdef0123456789abcdef"; // 32 hex
  const text =
    '<a href="https://www.pinterest.com/pin/12345/">' +
    'Alive: Yes<br>Title: A &quot;great&quot; recipe<br>Details: Full details here<br>' +
    'Image: ' + img + '<br>Canonical Link: <a href="https://recipes.example.com/x">link</a><br>';
  const out = IP.parsePinterestSAR(text);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].title, 'A "great" recipe', "entity decode applied via injected decode");
  assert.strictEqual(out[0].url, "https://recipes.example.com/x", "canonical preferred over pin url");
  assert.ok(out[0].img && out[0].img.indexOf(img) >= 0, "image url built from hash");
  assert.strictEqual(out[0].src, "pinterest");
});
t("parsePinterestSAR: Alive:No is skipped", () => {
  const text = '<a href="https://www.pinterest.com/pin/999/">Alive: No<br>Title: dead pin<br>';
  assert.strictEqual(IP.parsePinterestSAR(text).length, 0);
});

/* ---------- harvest ---------- */
t("harvest: pulls a title/url/img from nested JSON", () => {
  const out = [];
  IP.harvest({ items: [{ title: "A nested titled thing", url: "https://n.example.com", image: "https://img.example.com/1.jpg" }] }, out);
  const hit = out.find(x => x.title === "A nested titled thing");
  assert.ok(hit, "found the titled node");
  assert.strictEqual(hit.url, "https://n.example.com");
});

/* ---------- clean ---------- */
t("clean: slices title, sets ts=now, sdate from export ts", () => {
  const o = IP.clean({ title: "Watched Some Video", url: "https://v.example.com", ts: 1600000000 });
  assert.strictEqual(o.title, "Some Video", "strips leading 'Watched '");
  assert.strictEqual(o.sdate, 1600000000000, "export ts -> sdate");
  assert.ok(typeof o.ts === "number", "ts=now stamped");
});

/* ---------- dedupeImported (pure core) ---------- */
t("dedupeImported: brand-new item by url is appended with an id", () => {
  const plan = IP.dedupeImported(
    [{ title: "New post", url: "https://a.example.com" }],
    [],
    { newId: () => "ID1" }
  );
  assert.strictEqual(plan.added, 1);
  assert.strictEqual(plan.updated, 0);
  assert.strictEqual(plan.append.length, 1);
  assert.strictEqual(plan.append[0].id, "ID1");
});
t("dedupeImported: duplicate by url -> enrich, not append", () => {
  const existing = [{ title: "Old title", url: "https://a.example.com", id: "X" }];
  const plan = IP.dedupeImported(
    [{ title: "Old title", url: "https://a.example.com", img: "https://img/1.jpg", desc: "new desc" }],
    existing,
    { newId: () => "ID2" }
  );
  assert.strictEqual(plan.added, 0);
  assert.strictEqual(plan.updated, 1);
  assert.strictEqual(plan.enrich.length, 1);
  assert.strictEqual(plan.enrich[0].idx, 0);
  assert.strictEqual(plan.enrich[0].patch.img, "https://img/1.jpg");
  assert.strictEqual(plan.enrich[0].patch.desc, "new desc");
});
t("dedupeImported: duplicate by title (no url) -> enrich existing", () => {
  const existing = [{ title: "Same Title", id: "T" }];
  const plan = IP.dedupeImported(
    [{ title: "same title", desc: "added desc" }],
    existing,
    { newId: () => "ID3" }
  );
  assert.strictEqual(plan.added, 0);
  assert.strictEqual(plan.enrich.length, 1);
  assert.strictEqual(plan.enrich[0].patch.desc, "added desc");
});
t("dedupeImported: two distinct posts sharing a title both survive (url identity)", () => {
  const plan = IP.dedupeImported(
    [{ title: "Same caption", url: "https://a/1" }, { title: "Same caption", url: "https://a/2" }],
    [],
    { newId: () => "z" + Math.random() }
  );
  assert.strictEqual(plan.added, 2, "distinct urls => both new");
});
t("dedupeImported: in-batch dup by url collapses", () => {
  const plan = IP.dedupeImported(
    [{ title: "One", url: "https://a/1" }, { title: "One again", url: "https://a/1" }],
    [],
    { newId: () => "z" + Math.random() }
  );
  assert.strictEqual(plan.added, 1, "same url twice in one batch => one append");
});
t("dedupeImported: junk titles and raw-url titles are skipped", () => {
  const plan = IP.dedupeImported(
    [{ title: "like" }, { title: "https://raw.example.com" }, { title: "Real title", url: "https://r/1" }],
    [],
    { newId: () => "z" }
  );
  assert.strictEqual(plan.added, 1, "only the real titled item appends");
});

console.log("import-parsers.test.js: " + passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
