// tests/model-dropdown.test.js — the OpenRouter Model field is a cost-sorted dropdown
// (cheapest→priciest, price shown, Custom escape hatch) with the tested default.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("curated OR_MODELS list with per-model cost", /const OR_MODELS = \[/.test(src) && /google\/gemini-2\.5-flash-lite", "Gemini 2\.5 Flash-Lite ★", 0\.0006/.test(src));
ok("list is sorted cheapest → priciest", /\]\.sort\(\(a,b\)=>a\[2\]-b\[2\]\)/.test(src));
ok("cost label helper (free vs ~$X/stumble)", /function orModelCost\(c\)[\s\S]{0,120}?free[\s\S]{0,40}?rate-limited[\s\S]{0,60}?\/stumble/.test(src));
ok("dropdown shows the cost in each option", /esc\(m\[1\]\)[\s\S]{0,20}?esc\(orModelCost\(m\[2\]\)\)/.test(src));
ok("has a Custom option", /value="__custom__"/.test(src));
ok("openrouter Model field renders the dropdown", /S\.provider==="openrouter" \? orModelSelectHTML\(S\.models\.openrouter\)/.test(src));
ok("selecting a model persists it", /modelSelect[\s\S]{0,300}?S\.models\.openrouter=e\.target\.value[\s\S]{0,60}?save\("settings",S\)/.test(src));
ok("Custom reveals the text box", /__custom__[\s\S]{0,80}?_mi\.style\.display="block"/.test(src));
ok("hint notes web-search cost dominates", /web[\s\S]{0,20}?search[\s\S]{0,60}?dwarfs|dwarfs[\s\S]{0,60}?model cost/i.test(src));
ok("fresh-install default is gemini-2.5-flash-lite", /openrouter:\{label:"OpenRouter", model:"google\/gemini-2\.5-flash-lite"/.test(src));

console.log("model-dropdown: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
