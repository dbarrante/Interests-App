// Runs the syntax gate first, then every tests/*.test.js as a child process.
// Each test file prints "<p> passed, <f> failed" and exits non-zero on failure.
// This runner exits non-zero if ANY child exits non-zero.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const testsDir = __dirname;
const node = process.execPath;

// BLANKET ISOLATION: every child gets a throwaway APPDATA, so no test — present
// or future — can touch the REAL %APPDATA%\Interests App\config.json. A test
// run killed mid-flight used to leave the production store/backup pointers
// aimed at temp dirs, which hijacked the installed app's store on
// 2026-07-14..16 (root cause of the 07-16 data-loss event). The three known
// config-writing tests also isolate themselves individually (defense in depth
// for direct `node tests/<file>` runs).
const os = require("os");
const isolatedAppData = fs.mkdtempSync(path.join(os.tmpdir(), "ia-run-ad-"));
const childEnv = Object.assign({}, process.env, { APPDATA: isolatedAppData });

function run(file) {
  const r = spawnSync(node, [path.join(testsDir, file)], { stdio: "inherit", env: childEnv });
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
