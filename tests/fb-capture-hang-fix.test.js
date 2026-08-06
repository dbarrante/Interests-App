// 2026-08-05: reported "the extension keeps saying 'Capturing Facebook' but never
// captures — the page opens to the article [and just sits there]". Root cause: two
// unbounded operations in the FB auto-capture pipeline, either of which can hang the
// whole flow forever with no error surfaced anywhere.
//
// 1. extension/capture-core.js's autoCaptureFB polling loop (the automated
//    equivalent of the manual right-click "Save to Interests" flow) calls several
//    synchronous DOM probes — dialogPostPresent(), onHomeFeed(), findMainPost(),
//    isUnavailable(), metaPhoto() — with NO try/catch around them, unlike every
//    branch below them (which already wrap their own sendResponse calls). If any of
//    those probes throws on some page's specific DOM shape, the loop's current tick
//    dies silently: no further 250ms ticks get scheduled, sendResponse is never
//    called, and the message channel is left open forever.
// 2. extension/background.js's captureFbPost awaits chrome.tabs.sendMessage(...)
//    with no timeout at all. If the in-page loop never responds (bug #1, or any
//    other reason — tab killed mid-navigation, extension context invalidated),
//    the await just hangs indefinitely. Worse, this call sits inside
//    renderCaptureFb's try block, so its finally (which resets the fbRenderBusy
//    single-flight guard) never runs either — every capture after the first stuck
//    one silently no-ops as "busy" until the extension is reloaded.
//
// Fix: (1) wrap the loop's synchronous body in try/catch, always falling back to a
// safe "no image" response so the message channel can never be left open; (2) bound
// the chrome.tabs.sendMessage await with the same Promise.race timeout pattern
// already used elsewhere in this file (lockedCaptureVisible), so even a response
// that never arrives for some other reason can't hang the pipeline.
//
// A same-day security review of that first version found 2 real defects in it,
// fixed here and locked in by the tests below:
// - F1 (HIGH): the loop's gates compared a synthetic tick counter (`waited += 250`
//   per tick) against millisecond budgets, silently assuming every tick takes
//   ~250ms of REAL time. Under Chromium's ~1/s timer clamp for a backgrounded/
//   hidden tab, ticks slow down but the counter still advances the same amount per
//   tick — so a loop that's genuinely healthy but running in a backgrounded tab
//   could take ~75s of real time while still reading as "waited=18000", well past
//   background.js's AUTO_CAPTURE_MSG_TIMEOUT_MS (22000ms real time) — abandoning a
//   capture that would have succeeded. Fixed by gating on real elapsed time
//   (Date.now() - t0) instead of a tick count.
// - F2 (MEDIUM): the safety-net catch was terminal — ANY thrown exception, even a
//   one-off transient hiccup on tick 1, ended the whole capture immediately with
//   the empty-result fallback. Since the dead-post gate (isUnavailable) is time-
//   gated to only fire after elapsed() >= 1200, a throw on an earlier tick could
//   skip past ever checking it — silently missing a genuinely deleted post that a
//   later tick would have caught, and falling through to captureFbByOg (no
//   deletion check). Fixed: the catch now reschedules the next tick (like a normal
//   miss) as long as time remains, only falling back to the terminal response once
//   MAX_WAIT is genuinely exhausted — a response is still always eventually sent.
// Plain source-assertion style (same as tests/ext-sw-driver.test.js) — no chrome.*
// mock harness exists for this extension.
const assert = require("assert");
const fs = require("fs"), path = require("path");

const extDir = path.join(__dirname, "..", "extension");
const bg = fs.readFileSync(path.join(extDir, "background.js"), "utf8");
const core = fs.readFileSync(path.join(extDir, "capture-core.js"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }

// capture-core.js defines TWO `(function loop() {` IIFEs (a different one, for the
// hover-preview capture flow, comes first) — anchor on the autoCaptureFB handler so
// we inspect the right one.
const autoCaptureAnchor = core.indexOf('if (!msg || msg.action !== "autoCaptureFB") return;');

t("capture-core.js: the autoCaptureFB polling loop's body is wrapped in try/catch", () => {
  assert.ok(autoCaptureAnchor >= 0, "autoCaptureFB handler not found");
  const start = core.indexOf("(function loop() {", autoCaptureAnchor);
  assert.ok(start >= 0, "the autoCaptureFB loop IIFE not found");
  const closeIdx = core.indexOf("})();", start);
  assert.ok(closeIdx > 0, "loop IIFE close not found");
  const loopSrc = core.slice(start, closeIdx);
  assert.ok(/^\(function loop\(\) \{\r?\n\s*try \{/.test(loopSrc), "loop() body must open with try { immediately");
  assert.ok(/\} catch \(e\) \{[\s\S]*sendResponse\(/.test(loopSrc), "the catch block must still call sendResponse — this is what stops the channel being left open forever");
});

t("capture-core.js: the catch fallback responds ok:true with an empty image (never throws, never re-hangs)", () => {
  // there are several inner `} catch (e) {` blocks already inside the loop (each
  // guarding its own sendResponse call) — anchor on this fix's own comment to find
  // the specific OUTER catch added around the whole loop body, not one of those.
  const catchIdx = core.indexOf("loop threw repeatedly, giving up", autoCaptureAnchor);
  assert.ok(catchIdx >= 0, "the documented terminal-giveup log line not found");
  const catchBody = core.slice(catchIdx, catchIdx + 400);
  assert.ok(/try \{ sendResponse\(\{ ok: true, image: "", rect: null/.test(catchBody), "catch fallback must send a safe ok:true/empty-image response");
});

// F1 regression: the loop's timing gates must be wall-clock based, not a synthetic
// tick counter, or a throttled/backgrounded tab can silently blow the real-time
// budget while `waited` still reads as within it (see header comment).
t("capture-core.js: the loop's gates use real elapsed time (Date.now()-based), not a synthetic tick counter", () => {
  const start = core.indexOf("(function loop() {", autoCaptureAnchor);
  const closeIdx = core.indexOf("})();", start);
  assert.ok(start >= 0 && closeIdx > start, "autoCaptureFB loop not found");
  const preamble = core.slice(autoCaptureAnchor, start);
  assert.ok(/const t0 = Date\.now\(\);/.test(preamble), "a real wall-clock start timestamp (t0) must be captured before the loop starts");
  assert.ok(/const elapsed = \(\) => Date\.now\(\) - t0;/.test(preamble), "an elapsed() helper must compute real elapsed time from t0");
  const loopSrc = core.slice(start, closeIdx);
  assert.ok(!/\bwaited\b/.test(loopSrc), "no tick-counter variable ('waited') may remain inside the loop — every gate must use elapsed()");
  assert.ok(/elapsed\(\) >= 3000/.test(loopSrc), "the home-feed gate must use elapsed(), not a tick count");
  assert.ok(/elapsed\(\) >= 1200/.test(loopSrc), "the dead-post detection gate must use elapsed(), not a tick count");
  assert.ok(/elapsed\(\) >= MAX_WAIT/.test(loopSrc), "the give-up gate must use elapsed(), not a tick count");
});

// F2 regression: a transient throw on an early tick must not terminate the whole
// capture — it must reschedule like a normal miss, so the time-gated dead-post
// check (elapsed() >= 1200) still gets its chance on a later tick. Only once
// MAX_WAIT is genuinely exhausted should the catch fall through to the terminal
// empty-result response.
t("capture-core.js: a transient throw reschedules the next tick instead of ending the capture immediately", () => {
  const start = core.indexOf("(function loop() {", autoCaptureAnchor);
  const closeIdx = core.indexOf("})();", start);
  const loopSrc = core.slice(start, closeIdx);
  const catchStart = loopSrc.indexOf("} catch (e) {");
  assert.ok(catchStart >= 0, "the outer catch block not found");
  const catchSrc = loopSrc.slice(catchStart);
  const rescheduleIdx = catchSrc.indexOf("if (elapsed() < MAX_WAIT)");
  const giveupIdx = catchSrc.indexOf("loop threw repeatedly, giving up");
  assert.ok(rescheduleIdx >= 0, "the catch must check elapsed() < MAX_WAIT before giving up");
  assert.ok(giveupIdx > rescheduleIdx, "the reschedule check must come BEFORE the terminal give-up response, not after");
  const rescheduleBranch = catchSrc.slice(rescheduleIdx, giveupIdx);
  assert.ok(/setTimeout\(loop, 250\); return;/.test(rescheduleBranch), "while time remains, the catch must reschedule the next tick and return — not fall through to give up");
});

t("background.js: AUTO_CAPTURE_MSG_TIMEOUT_MS is defined and used to bound chrome.tabs.sendMessage(autoCaptureFB)", () => {
  assert.ok(/const AUTO_CAPTURE_MSG_TIMEOUT_MS = \d+;/.test(bg), "AUTO_CAPTURE_MSG_TIMEOUT_MS constant not found");
  const start = bg.indexOf("async function captureFbPost(tab, cardUrl, delayMs, cardId, suppressFail) {");
  assert.ok(start >= 0, "captureFbPost not found");
  const body = bg.slice(start, start + 2600);
  assert.ok(/Promise\.race\(\[\s*chrome\.tabs\.sendMessage\(tabId, \{ action: "autoCaptureFB" \}\)/.test(body),
    "the sendMessage call must be raced against a timeout, matching the lockedCaptureVisible pattern used elsewhere in this file");
  assert.ok(/raceTimer = setTimeout\(\(\) => rej\(new Error\("autoCaptureFB response timeout"\)\), AUTO_CAPTURE_MSG_TIMEOUT_MS\)/.test(body),
    "the timeout branch must reject (not resolve) so the existing catch(e){info=null} handling below still applies unchanged");
});

t("background.js: the message timeout still lets the existing retry/failure handling run (info stays reachable, no new early return)", () => {
  const start = bg.indexOf("async function captureFbPost(tab, cardUrl, delayMs, cardId, suppressFail) {");
  const body = bg.slice(start, start + 2600);
  // the retry loop and its existing catch must still be present and unchanged in shape
  assert.ok(/for \(let attempt = 0; attempt < 2 && !\(info && \(info\.ok \|\| info\.dead\)\); attempt\+\+\) \{/.test(body),
    "the 2-attempt retry loop must be unchanged");
  assert.ok(/catch \(e\) \{ log\("autoCaptureFB message failed \(try " \+ \(attempt \+ 1\) \+ "\): " \+ e\.message\); info = null; \}/.test(body),
    "a timed-out attempt must fall through the existing catch, same as any other sendMessage failure");
});

// F3 regression: the losing side of the Promise.race (whichever one doesn't decide
// the race) must not stay armed — an uncleared timer fires a rejection into an
// already-settled race on every attempt that resolves normally.
t("background.js: the race's timeout timer is cleared once the race settles, win or lose", () => {
  const start = bg.indexOf("async function captureFbPost(tab, cardUrl, delayMs, cardId, suppressFail) {");
  const body = bg.slice(start, start + 2600);
  assert.ok(/let raceTimer;/.test(body), "raceTimer must be declared so it can be cleared after the race settles");
  assert.ok(/finally \{ clearTimeout\(raceTimer\); \}/.test(body), "the race's timer must be cleared in a finally, regardless of which side won");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
