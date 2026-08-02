const assert = require("assert");
const { buildPageBody, splitIntoRichText } = require("../core/notion");
let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

t("splitIntoRichText returns one segment for short text", () => {
  const segs = splitIntoRichText("hello world");
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(segs[0].text.content, "hello world");
});
t("splitIntoRichText hard-splits text over 2000 chars into multiple segments, none over 2000", () => {
  const long = "a".repeat(4500);
  const segs = splitIntoRichText(long);
  assert.ok(segs.length >= 3, "expected at least 3 segments, got " + segs.length);
  segs.forEach(s => assert.ok(s.text.content.length <= 2000, "segment exceeds 2000 chars"));
  assert.strictEqual(segs.map(s => s.text.content).join(""), long, "segments must reassemble to the original text losslessly");
});

t("buildPageBody sets the parent and title correctly", () => {
  const body = buildPageBody("parent-123", { title: "My Card", url: "https://example.com", article: null, qa: [] });
  assert.deepStrictEqual(body.parent, { page_id: "parent-123" });
  assert.strictEqual(body.properties.title.title[0].text.content, "My Card");
});
t("buildPageBody includes a link to the source url near the top", () => {
  const body = buildPageBody("p", { title: "T", url: "https://example.com/page", article: null, qa: [] });
  const first = body.children[0];
  assert.strictEqual(first.type, "paragraph");
  assert.ok(JSON.stringify(first).includes("https://example.com/page"));
});
t("buildPageBody omits the source-link block when url is empty", () => {
  const body = buildPageBody("p", { title: "T", url: "", article: null, qa: [] });
  assert.ok(!body.children.some(b => b.type === "paragraph" && JSON.stringify(b).includes("http")));
});
t("buildPageBody renders the article as one paragraph block per paragraph", () => {
  const body = buildPageBody("p", { title: "T", url: "", article: { text: "Para one.\n\nPara two.\n\nPara three.", sources: [] }, qa: [] });
  const paragraphBlocks = body.children.filter(b => b.type === "paragraph");
  assert.ok(paragraphBlocks.length >= 3, "expected at least 3 paragraph blocks, got " + paragraphBlocks.length);
});
t("buildPageBody includes a bulleted source list under the article when sources exist", () => {
  const body = buildPageBody("p", { title: "T", url: "", article: { text: "Body.", sources: ["https://a.test/", "https://b.test/"] }, qa: [] });
  const bullets = body.children.filter(b => b.type === "bulleted_list_item");
  assert.strictEqual(bullets.length, 2);
});
t("buildPageBody omits the article's source list when there are no sources", () => {
  const body = buildPageBody("p", { title: "T", url: "", article: { text: "Body.", sources: [] }, qa: [] });
  assert.strictEqual(body.children.filter(b => b.type === "bulleted_list_item").length, 0);
});
t("buildPageBody renders each Q&A pair as a heading_3 (question) + paragraph (answer)", () => {
  const body = buildPageBody("p", { title: "T", url: "", article: null, qa: [
    { question: "Q1?", answer: "A1.", sources: [] },
    { question: "Q2?", answer: "A2.", sources: [] }
  ] });
  const headings = body.children.filter(b => b.type === "heading_3");
  assert.strictEqual(headings.length, 2);
  assert.ok(JSON.stringify(headings[0]).includes("Q1?"));
  assert.ok(JSON.stringify(headings[1]).includes("Q2?"));
});
t("buildPageBody includes a bulleted source list under each Q&A pair that has sources", () => {
  const body = buildPageBody("p", { title: "T", url: "", article: null, qa: [
    { question: "Q1?", answer: "A1.", sources: ["https://c.test/"] }
  ] });
  assert.strictEqual(body.children.filter(b => b.type === "bulleted_list_item").length, 1);
});
t("buildPageBody with neither article nor qa still produces a valid body (title + optional source link only)", () => {
  const body = buildPageBody("p", { title: "Bare card", url: "https://x.test", article: null, qa: [] });
  assert.strictEqual(body.properties.title.title[0].text.content, "Bare card");
  assert.ok(body.children.length >= 1);
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
