// Runs the syntax gate first, then every tests/*.test.js as a child process.
// Each test file prints "<p> passed, <f> failed" and exits non-zero on failure.
// This runner exits non-zero if ANY child exits non-zero.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const testsDir = __dirname;
const node = process.execPath;

function run(file) {
  const r = spawnSync(node, [path.join(testsDir, file)], { stdio: "inherit" });
  return r.status === 0;
}

let ok = true;

console.log("== syntax-check.js ==");
ok = run("syntax-check.js") && ok;

const testFiles = fs
  .readdirSync(testsDir)
  .filter((f) => f.endsWith(".test.js"))
  .sort();

for (const f of testFiles) {
  console.log("== " + f + " ==");
  ok = run(f) && ok;
}

console.log(ok ? "ALL TEST FILES PASSED" : "SOME TEST FILES FAILED");
process.exit(ok ? 0 : 1);
