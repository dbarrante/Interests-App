const assert = require("assert");
const t2 = require("../web/title-ai.js");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("buildTitlePrompt includes url, domain, description, and asks for <=8 words", () => {
  const p = t2.buildTitlePrompt({ url:"https://x.com/p/1", domain:"x.com", description:"A guide to backyard pizza ovens." });
  assert.ok(p.indexOf("https://x.com/p/1") >= 0);
  assert.ok(p.indexOf("x.com") >= 0);
  assert.ok(p.indexOf("A guide to backyard pizza ovens.") >= 0);
  assert.ok(/8 words/i.test(p));
});
t("buildTitlePrompt with no avoidTitles doesn't mention avoiding anything", () => {
  const p = t2.buildTitlePrompt({ url:"https://x.com/p/1", domain:"x.com", description:"desc" });
  assert.ok(!/do not reuse/i.test(p));
});
t("buildTitlePrompt with avoidTitles lists each one to avoid", () => {
  const p = t2.buildTitlePrompt({ url:"https://x.com/p/1", domain:"x.com", description:"desc", avoidTitles:["Backyard Pizza Oven Guide", "DIY Pizza Oven Build"] });
  assert.ok(/do not reuse/i.test(p));
  assert.ok(p.indexOf("Backyard Pizza Oven Guide") >= 0);
  assert.ok(p.indexOf("DIY Pizza Oven Build") >= 0);
});
t("parseTitleReply strips surrounding quotes and whitespace", () => {
  assert.strictEqual(t2.parseTitleReply('  "Backyard Pizza Oven Guide"  '), "Backyard Pizza Oven Guide");
});
t("parseTitleReply strips a leading 'Title:' label", () => {
  assert.strictEqual(t2.parseTitleReply("Title: Backyard Pizza Oven Guide"), "Backyard Pizza Oven Guide");
});
t("parseTitleReply takes only the first line", () => {
  assert.strictEqual(t2.parseTitleReply("Backyard Pizza Oven Guide\nHere's why: ..."), "Backyard Pizza Oven Guide");
});
t("parseTitleReply truncates to 8 words as a backstop", () => {
  assert.strictEqual(
    t2.parseTitleReply("This Is A Very Long Title With Way More Than Eight Words In It"),
    "This Is A Very Long Title With Way"
  );
});
t("parseTitleReply on empty/garbage -> null", () => {
  assert.strictEqual(t2.parseTitleReply(""), null);
  assert.strictEqual(t2.parseTitleReply("   "), null);
  assert.strictEqual(t2.parseTitleReply(null), null);
});

// ---- extractWeakContext ----
t("extractWeakContext: extracts the collection name from the exact boilerplate string", () => {
  const r = t2.extractWeakContext({ desc: "From your 'VR Stuff' Facebook collection", url: "https://facebook.com/x/posts/1" });
  assert.strictEqual(r.collection, "VR Stuff");
});
t("extractWeakContext: no match -> empty collection", () => {
  const r = t2.extractWeakContext({ desc: "Saved from Facebook", url: "https://facebook.com/x/posts/1" });
  assert.strictEqual(r.collection, "");
});
t("extractWeakContext: missing desc -> empty collection, no throw", () => {
  const r = t2.extractWeakContext({ url: "https://facebook.com/x/posts/1" });
  assert.strictEqual(r.collection, "");
});
t("extractWeakContext: extracts the page slug from a facebook.com URL", () => {
  const r = t2.extractWeakContext({ desc: "", url: "https://www.facebook.com/uploadvr/posts/pfbid0abc" });
  assert.strictEqual(r.pageSlug, "uploadvr");
});
t("extractWeakContext: reel/permalink.php/etc are not page slugs", () => {
  assert.strictEqual(t2.extractWeakContext({ url: "https://www.facebook.com/reel/12345/" }).pageSlug, "");
  assert.strictEqual(t2.extractWeakContext({ url: "https://www.facebook.com/permalink.php?story_fbid=1&id=2" }).pageSlug, "");
  assert.strictEqual(t2.extractWeakContext({ url: "https://www.facebook.com/watch/?v=1" }).pageSlug, "");
});
t("extractWeakContext: non-Facebook URL -> empty pageSlug", () => {
  assert.strictEqual(t2.extractWeakContext({ url: "https://example.com/whatever" }).pageSlug, "");
});
t("extractWeakContext: missing/invalid url -> no throw, empty pageSlug", () => {
  assert.strictEqual(t2.extractWeakContext({}).pageSlug, "");
  assert.strictEqual(t2.extractWeakContext({ url: "not a url" }).pageSlug, "");
});

// ---- composeFallbackTitle ----
t("composeFallbackTitle: composes a factual, non-fabricated label", () => {
  assert.strictEqual(t2.composeFallbackTitle("VR Stuff"), "VR Stuff — saved from a Facebook collection");
});
t("composeFallbackTitle: even a 1-character collection name produces a >=25-char result", () => {
  const out = t2.composeFallbackTitle("X");
  assert.ok(out.length >= 25, "must clear isGenericTitle's length floor: " + out.length);
});

// ---- buildTitlePrompt: new flags (hasImage, ocr, collection) ----
t("buildTitlePrompt: unchanged output when no new flags are passed (regression guard)", () => {
  const before = t2.buildTitlePrompt({ url:"https://x.com/a", domain:"x.com", description:"d" });
  const golden = "Write ONE short, descriptive, specific title for this saved web page, 8 words or fewer.\nNo platform names (Facebook/Instagram/Pinterest/etc), no generic filler like \"Post\" or \"Video\" — describe the actual subject.\n\nURL: https://x.com/a\nDomain: x.com\nDescription: d\n\nReturn ONLY the title, no quotes, no explanation.";
  assert.strictEqual(before, golden, "Output must be byte-for-byte identical to pre-change baseline");
  assert.ok(!/attached/i.test(before));
  assert.ok(!/OCR/i.test(before));
  assert.ok(!/collection/i.test(before));
});
t("buildTitlePrompt: hasImage adds an image-grounding instruction", () => {
  const p = t2.buildTitlePrompt({ url:"u", domain:"d", description:"", hasImage:true });
  assert.match(p, /image of the actual saved content is attached/i);
});
t("buildTitlePrompt: ocr adds an approximate-text caveat", () => {
  const p = t2.buildTitlePrompt({ url:"u", domain:"d", description:"extracted text", ocr:true });
  assert.match(p, /OCR/i);
  assert.match(p, /approximate/i);
});
t("buildTitlePrompt: collection is included as supplementary context, not a standalone claim", () => {
  const p = t2.buildTitlePrompt({ url:"u", domain:"d", description:"d", collection:"VR Stuff" });
  assert.match(p, /VR Stuff/);
  assert.match(p, /context only/i);
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
