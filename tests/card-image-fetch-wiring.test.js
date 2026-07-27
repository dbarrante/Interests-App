// tests/card-image-fetch-wiring.test.js — the client must not browser-fetch a
// remote card image (CORS refuses it; the pipeline then silently produced no
// title, which is why Pinterest cards sat at "(untitled)").
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + e.message); } }
function body(src, name) {
  const m = new RegExp("async function " + name + "\\(card\\)\\{([\\s\\S]*?)\\n\\}").exec(src);
  assert.ok(m, name + " not found");
  return m[1];
}

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": remote images do NOT go through a direct browser fetch of the image URL", () => {
    const b = body(src, "resolveCardImageForAI");
    // fetch(srcUrl) legitimately remains for the idb:-backed (same-origin) branch —
    // banning that substring outright would also reject a CORRECT fix, since that
    // branch is untouched by this task (pinned separately below). The actual bug
    // was assigning the REMOTE img URL into srcUrl at all, which let that same
    // fetch(srcUrl) call reach a cross-origin URL and get CORS-refused.
    assert.doesNotMatch(b, /srcUrl\s*=\s*img\s*;/,
      "srcUrl must never be set to the remote img URL directly — a subsequent fetch(srcUrl) on a cross-origin image is refused by CORS, which was the bug");
  });
  t(label + ": the http(s) branch requests bytes by CARD ID, not by URL", () => {
    const b = body(src, "resolveCardImageForAI");
    assert.match(b, /fetch-card-image/, "must call the id-keyed endpoint");
    assert.match(b, /id:\s*card\.id/, "must send the card id");
    assert.doesNotMatch(b, /body:\s*JSON\.stringify\(\{\s*url/,
      "sending a URL would reintroduce the SSRF surface the endpoint's design removes");
  });
  t(label + ": a failure reason is recorded so the UI can say WHY", () => {
    const b = body(src, "resolveCardImageForAI");
    assert.match(b, /_lastImageFailReason\s*=/, "must record a reason");
    for (const reason of ["no-image", "fetch-blocked", "decode-failed"]) {
      assert.ok(src.indexOf('"' + reason + '"') >= 0, "missing reason: " + reason);
    }
  });
  t(label + ": regenerateTitleFor reports the specific reason, not one catch-all", () => {
    const m = /async function regenerateTitleFor\(card, ?extraAvoid, ?busyLabel\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "regenerateTitleFor not found");
    assert.match(m[1], /_lastImageFailReason/,
      "a card that failed because its picture was unreachable must not read as 'no usable image'");
  });
  // A module-level reason variable is only trustworthy if it's cleared at the
  // START of each new attempt. generateUniqueTitle can return null WITHOUT ever
  // calling resolveCardImageForAI (e.g. a real desc that fails at the AI call) —
  // if regenerateTitleFor doesn't reset the reason first, a card that never
  // touched its image inherits a STALE reason from a PREVIOUS, unrelated card's
  // failed attempt (e.g. "fetch-blocked" from card A leaking onto card B's
  // "check your AI key/credits" toast). Asserting mere presence of
  // "_lastImageFailReason" (as the test above does) would pass even with this
  // bug still live, since 3d's toast logic itself references the variable —
  // this test instead pins that the reset happens BEFORE generateUniqueTitle runs.
  t(label + ": regenerateTitleFor resets the reason before each attempt (no stale reason from a previous card)", () => {
    const m = /async function regenerateTitleFor\(card, ?extraAvoid, ?busyLabel\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "regenerateTitleFor not found");
    const rBody = m[1];
    const iReset = rBody.search(/_lastImageFailReason\s*=\s*""\s*;/);
    const iGen = rBody.indexOf("generateUniqueTitle(");
    assert.ok(iReset >= 0, "must clear the reason at the start of each attempt");
    assert.ok(iGen >= 0, "must call generateUniqueTitle");
    assert.ok(iReset < iGen, "a stale reason from a previous card's attempt would misreport THIS card's failure");
  });
}
// NOT a byte-parity assertion, unlike the other shared functions. Step 3e gives
// the PWA a different remote-image path on purpose: it has no Core service, so
// it uses the allorigins proxy. Asserting parity here would be asserting a bug.
// Pin the part that MUST match instead.
t("both builds agree on the idb: path and neither browser-fetches a remote URL", () => {
  for (const src of [html, pwaHtml]) {
    const b = body(src, "resolveCardImageForAI");
    assert.match(b, /Store\.ensureImage/, "the idb: branch must be unchanged");
    assert.match(b, /maxEdge\s*=\s*1024/, "the downscale contract must be unchanged");
    assert.doesNotMatch(b, /fetch\(srcUrl\)\.then|await \(await fetch\(img\)\)/, "no direct remote fetch");
  }
});
t("pwa: the remote-image branch uses the allorigins raw-bytes endpoint (not /get, which returns a JSON envelope createImageBitmap can't decode)", () => {
  const b = body(pwaHtml, "resolveCardImageForAI");
  assert.match(b, /allorigins\.win\/raw\?url=/, "must use /raw (raw bytes), not /get (JSON envelope)");
});
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
