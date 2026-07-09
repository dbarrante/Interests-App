// tests/storage-se-news.test.js — SE.news builds the encoded /api/news URL. (Store itself
// only attaches in a browser with fetch; here we require the module purely for SE, which it
// exports via CommonJS: module.exports = { SE }.)
const assert = require("assert");
const { SE } = require("../web/storage.js");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("SE.news exists", SE && typeof SE.news === "function");
ok("joins + encodes interests", SE.news(["woodworking", "modular synths"]) === "/api/news?interests=woodworking%2Cmodular%20synths");
ok("empty list → bare param", SE.news([]) === "/api/news?interests=");

console.log("storage-se-news: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
