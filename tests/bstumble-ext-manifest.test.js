// tests/bstumble-ext-manifest.test.js — manifest wiring for browser stumble,
// plus (final-review fix wave) a general extension-manifest shape lock and a
// region-select.js hardening lock — this was the only existing *ext-manifest*
// test file, so the new assertions were added here rather than in a new file.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const m = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "extension", "manifest.json"), "utf8"));

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

ok("version bumped to 4.59", m.version === "4.59");
ok("no default_popup (icon click fires onClicked)", !(m.action && m.action.default_popup));
ok("options_page set", m.options_page === "options.html");
ok("still has scripting + tabs + notifications perms", ["scripting","tabs","notifications"].every(p => m.permissions.includes(p)));

// ---- Manifest-shape lock (final-review fix wave, manual point-to-point capture) ----
// Guards against a future accidental permission / host_permission / externally_connectable
// addition slipping in unnoticed. If this genuinely needs to change, update it deliberately
// alongside the manifest edit — don't just widen it to make a failure go away.
const EXPECTED_PERMISSIONS = ["alarms", "contextMenus", "notifications", "scripting", "storage", "tabs", "unlimitedStorage", "webNavigation"];
ok("permissions are exactly the expected set", JSON.stringify((m.permissions || []).slice().sort()) === JSON.stringify(EXPECTED_PERMISSIONS.slice().sort()));
ok("host_permissions are exactly <all_urls>", JSON.stringify(m.host_permissions) === JSON.stringify(["<all_urls>"]));
ok("no externally_connectable — no web page may message the service worker", !("externally_connectable" in m));
ok("no web_accessible_resources", !("web_accessible_resources" in m));

// ---- region-select.js hardening lock (Fix 8: closed shadow root + isTrusted gating) ----
const regionSelectSrc = fs.readFileSync(path.join(__dirname, "..", "extension", "region-select.js"), "utf8");
ok("overlay is mounted via a CLOSED shadow root (not the page's light DOM)", /attachShadow\(\s*\{\s*mode:\s*"closed"\s*\}\s*\)/.test(regionSelectSrc));
// Three genuine-user-input gates expected: "Use this" click, "Redo" click, Escape keydown.
// A pre-Fix-8 file has zero of these — this must fail against the old source.
const isTrustedGuards = (regionSelectSrc.match(/if\s*\(\s*!e\.isTrusted\s*\)\s*return;/g) || []).length;
ok("Use this / Redo / Escape all gate on e.isTrusted (>=3 guards found, got " + isTrustedGuards + ")", isTrustedGuards >= 3);

console.log("bstumble-ext-manifest: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
