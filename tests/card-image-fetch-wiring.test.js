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
  t(label + ": a failure is reported through the RETURN VALUE ({ failReason }), not a shared module variable", () => {
    const b = body(src, "resolveCardImageForAI");
    // Structural fix for the fire-and-forget race: enrichOnOpen calls
    // generateUniqueTitle (and therefore resolveCardImageForAI) without awaiting
    // it when a card is opened. A module-level "last reason" variable could be
    // overwritten by that unrelated background call before the original caller
    // read it. Tying the reason to the return value makes that structurally
    // impossible — assert the whole class of shared state is gone, not just
    // that a reason is recorded somewhere.
    assert.ok(!/_lastImageFailReason/.test(src),
      "the old module-level reason variable must be fully removed — its whole failure mode (a concurrent call overwriting the reason before the original caller reads it) is only eliminated once no code reads or writes it");
    assert.match(b, /return\s*\{\s*failReason\s*:/, "failure must be reported by returning a { failReason } object");
    for (const reason of ["no-image", "fetch-blocked", "decode-failed"]) {
      assert.match(b, new RegExp("failReason\\s*:\\s*\"" + reason + "\""), "missing reason: " + reason);
    }
  });
  t(label + ": the common 'card has no picture at all' path reports a reason too, not just the malformed-img branch", () => {
    const b = body(src, "resolveCardImageForAI");
    // Regression for the specific bug: a plain bookmark card (no .img/.image at
    // all) hit `if(!img) return null;` with no reason set, so the UI fell back to
    // the generic "check your AI key/credits" message instead of "no picture" —
    // sending the user to troubleshoot billing for a card that simply has no
    // image. Only the rare malformed-img else branch set a reason before the fix.
    assert.match(b, /if\(!img\)\s*return\s*\{\s*failReason\s*:\s*"no-image"\s*\};/,
      "the FIRST return (no img field at all) must set failReason to no-image — this is the common case, not the rare malformed-img one");
  });
  t(label + ": a thrown fetch (offline, DNS failure, or a blocked proxy) is reported as fetch-blocked too, not lumped into decode-failed", () => {
    const b = body(src, "resolveCardImageForAI");
    // Only a non-ok HTTP response used to set fetch-blocked; if fetch() itself
    // THROWS (offline/DNS/blocked CORS proxy — the PWA's most likely failure,
    // since it calls the third-party api.allorigins.win), the exception used to
    // reach the OUTER catch, which is for createImageBitmap/canvas failures and
    // mislabels it decode-failed. Fixed by wrapping the two fetch branches in
    // their own try/catch. Assert "fetch-blocked" appears from BOTH the non-ok
    // check AND a catch — a single occurrence means only the non-ok path is covered.
    const matches = b.match(/failReason:\s*"fetch-blocked"/g) || [];
    assert.ok(matches.length >= 2,
      "fetch-blocked must be set from two distinct sites: the !resp.ok check AND a catch wrapping the fetch calls (found " + matches.length + ")");
  });
  t(label + ": regenerateTitleFor reports the specific reason from generateUniqueTitle's return value, not the old module state", () => {
    const m = /async function regenerateTitleFor\(card, ?extraAvoid, ?busyLabel\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "regenerateTitleFor not found");
    assert.match(m[1], /failReason/,
      "a card that failed because its picture was unreachable must not read as 'no usable image'");
    assert.doesNotMatch(m[1], /_lastImageFailReason/,
      "must not read the old module-level variable — a fire-and-forget background call (e.g. enrichOnOpen opening a different card) could overwrite it before this read");
  });
  // The module-level variable (and its "reset before each attempt" requirement)
  // is gone entirely (pinned above) — regenerateTitleFor now gets a fresh
  // { title, failReason } object from ITS OWN generateUniqueTitle call every
  // time, so a previous card's failure can never leak into this one's toast.
  // This replaces the old "resets the reason before each attempt" test, whose
  // entire concern (stale module state) is now structurally impossible rather
  // than merely reset-in-time.
  t(label + ": regenerateTitleFor derives its reason from its OWN generateUniqueTitle call, after invoking it", () => {
    const m = /async function regenerateTitleFor\(card, ?extraAvoid, ?busyLabel\)\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, "regenerateTitleFor not found");
    const rBody = m[1];
    const iGen = rBody.indexOf("generateUniqueTitle(");
    const iFailReasonAssign = rBody.search(/failReason\s*=\s*\(result\s*&&\s*result\.failReason\)/);
    assert.ok(iGen >= 0, "must call generateUniqueTitle");
    assert.ok(iFailReasonAssign >= 0, "must read failReason off the awaited result object");
    assert.ok(iFailReasonAssign > iGen, "the reason must be read from the result of THIS call, after invoking it — never from a variable that could have been set earlier by something else");
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
    // "fetch(srcUrl)" alone can't be banned outright — the idb: branch
    // legitimately fetches a same-origin blob: URL through that exact call.
    // The actual bug (regression check, Task 4 Finding D) was assigning the
    // REMOTE img URL into srcUrl in the first place, which then flows straight
    // into that same fetch(srcUrl) and gets CORS-refused. The old banned
    // patterns here (/fetch\(srcUrl\)\.then|await \(await fetch\(img\)\)/)
    // never matched the code's real shape (await (await fetch(srcUrl)).blob())
    // and stayed green even with the bug reintroduced — verified empirically
    // (see task report). Pin the actual invariant instead: the http(s) branch
    // must force srcUrl to "", never to the remote img value.
    assert.doesNotMatch(b, /srcUrl\s*=\s*img\s*;/,
      "srcUrl must never be set to the remote img URL — that value flows straight into fetch(srcUrl), the SAME call the idb: branch legitimately uses, and CORS refuses it for a cross-origin URL");
    const iHttpBranch = b.indexOf("test(img)){");
    assert.ok(iHttpBranch >= 0, "the http(s) branch condition (…test(img)){) not found");
    const iCloseBrace = b.indexOf("}", iHttpBranch);
    const httpBranchBody = b.slice(iHttpBranch, iCloseBrace);
    assert.match(httpBranchBody, /srcUrl\s*=\s*"";/,
      "the http(s) branch must set srcUrl to \"\" — any other value (e.g. the bug's srcUrl = img) flows straight into fetch(srcUrl) and gets CORS-refused for a cross-origin URL");
  }
});
t("pwa: the remote-image branch uses the allorigins raw-bytes endpoint (not /get, which returns a JSON envelope createImageBitmap can't decode)", () => {
  const b = body(pwaHtml, "resolveCardImageForAI");
  assert.match(b, /allorigins\.win\/raw\?url=/, "must use /raw (raw bytes), not /get (JSON envelope)");
});
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
