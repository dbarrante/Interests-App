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
  assert.ok(/const MANUAL_CAPTURE_KEY = /.test(bg));
  assert.ok(/chrome\.storage\.session\.get\(MANUAL_CAPTURE_KEY\)/.test(bg));
  assert.ok(/chrome\.storage\.session\.set\(\{ \[MANUAL_CAPTURE_KEY\]: all \}\)/.test(bg));
  assert.ok(!/let manualCaptureSessions = \{\};/.test(bg), "must not fall back to a plain in-memory map");
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
  const body = bg.slice(i, i + 700);
  assert.ok(/deliverToApp\(\{ url: session\.url, id: session\.id \|\| "", screenshot: session\.dataUrl, force: true/.test(body),
    "must NOT set clip:true -- that would always route to a new Saved item and never match an existing Imported card by id/url");
  assert.ok(!/clip:\s*true/.test(body), "regionSelectFinalize's delivery must never set clip:true");
});
t("regionSelectCancel only notifies the app for an app-triggered session (has an id), not a standalone one", () => {
  const i = bg.indexOf('msg.action === "regionSelectCancel"');
  assert.ok(i >= 0);
  const body = bg.slice(i, i + 700);
  assert.ok(/if \(session\.id\) await deliverToApp/.test(body));
});
t("chrome.tabs.onRemoved clears a leaked manual-capture session if the user closes the tab directly", () => {
  assert.ok(/chrome\.tabs\.onRemoved\.addListener\(\(tabId\) => \{ clearManualCaptureSession\(tabId\)/.test(bg));
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
