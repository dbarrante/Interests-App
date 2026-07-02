// v1.8.0 Task 1 (review D5c): the MV3 service worker is the ONLY capture driver.
// The legacy page-context bridge (bridge.js + bridge-probe.js + the localhost
// content_scripts injection + background.js's defer-to-localhost-tab logic) was
// deleted. These source assertions lock the new invariants so the bridge layer
// cannot creep back: no APP_TAB_URLS/localhostTabOpen references remain, the two
// pollers drive UNCONDITIONALLY (no defer-on-tab branch), the manifest has no
// localhost content-script matches (but KEEPS the social-sites block), and the
// bridge files are absent. Plain-Node source-assertion style (same as
// tests/ext-matchkey.test.js).
//
// v1.8.0 Task 2 (review D5a) adds assertions locking the RETIREMENT of passive
// dead-link auto-removal: no webRequest permission, no chrome.webRequest /
// onErrorOccurred / reportDead / recentWatches / tabStatus machinery — while the
// pending-capture webNavigation.onCompleted flow and the popup's explicit
// "Remove card" action are asserted to survive.
const assert = require("assert");
const fs = require("fs"), path = require("path");

const extDir = path.join(__dirname, "..", "extension");
const bg = fs.readFileSync(path.join(extDir, "background.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }

// ---- bridge layer is gone -------------------------------------------------
t("extension/bridge.js is deleted", () => {
  assert.ok(!fs.existsSync(path.join(extDir, "bridge.js")), "bridge.js must not exist");
});
t("extension/bridge-probe.js is deleted", () => {
  assert.ok(!fs.existsSync(path.join(extDir, "bridge-probe.js")), "bridge-probe.js must not exist");
});
t("the bridge unit tests are deleted", () => {
  assert.ok(!fs.existsSync(path.join(__dirname, "bridge-stop.test.js")), "bridge-stop.test.js must not exist");
  assert.ok(!fs.existsSync(path.join(__dirname, "bridge-port.test.js")), "bridge-port.test.js must not exist");
});

// ---- background.js: no defer-to-localhost-tab machinery -------------------
t("no APP_TAB_URLS reference remains in background.js", () => {
  assert.ok(!/APP_TAB_URLS/.test(bg), "APP_TAB_URLS must be fully removed");
});
t("no localhostTabOpen reference remains in background.js", () => {
  assert.ok(!/localhostTabOpen/.test(bg), "localhostTabOpen must be fully removed");
});
t("background.js no longer forwards to bridge.js in comments/code", () => {
  // no defer/handoff to bridge.js should survive as a live guard
  assert.ok(!/deferring to bridge\.js/.test(bg), "no 'deferring to bridge.js' branch");
});

// ---- the pollers drive UNCONDITIONALLY (no defer-on-tab branch) -----------
function fnBody(src, decl, len) {
  const i = src.indexOf(decl);
  assert.ok(i >= 0, decl + " present");
  return src.slice(i, i + (len || 1400));
}
t("pollCaptureRequest has no defer-on-tab branch (drives unconditionally)", () => {
  const body = fnBody(bg, "async function pollCaptureRequest", 500);
  assert.ok(!/chrome\.tabs\.query\(\{\s*url:/.test(body),
    "pollCaptureRequest must not query for an app tab to defer to");
  assert.ok(!/APP_TAB_URLS|localhostTabOpen/.test(body), "no defer refs in pollCaptureRequest");
});
t("pollBatchState has no defer-on-tab branch (drives unconditionally)", () => {
  const body = fnBody(bg, "async function pollBatchState", 2400);
  assert.ok(!/chrome\.tabs\.query\(\{\s*url:/.test(body),
    "pollBatchState must not query for an app tab to defer to");
  assert.ok(!/APP_TAB_URLS|localhostTabOpen/.test(body), "no defer refs in pollBatchState");
  // the batch loop must still re-read state each item so the app's Stop halts it
  assert.ok(/const cur = await getState\(\)/.test(body), "batch loop must re-read state each item");
  assert.ok(/cur\.active === false \|\| cur\.cancel/.test(body), "batch loop must honor Stop (active:false/cancel)");
});

// ---- bridge-only message handlers are gone; kept ones survive ------------
t("bridge-only message handlers removed (captureRequest fwd, captureOneTab, cleanupBatch, getQueue, clearQueue)", () => {
  assert.ok(!/msg\.action === "captureRequest"/.test(bg), "captureRequest forwarding handler removed");
  assert.ok(!/msg\.action === "captureOneTab"/.test(bg), "captureOneTab message handler removed");
  assert.ok(!/msg\.action === "cleanupBatch"/.test(bg), "cleanupBatch handler removed");
  assert.ok(!/msg\.action === "getQueue"/.test(bg), "getQueue handler removed");
  assert.ok(!/msg\.action === "clearQueue"/.test(bg), "clearQueue handler removed");
});
t("popup-facing handlers survive (clipPage, removeCard, getStatus, clipSocialPost)", () => {
  assert.ok(/msg\.action === "clipPage"/.test(bg), "clipPage handler kept (popup)");
  assert.ok(/msg\.action === "removeCard"/.test(bg), "removeCard handler kept (popup)");
  assert.ok(/msg\.action === "getStatus"/.test(bg), "getStatus handler kept (popup)");
  assert.ok(/msg\.action === "clipSocialPost"/.test(bg), "clipSocialPost handler kept (capture-core.js)");
});
t("captureOneTab remains as an internal SW function the pollers call", () => {
  assert.ok(/async function captureOneTab\(/.test(bg), "captureOneTab function must remain (poller primitive)");
  assert.ok(/await captureOneTab\(/.test(bg), "the pollers must still call captureOneTab");
});

// ---- v1.7.0 additions that MUST survive ----------------------------------
t("v1.7.0 pending-flow additions survive (persistPending/restorePendingRequest/ia_pending_timeout/matchKey/unlimitedStorage)", () => {
  assert.ok(/async function persistPending\(/.test(bg), "persistPending survives");
  assert.ok(/async function restorePendingRequest\(/.test(bg), "restorePendingRequest survives");
  assert.ok(/PENDING_ALARM\s*=\s*["']ia_pending_timeout["']/.test(bg), "ia_pending_timeout alarm survives");
  assert.ok(/a\.name === PENDING_ALARM/.test(bg), "the pending-timeout alarm branch survives");
  assert.ok(/function matchKey\(/.test(bg), "matchKey survives");
  assert.ok(/notify\(\s*["']queue-full-/.test(bg), "queue-full notify survives");
  assert.ok(Array.isArray(manifest.permissions) && manifest.permissions.includes("unlimitedStorage"),
    "unlimitedStorage permission survives");
});

// ---- manifest: no localhost matches, social block kept -------------------
t("manifest has NO localhost content-script matches", () => {
  const all = JSON.stringify(manifest.content_scripts || []);
  assert.ok(!/localhost/.test(all), "no localhost match may remain");
  assert.ok(!/127\.0\.0\.1/.test(all), "no 127.0.0.1 match may remain");
  const loadsBridge = (manifest.content_scripts || []).some(
    (cs) => Array.isArray(cs.js) && (cs.js.includes("bridge.js") || cs.js.includes("bridge-probe.js")));
  assert.ok(!loadsBridge, "no content script may load bridge.js/bridge-probe.js");
});
t("manifest KEEPS the social-sites content_scripts block", () => {
  const social = (manifest.content_scripts || []).find(
    (cs) => Array.isArray(cs.js) && cs.js.includes("capture-core.js"));
  assert.ok(social, "the social-sites capture content script must remain");
  const m = JSON.stringify(social.matches);
  assert.ok(/facebook\.com/.test(m) && /instagram\.com/.test(m) && /pinterest/.test(m) && /youtube\.com/.test(m),
    "social matches (facebook/instagram/pinterest/youtube) must remain");
  assert.deepStrictEqual(social.js, ["yt-save-trigger.js", "capture-configs.js", "capture-core.js"],
    "the social content-script js list is unchanged");
});

// ---- Task 2 (review D5a): passive dead-link auto-removal retired -----------
// The extension no longer DELETES cards from ordinary browsing. The webRequest
// 404/410 listener and the webNavigation.onErrorOccurred hard-error path (which
// fed reportDead's auto-remove delivery) are gone, and the webRequest permission
// was dropped with them. Dead links are found ONLY by the app's review-based
// "Check links" sweep (core/linkcheck.js). The popup's explicit "Remove card"
// action and the pending-capture onCompleted flow are unaffected.
t("manifest has NO webRequest permission", () => {
  assert.ok(Array.isArray(manifest.permissions), "permissions array present");
  assert.ok(!manifest.permissions.includes("webRequest"), "webRequest permission must be removed");
});
t("manifest KEEPS the permissions the extension still needs", () => {
  for (const p of ["scripting", "tabs", "storage", "unlimitedStorage", "notifications", "webNavigation", "contextMenus", "alarms"]) {
    assert.ok(manifest.permissions.includes(p), p + " permission must survive");
  }
});
t("background.js has NO chrome.webRequest reference", () => {
  assert.ok(!/chrome\.webRequest/.test(bg), "no chrome.webRequest listener may remain");
});
t("background.js has NO webNavigation.onErrorOccurred auto-remove path", () => {
  assert.ok(!/onErrorOccurred/.test(bg), "the onErrorOccurred hard-error auto-remove path must be gone");
});
t("the auto-dead-removal machinery (reportDead / recentWatches / HARD_ERR / tabStatus) is gone", () => {
  assert.ok(!/function reportDead\b/.test(bg), "reportDead function removed");
  assert.ok(!/\breportDead\s*\(/.test(bg), "no reportDead calls remain");
  assert.ok(!/\brecentWatches\b/.test(bg), "recentWatches tracking removed (only auto-removal consumed it)");
  assert.ok(!/\bHARD_ERR\b/.test(bg), "HARD_ERR regex removed");
  assert.ok(!/\btabStatus\b/.test(bg), "tabStatus (fed only by the webRequest listener) removed");
});
t("webNavigation.onCompleted listener SURVIVES (pending-capture flow)", () => {
  assert.ok(/chrome\.webNavigation\.onCompleted\.addListener/.test(bg),
    "webNavigation.onCompleted must remain — the pending-capture flow depends on it");
});
t("popup 'removeCard' handler + deliverDead SURVIVE (explicit user removal)", () => {
  assert.ok(/msg\.action === "removeCard"/.test(bg), "removeCard handler kept (popup explicit removal)");
  assert.ok(/async function deliverDead\(/.test(bg), "deliverDead kept (used by removeCard)");
  assert.ok(/removeActive:\s*true/.test(bg), "removeCard still delivers removeActive:true");
});

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
