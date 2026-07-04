// tests/model-dropdown.test.js — the OpenRouter Model field is a curated dropdown
// (grouped, with a Custom escape hatch) and the default model is the tested one.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("curated OR_MODELS list exists", /const OR_MODELS = \[/.test(src));
ok("recommended list leads with gemini-2.5-flash-lite", /OR_MODELS[\s\S]{0,200}?google\/gemini-2\.5-flash-lite/.test(src));
ok("includes a free group (rate-limited)", /Free[\s\S]{0,40}?rate-limited[\s\S]{0,200}?:free/.test(src));
ok("orModelSelectHTML builds a <select> with optgroups + Custom", /function orModelSelectHTML\(cur\)[\s\S]{0,400}?optgroup[\s\S]{0,200}?__custom__/.test(src));
ok("openrouter Model field renders the dropdown (not a bare text input)", /S\.provider==="openrouter" \? orModelSelectHTML\(S\.models\.openrouter\)/.test(src));
ok("selecting a model persists it (save on change)", /modelSelect[\s\S]{0,300}?S\.models\.openrouter=e\.target\.value[\s\S]{0,60}?save\("settings",S\)/.test(src));
ok("Custom reveals the text box", /__custom__[\s\S]{0,80}?_mi\.style\.display="block"/.test(src));
ok("fresh-install default is gemini-2.5-flash-lite", /openrouter:\{label:"OpenRouter", model:"google\/gemini-2\.5-flash-lite"/.test(src));

console.log("model-dropdown: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
