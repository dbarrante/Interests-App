// tests/ai-tag-chunk.test.js — aiTagChunk, the shared "send a chunk of cards
// to the AI, get tags+category back" core factored out of autoTag. autoTag
// itself keeps using merge:false (cards had none); the new AI-refresh batch
// (Task 8) uses merge:true (cards may already be tagged, tags add on top).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

const CATS = [{ name: "Personal" }, { name: "Work" }];
function catByName(n) { return CATS.find(c => c.name.toLowerCase() === String(n).toLowerCase()) || CATS[0]; }
function parseJsonArray(text) { try { const m = text.match(/\[[\s\S]*\]/); return m ? JSON.parse(m[0]) : null; } catch (e) { return null; } }

function load(src) {
  const factory = new Function(
    "callAI", "parseJsonArray", "CATS", "catByName",
    extractFn(src, "aiTagChunk") + "\nreturn aiTagChunk;"
  );
  return factory;
}

// Top-level await needs an async IIFE — this file is plain CommonJS.
(async () => {
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  await t(label + ": aiTagChunk merge:false sets tags fresh, falls back to ['misc'] when the AI returns none", async () => {
    const callAI = async () => JSON.stringify([{ t: ["fishing"], c: "Personal" }, { t: [], c: "Work" }]);
    const aiTagChunk = load(src)(callAI, parseJsonArray, CATS, catByName);
    const queue = [{ title: "a" }, { title: "b" }];
    await aiTagChunk(queue, { merge: false });
    assert.deepStrictEqual(queue[0].tags, ["fishing"]);
    assert.deepStrictEqual(queue[1].tags, ["misc"]);
    assert.strictEqual(queue[0].cat, "Personal");
    assert.strictEqual(queue[1].cat, "Work");
  });

  await t(label + ": aiTagChunk merge:true adds to existing tags, never forces 'misc' on an empty AI response", async () => {
    const callAI = async () => JSON.stringify([{ t: ["fishing"], c: "Personal" }, { t: [], c: "Work" }]);
    const aiTagChunk = load(src)(callAI, parseJsonArray, CATS, catByName);
    const queue = [{ title: "a", tags: ["bass"] }, { title: "b", tags: ["existing"] }];
    await aiTagChunk(queue, { merge: true });
    assert.deepStrictEqual(queue[0].tags.sort(), ["bass", "fishing"]);
    assert.deepStrictEqual(queue[1].tags, ["existing"]);   // untouched, NOT downgraded to ['misc']
  });

  await t(label + ": aiTagChunk merge:true dedupes when the AI re-suggests a tag the card already has", async () => {
    const callAI = async () => JSON.stringify([{ t: ["bass", "fishing"], c: "Personal" }]);
    const aiTagChunk = load(src)(callAI, parseJsonArray, CATS, catByName);
    const queue = [{ title: "a", tags: ["bass"] }];
    await aiTagChunk(queue, { merge: true });
    assert.deepStrictEqual(queue[0].tags.sort(), ["bass", "fishing"]);
  });

  await t(label + ": aiTagChunk sets .category (not .cat) for a card that already has a .category field (saved-scope)", async () => {
    const callAI = async () => JSON.stringify([{ t: ["x"], c: "Work" }]);
    const aiTagChunk = load(src)(callAI, parseJsonArray, CATS, catByName);
    const queue = [{ title: "a", category: "Personal" }];
    await aiTagChunk(queue, { merge: false });
    assert.strictEqual(queue[0].category, "Work");
    assert.strictEqual(queue[0].cat, undefined);
  });

  await t(label + ": aiTagChunk includes a saved-scope card's .benefit in the prompt (not just .desc)", async () => {
    let sentPrompt = "";
    const callAI = async (p) => { sentPrompt = p; return JSON.stringify([{ t: ["x"], c: "Personal" }]); };
    const aiTagChunk = load(src)(callAI, parseJsonArray, CATS, catByName);
    const queue = [{ title: "a", benefit: "A saved-card description" }];
    await aiTagChunk(queue, { merge: false });
    assert.ok(sentPrompt.indexOf("A saved-card description") >= 0, "prompt must include the saved card's .benefit text");
  });

  await t(label + ": aiTagChunk throws when the AI response can't be parsed (propagates to the caller, matches autoTag's existing error handling)", async () => {
    const callAI = async () => "not json";
    const aiTagChunk = load(src)(callAI, parseJsonArray, CATS, catByName);
    await assert.rejects(() => aiTagChunk([{ title: "a" }], { merge: false }));
  });
}
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
})();
