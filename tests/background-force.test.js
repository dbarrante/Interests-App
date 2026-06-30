// Regression lock: the SW poller's single-capture path must PROPAGATE the
// request's `force` flag end-to-end (poller -> captureOneTab -> pendings ->
// capturePending -> captureTab). Without it, a ⟳ refresh delivered force:false,
// so drainCaptures' apply guard (force || viaRecap || cap.recap || isBadImg)
// discarded the real screenshot whenever the card already had a (non-bad) image
// — the card never updated and the spinner span forever. Confirmed via runtime
// capture inspection: cap.id matched the card but cap.force was false.
const assert = require("assert");
const fs = require("fs"), path = require("path");
const bg = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }

t("the capture poller passes req.force into captureOneTab", () => {
  assert.ok(/captureOneTab\(\s*req\.url\s*,\s*req\.id\s*\|\|\s*""\s*,\s*\(req\.delay\s*\|\|\s*0\)\s*,\s*!!req\.render\s*,\s*!!req\.force\s*\)/.test(bg),
    "pollCaptureRequest must call captureOneTab(..., !!req.render, !!req.force)");
});

t("captureOneTab accepts a force parameter", () => {
  assert.ok(/function captureOneTab\(url,\s*id,\s*delay,\s*render,\s*force\)/.test(bg),
    "captureOneTab signature must include force");
});

t("captureOneTab stores force on the pending entry", () => {
  const i = bg.indexOf("pendings[tabId] = {");
  assert.ok(i >= 0, "pendings entry present");
  const body = bg.slice(i, i + 240);
  assert.ok(/force:\s*!!force/.test(body), "pendings entry must carry force: !!force");
});

t("capturePending passes the pending force into captureTab (not hardcoded false)", () => {
  const i = bg.indexOf("async function capturePending(");
  assert.ok(i >= 0, "capturePending present");
  const body = bg.slice(i, i + 600);
  assert.ok(/captureTab\(t,\s*p\.delay,\s*!!p\.force,\s*p\.id\)/.test(body),
    "capturePending must call captureTab(t, p.delay, !!p.force, p.id)");
  assert.ok(!/captureTab\(t,\s*p\.delay,\s*false,\s*p\.id\)/.test(body),
    "capturePending must NOT hardcode force=false");
});

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
