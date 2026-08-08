// tests/openlink-force-external.test.js — openLink()'s forceExternal param.
//
// Root cause (live reproduction, 2026-08-08): with the "reuseWindow" setting
// on, openLink() routes through window.ia.openInApp -- which opens the URL in
// linkWin, a bare Electron BrowserWindow with NO Chrome extension loaded. The
// manual point-to-point capture flow (impManualCapture) NEEDS a real Chrome
// tab: it arms a capture request the extension polls for, and the extension
// can only find/interact with a real chrome.tabs entry -- linkWin is
// invisible to chrome.tabs.query and can never be found by
// findAppOpenedTab. So with reuseWindow on, the extension always fell back to
// creating its OWN separate real Chrome tab, leaving linkWin open and unused
// alongside it -- "spawning another window with the site... confusing."
// impManualCapture must force the real external-browser path regardless of
// the user's reuseWindow preference.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const web = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwa = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

function buildOpenLink(src, reuseWindow) {
  const calls = { openInApp: [], windowOpen: [] };
  const factory = new Function(
    "window", "S",
    extractFn(src, "openLink") + "\nreturn openLink;"
  );
  const fakeWindow = {
    ia: { openInApp: (url) => calls.openInApp.push(url) },
    open: (url) => calls.windowOpen.push(url),
  };
  const openLink = factory(fakeWindow, { reuseWindow });
  return { openLink, calls };
}

for (const [label, src] of [["web", web], ["pwa", pwa]]) {
  t(label + ": openLink(url) with reuseWindow on still uses openInApp (unaffected -- every OTHER caller keeps today's behavior)", () => {
    const { openLink, calls } = buildOpenLink(src, true);
    openLink("https://example.com/a");
    assert.deepStrictEqual(calls.openInApp, ["https://example.com/a"]);
    assert.deepStrictEqual(calls.windowOpen, []);
  });

  t(label + ": openLink(url, true) with reuseWindow on bypasses openInApp entirely -- goes straight to the real external browser", () => {
    const { openLink, calls } = buildOpenLink(src, true);
    openLink("https://example.com/b", true);
    assert.deepStrictEqual(calls.openInApp, [], "must NOT open the Electron linkWin -- the extension can never see it");
    assert.deepStrictEqual(calls.windowOpen, ["https://example.com/b"]);
  });

  t(label + ": openLink(url, true) with reuseWindow OFF behaves exactly as before (already went to window.open)", () => {
    const { openLink, calls } = buildOpenLink(src, false);
    openLink("https://example.com/c", true);
    assert.deepStrictEqual(calls.windowOpen, ["https://example.com/c"]);
  });

  t(label + ": openLink(url, true) with a non-http(s) url still falls back to window.open, not silently dropped", () => {
    const { openLink, calls } = buildOpenLink(src, true);
    openLink("mailto:someone@example.com", true);
    assert.deepStrictEqual(calls.windowOpen, ["mailto:someone@example.com"]);
    assert.deepStrictEqual(calls.openInApp, []);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
