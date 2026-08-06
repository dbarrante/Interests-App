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
  const body = bg.slice(i, i + 900);
  assert.ok(/deliverToApp\(\{/.test(body) && /url: session\.url, id: session\.id \|\| ""/.test(body));
  assert.ok(/screenshot: session\.dataUrl/.test(body));
  assert.ok(/force: true/.test(body));
  assert.ok(!/clip:\s*true/.test(body), "regionSelectFinalize's delivery must never set clip:true -- that would always route to a new Saved item and never match an existing Imported card by id/url");
});
t("regionSelectFinalize's delivery carries the tab's real page title (not the domain-only addClip fallback)", () => {
  const i = bg.indexOf('msg.action === "regionSelectFinalize"');
  const body = bg.slice(i, i + 1300);
  assert.ok(/title: \(sender\.tab && sender\.tab\.title\) \|\| ""/.test(body),
    "a standalone capture of a brand-new URL must not permanently name the card just its bare domain");
});
t("regionSelectFinalize only closes the tab it owns (app-triggered), never the user's own standalone browsing tab", () => {
  const i = bg.indexOf('msg.action === "regionSelectFinalize"');
  const body = bg.slice(i, i + 1300);
  assert.ok(/if \(session\.owned\) \{ try \{ await chrome\.tabs\.remove\(tab\.id\); \} catch \(e\) \{\} \}/.test(body),
    "chrome.tabs.remove must be gated on session.owned so a standalone capture never closes the user's own tab");
});
t("only startManualCapture's app-triggered session sets owned:true; the standalone context-menu session does not", () => {
  const startIdx = bg.indexOf("async function startManualCapture(req) {");
  const startBody = bg.slice(startIdx, startIdx + 1200);
  assert.ok(/setManualCaptureSession\(tab\.id, \{ id: req\.id \|\| "", url: req\.url, owned: true \}\)/.test(startBody));

  const ctxIdx = bg.indexOf('info.menuItemId === "pointToPointCapture"');
  const ctxBody = bg.slice(ctxIdx, ctxIdx + 400);
  assert.ok(/setManualCaptureSession\(tab\.id, \{ id: "", url: tab\.url \|\| "" \}\)/.test(ctxBody),
    "the standalone context-menu session must NOT set owned:true");
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
t("startManualCapture opens its own tab (does not try to find an existing one) and has no timeout on the overlay wait", () => {
  const i = bg.indexOf("async function startManualCapture(req) {");
  assert.ok(i >= 0);
  const body = bg.slice(i, i + 1200);
  assert.ok(/chrome\.tabs\.create\(\{ url: req\.url, active: true \}\)/.test(body));
  assert.ok(!/setTimeout.*regionSelect/i.test(body), "must not impose a timeout on the human-paced selection step");
});
t("startManualCapture tracks the session BEFORE injecting the overlay (no race where a fast user beats the session write)", () => {
  const i = bg.indexOf("async function startManualCapture(req) {");
  const body = bg.slice(i, i + 1200);
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
