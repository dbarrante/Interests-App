// tests/pill-style-parity.test.js — the category/tag pills in Stumble and Saved
// use the SAME small .tg style/size as the Imported tag sidebar (not the chunky
// .catpill). Source asserts (no browser harness).
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

// The shared small-pill baseline (this is the Imported tag size the others must match).
ok(".tg baseline is the small 10.5px / 2px 9px pill", /\.tg\{[^}]*font-size:10\.5px[^}]*padding:2px 9px[^}]*\}/.test(src));
ok(".tg.on active style exists", /\.tg\.on\{[^}]*background:var\(--accent\)[^}]*\}/.test(src));

// Stumble categories now live in a LEFT sidebar (like the Imported/Saved tabs) using the
// same .tg pill style, with a top-bar .tg fallback only when the sidebar is hidden (narrow).
ok("stCatSideHTML builds a .tag-side aside with .tg pills", /function stCatSideHTML\(\)[\s\S]{0,220}?class="tag-side"[\s\S]{0,160}?class="tg/.test(src));
ok("renderStumble wraps content beside the sidebar (stWrap → imp-body + stCatSideHTML)", /function stWrap\([\s\S]{0,160}?imp-body[\s\S]{0,60}?stCatSideHTML\(\)/.test(src));
ok("stumble top-bar pills are gated on the sidebar being off", /curTab==="stumble"[\s\S]{0,260}?stSidebarOn\(\) \? ""/.test(src));
// renderCatBar has TWO separate `curTab==="stumble"` checks: the category-pill
// selection (this assertion) and, further down, a `? "" : ...view-toggle row`
// guard whose catpill-classed buttons only exist in the FALSE branch (never
// rendered on Stumble). Scope this check to the first occurrence only — a
// blanket file-wide search would false-positive on that second, unrelated,
// already-empty-string-gated occurrence regardless of window size.
{
  const firstIdx = src.indexOf('curTab==="stumble"');
  const secondIdx = src.indexOf('curTab==="stumble"', firstIdx + 1);
  const catPillCheckRegion = src.slice(firstIdx, secondIdx);
  ok("stumble never uses the chunky .catpill", !/curTab==="stumble"[\s\S]{0,300}?class="catpill/.test(catPillCheckRegion));
}
ok("the view-toggle row's .catpill buttons are gated behind an empty-string Stumble branch",
  /curTab==="stumble" \? "" : `<span style="flex:1">/.test(src));

// Saved category sidebar (v1.12.14) uses .tg with counts, mirroring the tag sidebar.
ok("catSideHTML uses .tg pills with a count <b>", /function catSideHTML\(\)[\s\S]{0,600}?class="tg[\s\S]{0,120}?<b>/.test(src));

console.log("pill-style-parity: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
