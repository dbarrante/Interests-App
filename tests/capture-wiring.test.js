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

t("fail modal renders live Success/REMOVED/Recapturing status, refreshed by drainCaptures", () => {
  assert.ok(html.indexOf("function _failRowStatus(") >= 0, "_failRowStatus defined");
  const i = html.indexOf("function _failRowStatus(");
  const b = html.slice(i, i + 400);
  assert.ok(b.indexOf('"removed"') >= 0, "card missing from imported → removed");
  assert.ok(b.indexOf("isBadImg") >= 0 && b.indexOf('"success"') >= 0, "good image → success");
  assert.ok(html.indexOf("function refreshFailStatuses(") >= 0, "refreshFailStatuses defined");
  const di = html.indexOf("async function drainCaptures(");
  const dbody = html.slice(di, di + 9000);
  assert.ok(dbody.indexOf("refreshFailStatuses(") >= 0, "drainCaptures refreshes fail statuses");
  const fi = html.indexOf("function failRowHTML(");
  const fbody = html.slice(fi, fi + 900);
  assert.ok(fbody.indexOf("data-card=") >= 0 && fbody.indexOf('class="fst"') >= 0, "row has data-card + status slot");
});

t("openFailOne clears image backup-first, sets last-opened + recapturing, then opens in browser", () => {
  const i = html.indexOf("function openFailOne(");
  const b = html.slice(i, i + 800);
  assert.ok(b.indexOf("snapshotBeforeDestructive(") >= 0, "backs up before clearing");
  assert.ok(b.indexOf("Store.imgDel(") >= 0, "clears the existing image");
  assert.ok(b.indexOf("ia_last_opened") >= 0, "records last-opened for extension Remove fallback");
  assert.ok(b.indexOf('"recapturing"') >= 0, "marks the card recapturing");
  assert.ok(b.indexOf("openUrlsInTabs(") >= 0, "still opens the link in the browser");
});

t("recapture heal wiring: openFailOne arms _recapTarget; drainCaptures passes + disarms; viaRecap prefers screenshot", () => {
  assert.ok(html.indexOf("let _recapTarget") >= 0, "_recapTarget declared");
  const oi = html.indexOf("function openFailOne(");
  const ob = html.slice(oi, oi + 800);
  assert.ok(ob.indexOf("_recapTarget") >= 0, "openFailOne arms _recapTarget");
  const di = html.indexOf("async function drainCaptures(");
  const db = html.slice(di, di + 7000);
  assert.ok(db.replace(/\s/g, "").indexOf("recapTarget:_recapTarget") >= 0, "drainCaptures passes recapTarget to routeCapture");
  assert.ok(db.indexOf("viaRecap") >= 0, "drainCaptures computes viaRecap");
  assert.ok(db.replace(/\s/g, "").indexOf("_recapTarget=null") >= 0, "disarms _recapTarget after heal");
});

t("grid recapture arms the heal target: impRefresh always, impOpen only when doCapture", () => {
  const ri = html.indexOf("function impRefresh(");
  const rb = html.slice(ri, ri + 1200);
  assert.ok(rb.indexOf("_recapTarget") >= 0, "impRefresh arms _recapTarget");
  const oi = html.indexOf("function impOpen(");
  const ob = html.slice(oi, oi + 1700);
  assert.ok(ob.indexOf("_recapTarget") >= 0, "impOpen arms _recapTarget");
  assert.ok(ob.replace(/\s/g, "").indexOf("if(doCapture)_recapTarget") >= 0, "impOpen arms only when doCapture");
});

t("enrichOnOpen enriches via the Core (no CORS proxy): uses Store.captureMeta, no allorigins", () => {
  const ei = html.indexOf("async function enrichOnOpen(");
  const eb = html.slice(ei, ei + 2200);
  assert.ok(eb.indexOf("Store.captureMeta(") >= 0, "enrichOnOpen calls the Core capture-meta");
  assert.ok(eb.indexOf("allorigins.win") < 0, "no api.allorigins.win proxy fetch remains");
});

t("og-url fallback applied: startBatchCapture + enrichOnOpen handle r.imageUrl", () => {
  const si = html.indexOf("async function startBatchCapture");
  const sb = html.slice(si, si + 3200);
  assert.ok(sb.indexOf("imageUrl") >= 0, "startBatchCapture applies imageUrl");
  const ei = html.indexOf("async function enrichOnOpen(");
  const eb = html.slice(ei, ei + 2400);
  assert.ok(eb.indexOf("m.imageUrl") >= 0, "enrichOnOpen applies m.imageUrl");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
