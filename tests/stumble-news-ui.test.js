// tests/stumble-news-ui.test.js — Stumble news UI wired (source asserts).
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("News toggle pill in the discovery sidebar", /function stCatSideHTML\(\)[\s\S]{0,400}?toggleNewsOnly\(\)[\s\S]{0,40}?News/.test(src));
ok("stNewsSideHTML lists interests as .tg pills", /function stNewsSideHTML\(\)[\s\S]{0,400}?interestList\(\)[\s\S]{0,160}?setNewsInterest/.test(src));
ok("stWrap dispatches to the news sidebar in news-only mode", /function stWrap\([\s\S]{0,200}?stNewsOnly\s*\?[\s\S]{0,40}?stNewsSideHTML\(\)[\s\S]{0,40}?stCatSideHTML\(\)/.test(src));
ok("toggleNewsOnly flips + persists + refetches", /function toggleNewsOnly\(\)[\s\S]{0,200}?save\("stnewsonly"[\s\S]{0,150}?stumbleNext\(\)/.test(src));
ok("setNewsInterest sets + persists + refetches", /function setNewsInterest\(k\)[\s\S]{0,200}?save\("finterest"[\s\S]{0,120}?stumbleNext\(\)/.test(src));
ok("stCardHTML shows a news badge", /it\.isNews\s*\?[\s\S]{0,80}?news-badge/.test(src));
ok(".news-badge CSS exists", /\.news-badge\{/.test(src));
ok("Settings has a Mix-news toggle wired to S.newsMix", /id="newsMixToggle"/.test(src) && /S\.newsMix\s*=\s*e\.target\.checked/.test(src));
ok("news empty-state nudge when no interests", /stNewsOnly[\s\S]{0,80}?interestList\(\)\.length[\s\S]{0,200}?[Ii]nterests/.test(src));

console.log("stumble-news-ui: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
