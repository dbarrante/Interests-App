// Task 11 (review B13): background.js must have a query-PRESERVING URL key,
// matchKey, used where identity must distinguish ?v=-style URLs (YouTube).
// normalizeUrl() strips the query string, so ?v=AAA and ?v=BBB collapse to the
// same key — that's the exact class of bug the repo's own FB retrospective
// documents ("clipKey not normalizeUrl"). matchKey keeps the query (drops only
// the hash, lowercases host, strips www., trailing-slash-normalizes the path).
//
// matchKey is a top-level function in background.js (a browser SW that references
// chrome/self, so it can't be require()'d). Extract it by name and eval it —
// the same source-extraction pattern tests/_extract.js uses for index.html.
const assert = require("assert");
const fs = require("fs"), path = require("path");

const bg = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");

// brace-balance extraction of a top-level `function NAME(...) { ... }`
function extractFn(src, name) {
  const declRe = new RegExp("(?:^|\\n)(function " + name + "\\b[^{]*)\\{", "m");
  const dm = declRe.exec(src);
  if (!dm) return null;
  const openBrace = dm.index + dm[0].length - 1;
  let depth = 0, inStr = null, i = openBrace;
  while (i < src.length) {
    const ch = src[i];
    if (inStr) {
      if (ch === "\\" && inStr !== "`") { i += 2; continue; }
      if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; }
    else if (ch === "/" && src[i + 1] === "/") { const nl = src.indexOf("\n", i); i = nl < 0 ? src.length : nl + 1; continue; }
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { const start = dm.index + (dm[0][0] === "\n" ? 1 : 0); return src.slice(start, i + 1); } }
    i++;
  }
  return null;
}

const matchKeySrc = extractFn(bg, "matchKey");
assert.ok(matchKeySrc, "matchKey must be defined in extension/background.js");
const matchKey = eval("(" + matchKeySrc + ")");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }

t("matchKey distinguishes query-keyed URLs (?v=AAA vs ?v=BBB)", () => {
  assert.notStrictEqual(
    matchKey("https://www.youtube.com/watch?v=AAA"),
    matchKey("https://www.youtube.com/watch?v=BBB"),
    "different ?v= videos must NOT share a key (that's the collision bug)");
});

t("matchKey ignores the hash but keeps the query", () => {
  assert.strictEqual(
    matchKey("https://youtube.com/watch?v=AAA#t=1"),
    matchKey("https://www.youtube.com/watch?v=AAA"),
    "hash-only difference (and www.) must collapse to the same key");
});

t("matchKey strips www.", () => {
  assert.strictEqual(
    matchKey("https://www.example.com/page?q=1"),
    matchKey("https://example.com/page?q=1"));
});

t("matchKey trailing-slash-normalizes the path", () => {
  assert.strictEqual(
    matchKey("https://example.com/page/?q=1"),
    matchKey("https://example.com/page?q=1"),
    "a trailing slash on the path must not change the key");
});

t("matchKey is idempotent (matchKey(url) === matchKey(url))", () => {
  const u = "https://www.youtube.com/watch?v=AAA&list=PL1#frag";
  assert.strictEqual(matchKey(u), matchKey(u));
});

t("matchKey lowercases the host but the query still separates videos", () => {
  // sanity: two real, different watch URLs stay distinct
  assert.notStrictEqual(
    matchKey("https://YouTube.com/watch?v=dQw4w9WgXcQ"),
    matchKey("https://youtube.com/watch?v=oHg5SJYRHA0"));
});

// ---- source assertions: the four call sites actually use matchKey ----------
// (same source-assertion pattern as tests/bridge-stop.test.js in Task 10)

t("offline-queue dedupe uses matchKey (site 1)", () => {
  assert.ok(/q\.filter\(\(c\)\s*=>\s*matchKey\(c\.url\)\s*!==\s*matchKey\(capture\.url\)\)/.test(bg),
    "the queue dedupe filter must key on matchKey, not normalizeUrl");
});

t("URL-matched pending-tab machinery is retired (former sites 2+3, review E / B12 completion)", () => {
  // v1.8.0 review E: handleCaptureRequest (the original URL-matched claim path) was
  // dead code (superseded by the captureOneTab poller in ffdfb70) and was removed;
  // the B12 completion then rewired the suspension persistence onto the real path,
  // where a restored claim RE-DISPATCHES through captureOneTab (which tracks its own
  // tab by TAB IDENTITY, redirect-safe) instead of URL-matching an existing tab. So
  // former matchKey sites 2 (already-loaded tab race) and 3 (onCompleted pending
  // match) are gone by design; matchKey's remaining caller is the queue dedupe.
  assert.ok(!/async function handleCaptureRequest\(/.test(bg), "handleCaptureRequest removed (dead code, review E)");
  assert.ok(!/\bfinishPending\b/.test(bg), "finishPending removed (only served the URL-matched flow)");
  assert.ok(!/matchKey\(t\.url\)/.test(bg), "no already-loaded tab URL-match remains");
  assert.ok(!/matchKey\(details\.url\)/.test(bg), "onCompleted no longer URL-matches a pending request");
  // onCompleted still settles captureOneTab's in-flight tabs by tab identity
  const oc = bg.indexOf("chrome.webNavigation.onCompleted.addListener");
  assert.ok(oc >= 0, "onCompleted listener survives");
  assert.ok(bg.slice(oc, oc + 600).indexOf("capturePending(details.tabId)") >= 0,
    "onCompleted settles in-flight capture tabs by tab identity");
});

// v1.8.0 Task 2 (review D5a): reportDead (former matchKey "site 4") was retired with
// the passive dead-link auto-removal path — it and its recentWatches store are gone.
t("reportDead + recentWatches are retired (passive dead-link auto-removal removed)", () => {
  assert.ok(bg.indexOf("async function reportDead(") < 0, "reportDead must be removed");
  assert.ok(!/\brecentWatches\b/.test(bg), "recentWatches must be removed");
});

t("normalizeUrl still exists (untouched for its FB callers)", () => {
  assert.ok(/function normalizeUrl\(url\)/.test(bg), "normalizeUrl must remain defined");
});

// ---- B11: manifest + surfaced queue failure -------------------------------
t("manifest declares unlimitedStorage (B11)", () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "extension", "manifest.json"), "utf8"));
  assert.ok(Array.isArray(m.permissions) && m.permissions.includes("unlimitedStorage"),
    "manifest permissions must include unlimitedStorage");
});

t("queue-write failure is surfaced (console.warn + user notification), not swallowed (B11)", () => {
  const di = bg.indexOf("async function deliverToApp(");
  const end = bg.indexOf("async function fetchAsDataUrl(");   // deliverToApp ends just before this
  assert.ok(di >= 0 && end > di, "deliverToApp block bounded");
  const body = bg.slice(di, end);
  assert.ok(/console\.warn\(/.test(body), "queue-write catch must console.warn the failure");
  // the user-facing notification goes through the notify() helper, which builds
  // the iconUrl via chrome.runtime.getURL (a relative path is unreliable in an
  // MV3 service worker) and swallows chrome's async icon-download rejection
  assert.ok(/notify\(\s*["']queue-full-/.test(body), "queue-write catch must notify the user via notify()");
  assert.ok(/storage full/i.test(body), "the notification must mention storage being full");
  assert.ok(/chrome\.runtime\.getURL\(/.test(bg.slice(bg.indexOf("function notify("), bg.indexOf("function notify(") + 500)),
    "notify() must resolve its icon via chrome.runtime.getURL");
  // no raw create call with a relative icon path anywhere in deliverToApp
  assert.ok(!/iconUrl:\s*["']icon\d+\.png["']/.test(body), "no relative iconUrl in deliverToApp");
  // the old silent empty catch on the queue set() must be gone
  assert.ok(!/set\(\{ ia_capture_queue: q \}\);\s*\n\s*log\([^)]*\);\s*\n\s*\} catch \(e\) \{\}/.test(body),
    "the queue-write catch must not be an empty {}");
});

t("pending-claim persist failure is warned, not swallowed (review follow-up)", () => {
  const i = bg.indexOf("async function persistPending(");
  assert.ok(i >= 0, "persistPending present");
  const body = bg.slice(i, i + 400);
  assert.ok(/catch \(e\) \{ console\.warn\(/.test(body),
    "persistPending's catch must console.warn the failed storage.session.set");
});

// ---- B12: pending request persisted across SW suspension -------------------
t("pending single-capture request is persisted to storage.session (B12)", () => {
  assert.ok(/PENDING_KEY\s*=\s*["']ia_pending_request["']/.test(bg), "ia_pending_request key defined");
  assert.ok(/chrome\.storage\.session\.set\(\{\s*\[PENDING_KEY\]:/.test(bg),
    "claiming a request must persist the pending request to storage.session");
  assert.ok(/chrome\.storage\.session\.remove\(PENDING_KEY\)/.test(bg),
    "completion/timeout must remove the persisted pending request");
  // v1.8.0 B12 completion: the persistence is wired to the REAL claim path — the
  // SW poller (pollCaptureRequest) persists right after claiming and clears once
  // captureOneTab returns. (Its original caller, handleCaptureRequest, was dead
  // code removed in review E; until this fix persistPending had no live caller.)
  assert.ok(!/async function handleCaptureRequest\(/.test(bg), "handleCaptureRequest removed (dead code, review E)");
  const pi = bg.indexOf("async function pollCaptureRequest(");
  assert.ok(pi >= 0, "pollCaptureRequest present");
  const pBody = bg.slice(pi, bg.indexOf("\n}", pi) + 2);
  const iClaim = pBody.indexOf("request: null");             // the claim POST
  const iWatch = pBody.indexOf("req.capture === false");     // watch-only early return
  const iPersist = pBody.indexOf("await persistPending(");
  const iDispatch = pBody.indexOf("await captureOneTab(");
  const iClear = pBody.indexOf("clearPendingPersist()");
  assert.ok(iPersist >= 0, "the poller persists the claim (B12 on the real path)");
  assert.ok(iClear >= 0, "the poller clears the persisted claim after dispatch");
  assert.ok(iClaim >= 0 && iClaim < iPersist, "persist happens AFTER the claim POST");
  assert.ok(iWatch >= 0 && iWatch < iPersist, "watch-only requests return BEFORE persisting");
  assert.ok(iPersist < iDispatch && iDispatch < iClear, "order: persist -> dispatch -> clear");
});

t("pending timeout uses a chrome.alarms alarm, not only setTimeout (B12)", () => {
  assert.ok(/PENDING_ALARM\s*=\s*["']ia_pending_timeout["']/.test(bg), "ia_pending_timeout alarm name defined");
  assert.ok(/chrome\.alarms\.create\(\s*PENDING_ALARM\s*,\s*\{\s*delayInMinutes:\s*1\s*\}\)/.test(bg),
    "the pending timeout must be armed as a 1-minute alarm so it survives SW suspension");
  assert.ok(/a\.name === PENDING_ALARM/.test(bg),
    "onAlarm must handle the PENDING_ALARM branch");
  // the alarm branch must not disturb the existing batch-poll branch
  assert.ok(/a\.name === ["']iaCapturePoll["']\) iaPollAll\(\)/.test(bg),
    "the iaCapturePoll batch-poll branch must remain intact");
});

t("SW init restores a fresh pending request and marks a stale one attempted (B12)", () => {
  assert.ok(/async function restorePendingRequest\(/.test(bg), "restorePendingRequest defined");
  const i = bg.indexOf("async function restorePendingRequest(");
  const body = bg.slice(i, i + 2400);
  assert.ok(/PENDING_MAX_AGE_MS/.test(bg) && /age < PENDING_MAX_AGE_MS/.test(body),
    "restore must gate on a freshness window (PENDING_MAX_AGE_MS)");
  assert.ok(/attempt: true, ok: false/.test(body), "a stale restore must mark the card attempted");
  // B12 completion: a FRESH restore re-dispatches through captureOneTab (the same
  // redirect-safe primitive the poller uses), never the deleted URL-matched flow,
  // and clears the persisted claim once the dispatch returns.
  assert.ok(/captureOneTab\(req\.url,\s*req\.id\s*\|\|\s*""\s*,\s*\(req\.delay\s*\|\|\s*0\)\s*,\s*!!req\.render,\s*!!req\.force\)/.test(body),
    "a fresh restore must re-dispatch via captureOneTab with the claim's render+force");
  assert.ok(body.indexOf("clearPendingPersist()") >= 0, "restore clears the persisted claim");
  assert.ok(/pendingCaptureBusy/.test(body), "restore is guarded so it never double-dispatches a live claim");
  // v1.8.0 review E: the standalone onStartup(() => restorePendingRequest()) listener
  // was consolidated into onExtensionInit() (also runs ensureContextMenu, flushQueue,
  // iaPollAll), which is registered on both onInstalled and onStartup.
  const oi = bg.indexOf("function onExtensionInit()");
  assert.ok(oi >= 0, "onExtensionInit defined");
  const oiBody = bg.slice(oi, bg.indexOf("\n}", oi) + 2);
  assert.ok(oiBody.indexOf("restorePendingRequest()") >= 0, "onExtensionInit runs restorePendingRequest");
  assert.ok(bg.indexOf("chrome.runtime.onStartup.addListener(onExtensionInit)") >= 0,
    "restore (via onExtensionInit) must run on SW startup");
  assert.ok(bg.indexOf("chrome.runtime.onInstalled.addListener(onExtensionInit)") >= 0,
    "restore (via onExtensionInit) must also run on install");
});

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
