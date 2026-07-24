// tests/title-tiers-structural.test.js — structural checks (regex against the
// actual shipped source, no build step) for the browser-only pieces of the
// tiered title-generation pipeline that can't run in Node (canvas/fetch/OCR).
// Mirrors tests/title-quality-wiring.test.js's per-file convention.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": resolveCardImageForAI exists and downscales to a bounded edge", () => {
    const m = /async function resolveCardImageForAI\(card\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "resolveCardImageForAI not found");
    assert.match(m[1], /maxEdge\s*=\s*1024/);
    assert.match(m[1], /image\/jpeg/);
    assert.match(m[1], /quality\s*:\s*0\.7/);
    assert.match(m[1], /idb:/, "must handle idb:-backed images");
    assert.match(m[1], /Store\.ensureImage/);
  });
  t(label + ": resolveCardImageForAI returns null on failure, never throws to its caller", () => {
    const m = /async function resolveCardImageForAI\(card\)\{([\s\S]*?)\n\}/.exec(src);
    assert.match(m[1], /catch\s*\(e\)\{[^}]*return null;/);
  });
  t(label + ": ocrExtractText loads Tesseract.js on demand and applies a confidence/length bar", () => {
    const m = /async function ocrExtractText\(card\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "ocrExtractText not found");
    assert.match(m[1], /resolveCardImageForAI\(card\)/);
    assert.match(m[1], /loadTesseract\(/);
    assert.match(m[1], /OCR_MIN_CHARS/);
    assert.match(m[1], /OCR_MIN_CONFIDENCE/);
  });
  t(label + ": OCR thresholds match the design spec (>=15 chars, >=60% confidence)", () => {
    assert.match(src, /const OCR_MIN_CHARS\s*=\s*15;/);
    assert.match(src, /const OCR_MIN_CONFIDENCE\s*=\s*60;/);
  });
  t(label + ": loadTesseract loads the vendored local copy (not a CDN -- Electron's CSP blocks script-src to external hosts), cached after first load", () => {
    const m = /function loadTesseract\(\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "loadTesseract not found");
    assert.match(m[1], /loadScript\(["']tesseract\.min\.js["']\)/, "must load the local vendored file via the existing loadScript() helper");
    assert.doesNotMatch(m[1], /cdnjs\.cloudflare\.com|jsdelivr\.net|unpkg\.com/, "must not load Tesseract.js from a CDN -- blocked by the Electron app's script-src 'self' CSP");
    assert.match(m[1], /window\.Tesseract/);
  });
  t(label + ": GEMINI_VISION_MODELS is a curated, dated, all-multimodal list (design spec: Gemini's API exposes no pricing/modality)", () => {
    assert.match(src, /const GEMINI_VISION_MODELS\s*=\s*\[/);
    assert.match(src, /gemini-2\.5-flash-lite/);
  });
  t(label + ": loadVisionModelsForPicker dispatches OpenRouter (dynamic) vs Gemini (curated) vs everything else (none)", () => {
    const m = /async function loadVisionModelsForPicker\(\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "loadVisionModelsForPicker not found");
    assert.match(m[1], /IA_AI\.listVisionModels\(\)/);
    assert.match(m[1], /GEMINI_VISION_MODELS/);
  });
  t(label + ": the picker is wired into renderHealthTitles and writes to _titleVisionModel", () => {
    assert.match(src, /_titleVisionModel\s*=\s*this\.value/);
    const start = src.indexOf("function renderHealthTitles(list){");
    assert.ok(start >= 0, "renderHealthTitles not found");
    const region = src.slice(start, start + 4000);
    assert.match(region, /visionPickerHTML\(/);
  });
  t(label + ": renderHealthTitles gates the picker render on S.provider (openrouter/gemini only)", () => {
    const start = src.indexOf("function renderHealthTitles(list){");
    assert.ok(start >= 0, "renderHealthTitles not found");
    const region = src.slice(start, start + 4000);
    assert.match(
      region,
      /\(S\.provider===["']openrouter["']\|\|S\.provider===["']gemini["']\)\s*\?\s*visionPickerHTML\(_titleVisionModels\)\s*:\s*""/,
      "the visionPickerHTML(...) call must be gated on S.provider, not unconditional"
    );
  });
  t(label + ": loadVisionModelsForPicker's resolution seeds _titleVisionModel with the cheapest model when unset", () => {
    assert.match(
      src,
      /loadVisionModelsForPicker\(\)\.then\(models=>\{\s*_titleVisionModels\s*=\s*models;\s*if\(!_titleVisionModel\s*&&\s*models\.length\)\s*_titleVisionModel\s*=\s*models\[0\]\.id;/,
      "must default _titleVisionModel to models[0].id (cheapest) when the user hasn't picked one"
    );
  });
  t(label + ": switching provider in Settings resets the vision picker cache", () => {
    assert.match(
      src,
      /S\.provider=l\.dataset\.p;\s*_titleVisionModels\s*=\s*null;\s*_titleVisionModel\s*=\s*"";/,
      "the provider-picker onclick must reset _titleVisionModels/_titleVisionModel so a stale list/selection doesn't leak across providers"
    );
  });
  t(label + ": rehydrateAfterSync resets the vision picker cache when a background sync changes S.provider", () => {
    const m = /async function rehydrateAfterSync\(\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "rehydrateAfterSync not found");
    assert.match(m[1], /const prevProvider\s*=\s*S\.provider;/, "must capture the pre-Object.assign provider to detect a change");
    assert.match(
      m[1],
      /if\s*\(\s*S\.provider\s*!==\s*prevProvider\s*\)\s*\{\s*_titleVisionModels\s*=\s*null;\s*_titleVisionModel\s*=\s*"";\s*\}/,
      "must reset _titleVisionModels/_titleVisionModel when a sync silently changes S.provider, guarded so unrelated syncs don't clobber an in-progress pick"
    );
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
