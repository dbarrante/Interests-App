const assert = require("assert");
const fs = require("fs"), path = require("path");
const bg = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }

t("manual capture sessions are persisted via chrome.storage.session (not a plain in-memory object)", () => {
  // A plain JS object would be wiped by MV3 service-worker suspension, which
  // is the COMMON case here (unbounded, human-paced wait) -- must be backed
  // by storage that survives suspension, same mechanism as B12's
  // persistPending/clearPendingPersist.
  assert.ok(/function manualCaptureKey\(tabId\)/.test(bg));
  assert.ok(/chrome\.storage\.session\.get\(manualCaptureKey\(tabId\)\)/.test(bg));
  assert.ok(/chrome\.storage\.session\.set\(\{ \[manualCaptureKey\(tabId\)\]: session \}\)/.test(bg));
  assert.ok(!/let manualCaptureSessions = \{\};/.test(bg), "must not fall back to a plain in-memory map");
});
t("each tab gets its own storage key, not a shared map read-modify-write (avoids a cross-tab overwrite race)", () => {
  // A single shared key holding a tabId->session map would need get-mutate-set
  // across an await boundary; two tabs' sessions overlapping in time could
  // interleave those awaits and the second set() would silently clobber the
  // first tab's entry with a stale snapshot. A per-tab key (ia_manual_capture_
  // session_<tabId>) makes that impossible -- different tabs never share a key.
  assert.ok(/"ia_manual_capture_session_" \+ tabId/.test(bg));
  assert.ok(!/getManualCaptureSessions\s*\(/.test(bg), "must not reintroduce a shared whole-map getter");
  assert.ok(/chrome\.storage\.session\.remove\(manualCaptureKey\(tabId\)\)/.test(bg),
    "clearManualCaptureSession must remove just that tab's own key, not read-modify-write a shared map");
});
t("regionSelectCrop reuses the existing cropScreenshot primitive, keyed by sender.tab", () => {
  const i = bg.indexOf('msg.action === "regionSelectCrop"');
  assert.ok(i >= 0);
  const body = bg.slice(i, i + 900);
  assert.ok(/await cropScreenshot\(tab, msg\.rect\)/.test(body));
  assert.ok(/const tab = sender\.tab;/.test(body));
});
t("regionSelectCrop reports failure (not silent success) when no session exists for the tab", () => {
  const i = bg.indexOf('msg.action === "regionSelectCrop"');
  const body = bg.slice(i, i + 900);
  assert.ok(/if \(!session\) \{ sendResponse\(\{ ok: false, error: "no capture session" \}\); return; \}/.test(body),
    "a missing session (e.g. lost to SW suspension) must respond ok:false, never a silent ok:true");
});
t("regionSelectFinalize delivers with force:true and the session's id (empty string for standalone)", () => {
  const i = bg.indexOf('msg.action === "regionSelectFinalize"');
  assert.ok(i >= 0);
  const body = bg.slice(i, i + 2000);
  assert.ok(/const capture = \{ url: session\.url, id: session\.id \|\| ""/.test(body));
  assert.ok(/screenshot: session\.dataUrl/.test(body));
  assert.ok(/force: true/.test(body));
  assert.ok(/await deliverToApp\(capture\);/.test(body));
  assert.ok(!/clip:\s*true/.test(body), "regionSelectFinalize's delivery must never set clip:true -- that would always route to a new Saved item and never match an existing Imported card by id/url");
});
t("regionSelectFinalize's delivery carries the tab's real page title, but ONLY for a standalone (no-id) session", () => {
  // A titled delivery for an id-matched session would route through
  // drainCaptures' card-image path, where cap.title unconditionally
  // overwrites match.title whenever force is set (force is always true
  // here) -- silently clobbering a user's manually-renamed (titleSet) card
  // title on every ordinary id-matched recapture, with no origTitle
  // rollback recorded (caught in final review 2026-08-05). The id-matched
  // path already had a title before this feature existed; only the
  // standalone/no-match path (which creates a brand-new card via addClip)
  // needs one, so the title must be conditional on !session.id.
  const i = bg.indexOf('msg.action === "regionSelectFinalize"');
  const body = bg.slice(i, i + 2500);
  assert.ok(/if \(!session\.id\) capture\.title = \(sender\.tab && sender\.tab\.title\) \|\| "";/.test(body),
    "title must only be attached for a standalone (id-less) session, never an id-matched recapture");
});
t("regionSelectFinalize closes the tab and calls /api/focus-app for ANY app-triggered session (session.id), not just one the extension itself created", () => {
  const i = bg.indexOf('msg.action === "regionSelectFinalize"');
  const body = bg.slice(i, i + 2500);
  assert.ok(!/session\.owned/.test(body), "must not still gate on session.owned -- that left the tab open in the common case where the app's own openLink tab was found");
  const gateIdx = body.indexOf("if (session.id) {");
  assert.ok(gateIdx >= 0, "close+focus must be gated on session.id");
  const closeIdx = body.indexOf("chrome.tabs.remove(tab.id)", gateIdx);
  const focusIdx = body.indexOf("/api/focus-app", gateIdx);
  assert.ok(closeIdx > gateIdx, "chrome.tabs.remove must be inside the session.id gate");
  assert.ok(focusIdx > closeIdx, "the /api/focus-app call must be inside the gate too, after the tab close");
});
t("regionSelectFinalize's /api/focus-app call uses findAppPort() and is a fire-and-forget POST (never fails the response)", () => {
  const i = bg.indexOf('msg.action === "regionSelectFinalize"');
  const body = bg.slice(i, i + 2500);
  const gateIdx = body.indexOf("if (session.id) {");
  const gated = body.slice(gateIdx, body.indexOf("sendResponse({ ok: true });", gateIdx));
  assert.ok(/findAppPort\(\)/.test(gated));
  assert.ok(/method: "POST"/.test(gated));
  assert.ok(/catch \(e\) \{\}/.test(gated), "a focus-app fetch failure must be swallowed, not thrown");
});
t("regionSelectFinalize never closes the tab or calls /api/focus-app for a standalone (id-less) session", () => {
  const i = bg.indexOf('msg.action === "regionSelectFinalize"');
  const body = bg.slice(i, i + 2500);
  const gateIdx = body.indexOf("if (session.id) {");
  const closeIdx = body.indexOf("chrome.tabs.remove(tab.id)");
  const focusIdx = body.indexOf("/api/focus-app");
  assert.ok(gateIdx < closeIdx && closeIdx < focusIdx, "both the close and the focus call must live inside the session.id gate, in that order");
});
t("startManualCapture still falls back to creating its own tab when no already-open tab is found, and no longer tracks owned (dead since regionSelectFinalize now gates on session.id)", () => {
  const startIdx = bg.indexOf("async function startManualCapture(req) {");
  const startBody = bg.slice(startIdx, startIdx + 2400);
  assert.ok(!/\bowned\b/.test(startBody), "owned must be fully removed -- it was only ever read by regionSelectFinalize's now-superseded session.owned gate");
  assert.ok(/chrome\.tabs\.create\(\{ url: req\.url, active: true \}\)/.test(startBody),
    "still falls back to creating its own tab when no app-opened tab is found");
  assert.ok(/setManualCaptureSession\(tab\.id, \{ id: req\.id \|\| "", url: req\.url \}\)/.test(startBody));
});
t("regionSelectCancel only notifies the app for an app-triggered session (has an id), not a standalone one", () => {
  const i = bg.indexOf('msg.action === "regionSelectCancel"');
  assert.ok(i >= 0);
  const body = bg.slice(i, i + 700);
  assert.ok(/if \(session\.id\) await deliverToApp/.test(body));
});
t("chrome.tabs.onRemoved clears a leaked manual-capture session if the user closes the tab directly", () => {
  const i = bg.indexOf("chrome.tabs.onRemoved.addListener((tabId) => {");
  assert.ok(i >= 0);
  const body = bg.slice(i, i + 500);
  assert.ok(/getManualCaptureSession\(tabId\)/.test(body));
  assert.ok(/clearManualCaptureSession\(tabId\)/.test(body));
});
t("chrome.tabs.onRemoved reports an app-triggered attempt as failed (id truthy) so the card doesn't show 'pending' forever, but stays silent for a standalone session (id falsy)", () => {
  const i = bg.indexOf("chrome.tabs.onRemoved.addListener((tabId) => {");
  const body = bg.slice(i, i + 500);
  assert.ok(/if \(session && session\.id\) \{/.test(body),
    "must only report to the app when the session is app-triggered (truthy id) -- standalone sessions (id:\"\") have nothing to report");
  assert.ok(/deliverToApp\(\{ url: session\.url, id: session\.id, attempt: true, ok: false, ts: Date\.now\(\) \}\)/.test(body));
});
t("chrome.tabs.onRemoved reads the session BEFORE clearing it (clearManualCaptureSession is idempotent, so this is a safe no-op after a normal Finalize/Cancel already cleared it)", () => {
  const i = bg.indexOf("chrome.tabs.onRemoved.addListener((tabId) => {");
  const body = bg.slice(i, i + 500);
  const getIdx = body.indexOf("getManualCaptureSession(tabId)");
  const clearIdx = body.indexOf("clearManualCaptureSession(tabId)");
  assert.ok(getIdx >= 0 && clearIdx >= 0 && getIdx < clearIdx, "the read must happen before the clear");
});
t("startManualCapture tries to find a tab the app already opened before creating its own, and has no timeout on the overlay wait", () => {
  const i = bg.indexOf("async function startManualCapture(req) {");
  assert.ok(i >= 0);
  const body = bg.slice(i, i + 1800);
  const findIdx = body.indexOf("findAppOpenedTab(req.url)");
  const createIdx = body.indexOf("chrome.tabs.create({ url: req.url, active: true })");
  assert.ok(findIdx >= 0 && createIdx >= 0 && findIdx < createIdx,
    "must look for an already-open tab (from the app's own openLink) before falling back to creating one");
  assert.ok(!/setTimeout.*regionSelect/i.test(body), "must not impose a timeout on the human-paced selection step");
});
t("findAppOpenedTab filters chrome.tabs.query({}) in JS by exact url match, not a chrome.tabs.query({url}) match pattern", () => {
  const i = bg.indexOf("async function findAppOpenedTab(url) {");
  assert.ok(i >= 0);
  const body = bg.slice(i, i + 500);
  assert.ok(/chrome\.tabs\.query\(\{\}\)/.test(body),
    "must query all tabs and filter in JS -- match patterns don't reliably handle querystrings/fragments in an article URL");
  assert.ok(/t\.url === url/.test(body));
});
t("startManualCapture tracks the session BEFORE injecting the overlay (no race where a fast user beats the session write)", () => {
  const i = bg.indexOf("async function startManualCapture(req) {");
  const body = bg.slice(i, i + 2400);
  const sessionIdx = body.indexOf("setManualCaptureSession(tab.id,");
  const injectIdx = body.indexOf("chrome.scripting.executeScript");
  assert.ok(sessionIdx >= 0 && injectIdx >= 0 && sessionIdx < injectIdx);
});

t("ensureContextMenu creates a pointToPointCapture item before the status label (so it isn't the last item)", () => {
  const start = bg.indexOf("async function ensureContextMenu() {");
  const end = bg.indexOf("ensureContextMenu();", start);
  const body = bg.slice(start, end);
  const itemIdx = body.indexOf('id: "pointToPointCapture"');
  const statusIdx = body.indexOf("id: CTX_STATUS_ID");
  assert.ok(itemIdx >= 0 && statusIdx >= 0 && itemIdx < statusIdx,
    "pointToPointCapture must be created before the status label, which must stay last");
});
t("the context-menu click handler starts a standalone session (no id) via the storage-backed helper and injects the overlay", () => {
  const start = bg.indexOf("chrome.contextMenus.onClicked.addListener((info, tab) => {");
  const body = bg.slice(start, start + 600);
  assert.ok(/info\.menuItemId === "pointToPointCapture"/.test(body));
  assert.ok(/await setManualCaptureSession\(tab\.id, \{ id: "", url: tab\.url \|\| "" \}\);/.test(body),
    "must use the chrome.storage.session-backed helper, not a plain in-memory map (MV3 suspension safety)");
  assert.ok(/catch \(e\) \{ await clearManualCaptureSession\(tab\.id\);/.test(body),
    "a failed overlay injection must clear the session via the same storage-backed helper");
});
t("pollCaptureRequest's req.manual branch skips the automatic pipeline (captureOneTab/persistPending) entirely", () => {
  const start = bg.indexOf("async function pollCaptureRequest() {");
  const end = bg.indexOf("\nasync function pollBatchState", start);
  const body = bg.slice(start, end);
  const manualIdx = body.indexOf("if (req.manual) {");
  assert.ok(manualIdx >= 0, "req.manual branch not found");
  assert.ok(manualIdx < body.indexOf("pendingCaptureBusy = true;"),
    "the manual branch must return BEFORE the automatic pipeline's persistPending/captureOneTab machinery runs");
  const manualBranch = body.slice(manualIdx, body.indexOf("return;", manualIdx) + 7);
  assert.ok(/await startManualCapture\(req\);/.test(manualBranch));
});
t("pollCaptureRequest is re-entrancy guarded (pollingCaptureRequest) so the 30s alarm and the tabs.onUpdated instant trigger can't both claim the same mailbox entry", () => {
  const start = bg.indexOf("async function pollCaptureRequest() {");
  assert.ok(start >= 0);
  const preamble = bg.slice(0, start);
  assert.ok(/let pollingCaptureRequest = false;/.test(preamble));
  const body = bg.slice(start, start + 200);
  assert.ok(/if \(pollingCaptureRequest\) return;/.test(body));
  assert.ok(/pollingCaptureRequest = true;/.test(body));
  const end = bg.indexOf("\n// Fire the poller the instant", start);
  assert.ok(end > start, "poller's closing block not found");
  const fullBody = bg.slice(start, end);
  assert.ok(/\} finally \{\s*pollingCaptureRequest = false;\s*\}/.test(fullBody),
    "the guard must be released in a finally so every return path (manual, watch-only, empty mailbox) clears it");
});
t("a tab landing on its real URL (changeInfo.url) triggers the capture poller immediately, instead of only the 30s alarm", () => {
  const i = bg.indexOf("chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {");
  assert.ok(i >= 0, "instant-trigger listener not found");
  const body = bg.slice(i, i + 200);
  assert.ok(/if \(changeInfo\.url\) pollCaptureRequest\(\)\.catch\(\(\) => \{\}\);/.test(body),
    "must gate on changeInfo.url specifically (fires once per real navigation), not fire on every onUpdated tick (title/favicon changes)");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
