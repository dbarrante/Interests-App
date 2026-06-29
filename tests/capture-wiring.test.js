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

t("mark-done is durable: sets capDone and captureable excludes it", () => {
  assert.ok(html.indexOf("c.capDone=true") >= 0, "markFailDone sets capDone");
  assert.ok(/function captureable\(i\)\{[^}]*!i\.capDone/.test(html), "captureable excludes capDone cards");
});

t("failed-capture triage modal exists and groups by reason with actions", () => {
  assert.ok(html.indexOf('id="failModal"') >= 0, "fail triage modal present");
  assert.ok(html.indexOf("function openFailReview") >= 0);
  assert.ok(html.indexOf("c.capReason") >= 0 || html.indexOf(".capReason") >= 0, "triage reads capReason");
  assert.ok(html.indexOf("function retryFailFresh") >= 0 && html.indexOf("function removeFailSelected") >= 0 && html.indexOf("function markFailDone") >= 0);
});

t("openUrlsInTabs is the shared open-in-tabs helper, used by openSelected", () => {
  assert.ok(html.indexOf("function openUrlsInTabs(") >= 0, "openUrlsInTabs defined");
  const oi = html.indexOf("function openUrlsInTabs(");
  const obody = html.slice(oi, oi + 1600);
  assert.ok(obody.indexOf("https?:") >= 0, "keeps http(s)-only guard");
  assert.ok(obody.indexOf(">25") >= 0 && obody.indexOf("confirm(") >= 0, "keeps the 25-tab confirm");
  assert.ok(obody.indexOf("window.open(") >= 0, "opens via window.open (browser tab)");
  const si = html.indexOf("function openSelected(");
  const sbody = html.slice(si, si + 600);
  assert.ok(sbody.indexOf("openUrlsInTabs(") >= 0, "openSelected delegates to openUrlsInTabs");
  assert.ok(sbody.indexOf("_openedSel") >= 0, "openSelected still passes its session skip-set");
});

t("fail modal: title opens one link in browser; Open button opens selected via openUrlsInTabs", () => {
  assert.ok(html.indexOf("function openFailSelected(") >= 0, "openFailSelected defined");
  assert.ok(html.indexOf("function openFailOne(") >= 0, "openFailOne defined");
  const fi = html.indexOf("function failRowHTML(");
  const fbody = html.slice(fi, fi + 800);
  assert.ok(fbody.indexOf("openFailOne(") >= 0, "title click opens one link");
  const ri = html.indexOf("function renderFailModal(");
  const rbody = html.slice(ri, ri + 2600);
  assert.ok(rbody.indexOf("openFailSelected()") >= 0, "Open button calls openFailSelected");
  const oi = html.indexOf("function openFailSelected(");
  const obody = html.slice(oi, oi + 400);
  assert.ok(obody.indexOf("openUrlsInTabs(") >= 0, "openFailSelected uses the shared browser-tab helper");
  assert.ok(obody.indexOf("openInApp") < 0, "must not use the reuse-window path");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
