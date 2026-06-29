const assert = require("assert");
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
let passed = 0, failed = 0;
function t(n, fn){ try { fn(); passed++; } catch(e){ failed++; console.error("FAIL: "+n+"\n  "+(e&&e.message)); } }

t("startBatchCapture drives capture via the Core (Store.captureMeta)", () => {
  const i = html.indexOf("async function startBatchCapture");
  assert.ok(i >= 0, "startBatchCapture present");
  const body = html.slice(i, i + 3000);
  assert.ok(body.indexOf("Store.captureMeta") >= 0, "should call Store.captureMeta");
});

t("startBatchCapture stamps capReason and supports retry-clear + id subset", () => {
  const i = html.indexOf("async function startBatchCapture");
  const body = html.slice(i, i + 2500);
  assert.ok(body.indexOf("capReason") >= 0, "should stamp c.capReason");
  assert.ok(body.indexOf("onlyIds") >= 0, "should accept an explicit id subset");
  assert.ok(body.indexOf("Store.imgDel") >= 0, "retry should clear the existing image");
  assert.ok(body.indexOf("BATCH_CAP") < 0 || body.indexOf("slice(0, BATCH_CAP)") < 0, "loop should be uncapped (no BATCH_CAP slice)");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
