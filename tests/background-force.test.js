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

t("SW has a batch driver (pollBatchState) that loops captureOneTab with force+render", () => {
  assert.ok(/async function pollBatchState\(/.test(bg), "pollBatchState defined");
  const i = bg.indexOf("async function pollBatchState(");
  const body = bg.slice(i, i + 3600);
  assert.ok(body.indexOf("/api/batch-state") >= 0, "reads the batch-state mailbox");
  assert.ok(/captureOneTab\(it\.url,\s*it\.id\s*\|\|\s*""\s*,\s*delay,\s*render,\s*force\)/.test(body),
    "drives captureOneTab with delay, render AND force");
  assert.ok(body.indexOf("/api/batch-progress") >= 0, "writes batch-progress for the app UI");
  assert.ok(body.indexOf("cur.cancel") >= 0 && body.indexOf("cur.active === false") >= 0,
    "honors the app's Stop (cancel / active:false), re-read each item");
});

t("the batch driver has a re-entrancy guard and is registered on the alarm + startup", () => {
  assert.ok(/let batchDriving = false/.test(bg), "batchDriving re-entrancy guard declared");
  const i = bg.indexOf("async function pollBatchState(");
  assert.ok(/if \(batchDriving\) return;/.test(bg.slice(i, i + 120)), "guards re-entry at the top");
  const ip = bg.indexOf("function iaPollAll()");
  assert.ok(ip >= 0, "iaPollAll defined");
  assert.ok(bg.slice(ip, ip + 130).indexOf("pollBatchState()") >= 0, "iaPollAll runs pollBatchState");
  assert.ok(bg.indexOf('a.name === "iaCapturePoll") iaPollAll()') >= 0, "alarm fires iaPollAll");
  assert.ok(bg.indexOf("chrome.runtime.onStartup.addListener(iaPollAll)") >= 0, "runs on SW startup");
});

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
