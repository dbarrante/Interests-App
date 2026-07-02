const assert = require("assert");
const fs = require("fs"), path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const { loadFns } = require("./_extract");
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
  // capReason is stamped by the shared applyCaptureResult helper the loop delegates to
  const ai = html.indexOf("function applyCaptureResult(");
  assert.ok(ai >= 0, "applyCaptureResult helper present");
  assert.ok(html.slice(ai, ai + 900).indexOf("capReason") >= 0, "helper stamps c.capReason");
  assert.ok(body.indexOf("applyCaptureResult(") >= 0, "loop applies results via the shared helper");
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
  // the r.imageUrl fallback now lives in the shared applyCaptureResult helper that
  // startBatchCapture's loop delegates to
  const ai = html.indexOf("function applyCaptureResult(");
  assert.ok(ai >= 0, "applyCaptureResult helper present");
  assert.ok(html.slice(ai, ai + 900).indexOf("imageUrl") >= 0, "helper applies r.imageUrl");
  const si = html.indexOf("async function startBatchCapture");
  const sb = html.slice(si, si + 3200);
  assert.ok(sb.indexOf("applyCaptureResult(") >= 0, "startBatchCapture applies results via the helper");
  const ei = html.indexOf("async function enrichOnOpen(");
  const eb = html.slice(ei, ei + 2400);
  assert.ok(eb.indexOf("m.imageUrl") >= 0, "enrichOnOpen applies m.imageUrl");
});

t("igShortcode extracts the IG post code from p/reel/reels/tv, else ''", () => {
  const { igShortcode } = loadFns(["igShortcode"]);
  assert.strictEqual(igShortcode("https://www.instagram.com/p/ABC123/"), "ABC123");
  assert.strictEqual(igShortcode("https://www.instagram.com/reel/DYnA8VyoVYR/"), "DYnA8VyoVYR");
  assert.strictEqual(igShortcode("https://www.instagram.com/reels/DZ-P1bMxOwg/"), "DZ-P1bMxOwg");
  assert.strictEqual(igShortcode("https://www.instagram.com/tv/XYZ9/"), "XYZ9");
  assert.strictEqual(igShortcode("https://www.instagram.com/accounts/login/"), "");
  assert.strictEqual(igShortcode("https://fatpita.net/?i=6043"), "");
});

t("IG match-and-heal: igHealMatch defined, heals by shortcode, called before addClip", () => {
  assert.ok(html.indexOf("function igHealMatch(") >= 0, "igHealMatch defined");
  const hi = html.indexOf("function igHealMatch(");
  const hb = html.slice(hi, hi + 1000);
  assert.ok(hb.indexOf("igShortcode") >= 0, "matches by shortcode");
  assert.ok(hb.indexOf("setCardImage") >= 0, "heals via setCardImage");
  assert.ok(hb.indexOf("isBadImg") >= 0 && hb.indexOf("cdninstagram") >= 0, "heals bad-image OR static-logo cards");
  const di = html.indexOf("async function drainCaptures(");
  const db = html.slice(di, di + 9000);
  assert.ok(db.replace(/\s/g, "").indexOf("if(!igHealMatch(cap))addClip(cap)") >= 0, "drainCaptures tries igHealMatch before addClip");
});

t("dedupClipUrl: bare homepages dedup, bare social feeds don't, path URLs dedup", () => {
  const { dedupClipUrl } = loadFns(["dedupClipUrl"]);
  assert.strictEqual(dedupClipUrl("training.linuxfoundation.org"), true);   // bare homepage -> dedup (was the bug)
  assert.strictEqual(dedupClipUrl("lazywinadmin.com"), true);
  assert.strictEqual(dedupClipUrl("facebook.com"), false);                  // bare social feed -> keep distinct posts separate
  assert.strictEqual(dedupClipUrl("instagram.com"), false);
  assert.strictEqual(dedupClipUrl("facebook.com/photo/x"), true);           // path -> dedup (clipKey folds in the post id)
  assert.strictEqual(dedupClipUrl("example.com/article"), true);
  assert.strictEqual(dedupClipUrl(""), false);
});

t("impRefresh lets the extension own the capture tab (no app window.open duplicate)", () => {
  const i = html.indexOf("function impRefresh(");
  const body = html.slice(i, i + 1800);
  assert.ok(body.indexOf("Store.setCaptureRequest(") >= 0, "still queues the capture request for the worker");
  assert.ok(body.indexOf("window.open(") < 0, "impRefresh must NOT open its own tab — the extension worker owns it");
});

t("recaptureViaWorker drives the extension batch with force+render (unified bulk Recapture)", () => {
  const i = html.indexOf("function recaptureViaWorker(");
  assert.ok(i >= 0, "recaptureViaWorker defined");
  const body = html.slice(i, i + 1700);
  assert.ok(body.indexOf("Store.setBatchState(") >= 0, "writes batch-state for the worker");
  assert.ok(/force:\s*1/.test(body), "sets force:1 so the recapture overwrites the existing image");
  assert.ok(/render:\s*1/.test(body), "sets render:1 so FB posts render-capture");
  assert.ok(body.indexOf("Store.captureMeta") < 0, "must NOT use the Core server-fetch (blind to social)");
});

t("captureSelected and retryFailFresh both route bulk recapture through the worker", () => {
  const ci = html.indexOf("function captureSelected(");
  assert.ok(html.slice(ci, ci + 300).indexOf("recaptureViaWorker(") >= 0, "captureSelected delegates to recaptureViaWorker");
  const ri = html.indexOf("function retryFailFresh(");
  const rb = html.slice(ri, ri + 600);
  assert.ok(rb.indexOf("recaptureViaWorker(") >= 0, "retryFailFresh uses the worker path");
  assert.ok(rb.indexOf("startBatchCapture(") < 0, "retryFailFresh must NOT use the Core batch (social-blind)");
});

t("toolbar 'Retry all' routes the whole failed set through the worker (not the Core fetch)", () => {
  const i = html.indexOf("function retryAllFailed(");
  assert.ok(i >= 0, "retryAllFailed defined");
  const body = html.slice(i, i + 400);
  assert.ok(body.indexOf("imported.filter(needsRetry)") >= 0, "retries the same set the failures modal lists");
  assert.ok(body.indexOf("recaptureViaWorker(") >= 0, "drives the worker");
  assert.ok(body.indexOf("startBatchCapture(") < 0, "must NOT use the Core fetch");
  // the Retry-all button must call retryAllFailed, not the old Core startBatchCapture('retry')
  assert.ok(html.indexOf("retryAllFailed()\">&#128260; Retry all") >= 0, "Retry all button wired to retryAllFailed");
  assert.ok(html.indexOf("startBatchCapture('retry')") < 0, "no Core 'retry' batch left wired to a button");
});

t("link checks are consolidated into ONE 'Check links' button (safety folded into the dead sweep)", () => {
  // one combined button, renamed
  assert.ok(html.indexOf("Check links<") >= 0, "the consolidated 'Check links' button exists");
  assert.ok(html.indexOf("Check dead links") < 0, "old 'Check dead links' label is gone (renamed)");
  assert.ok(html.indexOf("Check link safety") < 0, "separate 'Check link safety' button is gone");
  assert.ok(html.indexOf("checkLinkSafety(") < 0, "no checkLinkSafety reference remains");
  // the combined sweep still runs the safety pass (consolidation kept, not lost)
  const di = html.indexOf("async function checkDeadLinks(");
  assert.ok(di >= 0, "checkDeadLinks present");
  assert.ok(html.slice(di, di + 3200).indexOf("runSafetyPass(") >= 0, "checkDeadLinks still runs the safety pass");
  // orphaned safety-only code removed
  assert.ok(html.indexOf("function applySafetyRemoval(") < 0, "applySafetyRemoval removed");
  assert.ok(html.indexOf("function renderSafetyModal(") < 0, "renderSafetyModal removed");
  assert.ok(html.indexOf("function openSafetyReview(") < 0, "openSafetyReview removed");
  assert.ok(html.indexOf('id="safetyModal"') < 0, "safetyModal markup removed");
  // shared pieces the combined sweep needs are kept
  assert.ok(html.indexOf("async function runSafetyPass(") >= 0, "runSafetyPass kept (shared)");
  assert.ok(html.indexOf("function _threatLabel(") >= 0, "_threatLabel kept (used by deadRowHTML)");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
