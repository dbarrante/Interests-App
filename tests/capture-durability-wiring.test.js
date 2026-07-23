const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const surfaces = ["web/index.html", "pwa/index.html"];
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("  ok  " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); }
}

for (const rel of surfaces) {
  const source = fs.readFileSync(path.join(root, rel), "utf8");
  t(rel + ": destructive restore requires a verified safety backup", () => {
    assert.match(source, /const safety = await verifiedSafetyBackup\("Restore"\)/);
    assert.match(source, /res\.ok!==false\s*&&\s*res\.verified===true/);
  });
  t(rel + ": imported clear requires the same backup gate", () => {
    assert.match(source, /if\(!await verifiedSafetyBackup\("Clear imported items"\)\)/);
  });
  t(rel + ": imported auto-capture persistence is awaited before ACK", () => {
    assert.match(source, /async function ingestImported\(found\)/);
    assert.match(source, /await Store\.putCards\(imported\); renderImportStatus\(\);/);
    assert.match(source, /await Store\.ackCaptures\(pendingAck\)/);
    assert.ok(!source.includes("remaining.push(cap)"), "old dequeue/re-enqueue path must be gone");
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
