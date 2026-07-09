// tests/stumble-news-data.test.js — renderer news data layer wired (source asserts).
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("newsMix defaults on", /newsMix:\s*true/.test(src));
ok("stNewsOnly + filterInterest state declared", /let\s+stNewsOnly\s*=\s*false/.test(src) && /filterInterest\s*=\s*""/.test(src));
ok("boot loads persisted news state", /stNewsOnly\s*=\s*await load\("stnewsonly"/.test(src) && /filterInterest\s*=\s*await load\("finterest"/.test(src));
ok("interestList parses S.interests", /function interestList\(\)[\s\S]{0,160}?S\.interests[\s\S]{0,80}?split\(","\)/.test(src));
ok("relTime helper exists", /function relTime\(ts\)/.test(src));
// NOTE: the {0,200} budget between "Store.news(" and "isNews:true" in the brief's original
// regex is too tight for the brief's own reference newsBatch() body (the full shaped-object
// literal between the two — id/title/url/source/category/benefit/image — runs ~410 chars).
// Widened to {0,450} to match the shipped (and brief-specified) code; order/logic unchanged.
ok("newsBatch calls Store.news + dropAlreadySaved + tags isNews", /function newsBatch\([\s\S]{0,400}?Store\.news\([\s\S]{0,450}?isNews:\s*true[\s\S]{0,120}?dropAlreadySaved/.test(src) || /function newsBatch\([\s\S]{0,600}?Store\.news\([\s\S]{0,400}?dropAlreadySaved[\s\S]{0,200}?isNews:\s*true/.test(src));
ok("stumbleFetch branches on stNewsOnly to newsBatch", /stumbleFetch[\s\S]{0,400}?stNewsOnly\s*\?[\s\S]{0,60}?newsBatch|stNewsOnly\s*\)\s*\{[\s\S]{0,80}?newsBatch/.test(src));
ok("discovery intermixes when S.newsMix", /S\.newsMix[\s\S]{0,120}?interleaveNews/.test(src));
// NOTE: same widening reason — the brief's own usableSpool() body opens with a 4-line
// explanatory comment before "isNews"/"stNewsOnly" show up, pushing the gap from
// "function usableSpool(){" past the original {0,200}/{0,260} budgets (~300/~360 chars).
ok("usableSpool keeps news past the discovery TTL", /function usableSpool\(\)[\s\S]{0,320}?isNews[\s\S]{0,80}?isFreshDiscoveryItem/.test(src));
ok("usableSpool skips category filter in news-only mode", /function usableSpool\(\)[\s\S]{0,380}?stNewsOnly\s*\?[\s\S]{0,60}?isNews/.test(src));

console.log("stumble-news-data: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
