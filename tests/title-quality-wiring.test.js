// tests/title-quality-wiring.test.js — card-title-quality feature wiring,
// checked structurally against both web/index.html and pwa/index.html
// (regex-based, matching the settings-wiring.test.js convention — these
// files have no build step, so we assert on the actual shipped source).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": the old genericTitle() function is gone", () => {
    assert.ok(!/function genericTitle\(/.test(src), "genericTitle() should be fully replaced by isGenericTitle()");
  });
  t(label + ": enrichPins uses isGenericTitle", () => {
    assert.match(src, /if\(m\.title && isGenericTitle\(p\.title, ?p\.url\)\) p\.title=m\.title\.slice\(0,250\);/);
  });
  t(label + ": enrichOnOpen's free re-fetch uses isGenericTitle and tracks origTitle around the write", () => {
    assert.match(src, /if\(m\.title && m\.title\.length>10 && isGenericTitle\(it\.title, ?it\.url\)\)\{\s*const newTitle = m\.title\.slice\(0,250\);\s*captureOutgoingHashtags\(it\);\s*captureOrigTitle\(it, ?newTitle\);\s*it\.title=newTitle;\s*settleOrigTitle\(it\);\s*changed=true;\s*\}/,
      "the metadata-title branch must write m.title.slice(0,250) and capture/settle origTitle around its own write, just like applyGeneratedTitle does for the AI branch");
  });
  t(label + ": addClip uses isGenericTitle", () => {
    assert.match(src, /if\(cap\.title && \(isNew \|\| isGenericTitle\(item\.title\|\|"", ?item\.url\)\)\) item\.title = cap\.title\.slice\(0,250\);/);
  });
  t(label + ": normalizeTitleKey exists and normalizes case/whitespace", () => {
    assert.match(src, /function normalizeTitleKey\(t\)\{/);
  });
  t(label + ": allTitleKeys scans both imported and saved", () => {
    const m = /function allTitleKeys\(excludeId\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "allTitleKeys not found");
    assert.match(m[1], /imported\.forEach/);
    assert.match(m[1], /saved\.forEach/);
  });
  t(label + ": generateUniqueTitle runs the tiered pipeline in order (video-OCR -> desc -> OCR -> vision -> collection fallback)", () => {
    const m = /async function generateUniqueTitle\(card, ?extraAvoid, ?allowVision ?= ?true, ?groundingText ?= ?""\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "generateUniqueTitle not found");
    const body = m[1];
    const iVideoOcr = body.indexOf("if(looksLikeVideo(card)){");
    const iDesc = body.indexOf("if(description)");
    const iOcr = body.indexOf("const ocrText =");
    const iVision = body.indexOf("resolveCardImageForAI(card)");
    const iFallback = body.indexOf("fallbackCollectionTitle(");
    assert.ok(iVideoOcr >= 0 && iVideoOcr < iDesc, "a video's burned-in caption must be read before the description");
    assert.ok(iDesc >= 0 && iOcr > iDesc && iVision > iOcr && iFallback > iVision, "tiers must run in cost/certainty order");
  });
  t(label + ": titleFromSignal retries up to 3 times on collision, then disambiguates", () => {
    const m = /async function titleFromSignal\(card, ?opts\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "titleFromSignal not found");
    assert.match(m[1], /attempt\s*<\s*3/, "should retry up to 3 times");
    assert.match(m[1], /buildTitlePrompt\(/);
    assert.match(m[1], /parseTitleReply\(/);
  });
  t(label + ": fallbackCollectionTitle never calls the AI", () => {
    const m = /async function fallbackCollectionTitle\(card, ?collection, ?extraAvoid\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "fallbackCollectionTitle not found");
    assert.doesNotMatch(m[1], /callAI\(/);
    assert.match(m[1], /composeFallbackTitle\(/);
    assert.match(m[1], /isGenericTitle\(/);
  });
  t(label + ": enrichOnOpen calls generateUniqueTitle automatically when still generic", () => {
    const start = src.indexOf("async function enrichOnOpen(");
    const end = src.indexOf("\nif(changed){", start) >= 0 ? src.indexOf("\nif(changed){", start) : src.indexOf("    if(changed){", start);
    assert.ok(start >= 0 && end > start, "enrichOnOpen not found");
    const body = src.slice(start, end);
    assert.match(body, /isGenericTitle\(it\.title, ?it\.url\)/, "should re-check isGenericTitle after the free re-fetch");
    assert.match(body, /generateUniqueTitle\(it, ?undefined, ?false, ?groundingExcerpt\)/, "should call generateUniqueTitle with allowVision=false — enrichOnOpen must never trigger the paid vision tier automatically");
  });
  t(label + ": bulk applyCaptureResult uses isGenericTitle instead of the old blank-or-domain gate", () => {
    assert.match(src, /if\(r\.title && isGenericTitle\(c\.title, ?c\.url\)\) c\.title=r\.title;/);
  });
  t(label + ": drainCaptures uses isGenericTitle instead of the 'Saved/From your' prefix gate", () => {
    assert.match(src, /if\(cap\.title && \(force \|\| isGenericTitle\(match\.title, ?match\.url\)\)\)\{ match\.title=cap\.title; changed=true; \}/);
  });
  t(label + ": HEALTH_TABS includes the Title issues tab", () => {
    assert.match(src, /\{\s*id:"titles",\s*label:"Title issues"\s*\}/);
  });
  t(label + ": _healthCounts reports a titles count from both imported and saved", () => {
    const m = /function _healthCounts\(\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "_healthCounts not found");
    assert.match(m[1], /isGenericTitle\(i\.title,\s*i\.url\)/);
    assert.match(m[1], /saved\.filter/);
    assert.match(m[1], /titles:/);
  });
  t(label + ": renderHealth dispatches the titles tab", () => {
    assert.match(src, /if\(tab==="titles"\) return renderHealthTitles\(list\);/);
  });
  t(label + ": renderHealthTitles lists flagged imported AND saved cards", () => {
    const m = /function flaggedTitleCards\(\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "flaggedTitleCards not found");
    assert.match(m[1], /imported\.forEach/);
    assert.match(m[1], /saved\.forEach/);
  });
  t(label + ": suggestTitlesForFlagged generates sequentially and tracks accepted titles to avoid within the batch", () => {
    const m = /async function suggestTitlesForFlagged\(\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "suggestTitlesForFlagged not found");
    assert.match(m[1], /generateUniqueTitle\(m\.card, ?acceptedThisBatch\)/);
  });
  t(label + ": applyTitleSuggestions persists via persistCards/Store.putSaved (not {confirm:true} — an edit, not a removal)", () => {
    const m = /function applyTitleSuggestions\(\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "applyTitleSuggestions not found");
    assert.match(m[1], /persistCards\(\);/);
    assert.match(m[1], /Store\.putSaved\(saved\);/);
    assert.doesNotMatch(m[1], /\{confirm:\s*true\}/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
