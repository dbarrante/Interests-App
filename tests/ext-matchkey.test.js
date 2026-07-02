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

t("single-capture pending-tab match uses matchKey (site 2)", () => {
  // the already-loaded race in handleCaptureRequest matches an open tab to req.url
  assert.ok(/matchKey\(t\.url\)\s*===\s*matchKey\(req\.url\)/.test(bg),
    "the already-loaded pending-tab match must use matchKey(t.url) === matchKey(req.url)");
});

t("webNavigation.onCompleted navigation match uses matchKey (site 3)", () => {
  assert.ok(/matchKey\(details\.url\)\s*!==\s*matchKey\(pendingRequest\.url\)/.test(bg),
    "onCompleted must match the pending request by matchKey");
});

t("reportDead recentWatches match uses matchKey (site 4)", () => {
  const i = bg.indexOf("async function reportDead(");
  assert.ok(i >= 0, "reportDead present");
  const body = bg.slice(i, i + 400);
  assert.ok(/recentWatches\.find\(w\s*=>\s*matchKey\(w\.url\)\s*===\s*matchKey\(url\)\)/.test(body),
    "reportDead must find the recent watch by matchKey");
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

t("queue-write failure is surfaced (console.warn + notifications.create), not swallowed (B11)", () => {
  const di = bg.indexOf("async function deliverToApp(");
  const end = bg.indexOf("async function fetchAsDataUrl(");   // deliverToApp ends just before this
  assert.ok(di >= 0 && end > di, "deliverToApp block bounded");
  const body = bg.slice(di, end);
  assert.ok(/console\.warn\(/.test(body), "queue-write catch must console.warn the failure");
  assert.ok(/chrome\.notifications\.create\(/.test(body), "queue-write catch must notify the user");
  assert.ok(/storage full/i.test(body), "the notification must mention storage being full");
  // the old silent empty catch on the queue set() must be gone
  assert.ok(!/set\(\{ ia_capture_queue: q \}\);\s*\n\s*log\([^)]*\);\s*\n\s*\} catch \(e\) \{\}/.test(body),
    "the queue-write catch must not be an empty {}");
});

// ---- B12: pending request persisted across SW suspension -------------------
t("pending single-capture request is persisted to storage.session (B12)", () => {
  assert.ok(/PENDING_KEY\s*=\s*["']ia_pending_request["']/.test(bg), "ia_pending_request key defined");
  assert.ok(/chrome\.storage\.session\.set\(\{\s*\[PENDING_KEY\]:/.test(bg),
    "claiming a request must persist the pending request to storage.session");
  assert.ok(/chrome\.storage\.session\.remove\(PENDING_KEY\)/.test(bg),
    "completion/timeout must remove the persisted pending request");
  // the claim path must actually call persistPending
  assert.ok(/pendingRequest = \{[^}]*\};\s*[\s\S]{0,120}persistPending\(pendingRequest\)/.test(bg),
    "handleCaptureRequest must persistPending right after claiming");
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
  assert.ok(/chrome\.runtime\.onStartup\.addListener\(\(\) => \{ restorePendingRequest\(\)/.test(bg),
    "restore must run on SW startup");
});

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
