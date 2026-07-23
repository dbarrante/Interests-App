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

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
