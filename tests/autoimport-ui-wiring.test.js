// tests/autoimport-ui-wiring.test.js — Settings UI for the FB/IG auto-import
// scheduler (Task 4): source asserts only (no browser harness), mirroring this
// repo's established convention (see tests/collapsible-sections.test.js).
// Endpoint/ledger behavior is covered by tests/autoimport-endpoint.test.js and
// tests/autoimport-core.test.js; renderer capture-routing precedence is covered
// by tests/route-capture.test.js. This file covers only the Settings section's
// markup + JS wiring + the desktop-only PWA hide.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const web = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwa = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name); } }

[["web", web], ["pwa", pwa]].forEach(([label, src]) => {
  ok(`${label}: secAutoImport section exists in markup`, /<div class="sec" id="secAutoImport">/.test(src));
  ok(`${label}: master toggle (autoImportToggle) present`, /id="autoImportToggle"/.test(src));
  ok(`${label}: per-platform toggles (autoImportFbToggle/autoImportIgToggle) present`, /id="autoImportFbToggle"/.test(src) && /id="autoImportIgToggle"/.test(src));
  ok(`${label}: "Check now" button wired to autoImportCheckNow()`, /onclick="autoImportCheckNow\(\)"/.test(src));
  ok(`${label}: status line container (autoImportStatus) present`, /id="autoImportStatus"/.test(src));

  ok(`${label}: DEFAULTS ships autoImportOn OFF (auto-check must default off)`, /autoImportOn:false/.test(src));
  ok(`${label}: DEFAULTS ships autoImportFb/autoImportIg ON (per-platform default once master is on)`, /autoImportFb:true/.test(src) && /autoImportIg:true/.test(src));

  // Toggles must persist through the app's normal settings pipeline (save("settings",S) ->
  // Store.kvSet("ia_settings",...) -> the SAME kv key core/autoimport.js's getConfig() reads).
  ok(`${label}: master toggle writes S.autoImportOn via save("settings",S)`,
    /autoImportToggle"\)\.onchange\s*=\s*e=>\{[^}]*S\.autoImportOn\s*=\s*e\.target\.checked;[^}]*save\("settings",S\)/.test(src));
  ok(`${label}: Facebook toggle writes S.autoImportFb via save("settings",S)`,
    /autoImportFbToggle"\)\.onchange\s*=\s*e=>\{[^}]*S\.autoImportFb\s*=\s*e\.target\.checked;[^}]*save\("settings",S\)/.test(src));
  ok(`${label}: Instagram toggle writes S.autoImportIg via save("settings",S)`,
    /autoImportIgToggle"\)\.onchange\s*=\s*e=>\{[^}]*S\.autoImportIg\s*=\s*e\.target\.checked;[^}]*save\("settings",S\)/.test(src));

  // "Check now" POSTs the request mailbox (mirrors /api/capture-request's pattern).
  ok(`${label}: autoImportCheckNow() POSTs the /api/auto-import/request mailbox`,
    /async function autoImportCheckNow\(\)\{[\s\S]{0,300}?Store\.setAutoImportRequest\(/.test(src));

  // Status line reads GET /api/auto-import/status, which surfaces the
  // ia_autoimport_last_fb / ia_autoimport_last_ig kv records core/autoimport.js writes.
  const statusFnMatch = src.match(/async function renderAutoImportStatus\(\)\{[\s\S]{0,500}?\n\}/);
  ok(`${label}: renderAutoImportStatus() defined`, !!statusFnMatch);
  if (statusFnMatch) {
    const body = statusFnMatch[0];
    ok(`${label}: renderAutoImportStatus() calls Store.getAutoImportStatus()`, body.indexOf("Store.getAutoImportStatus()") >= 0);
    ok(`${label}: renderAutoImportStatus() writes into #autoImportStatus`, body.indexOf('getElementById("autoImportStatus")') >= 0);
  }
  ok(`${label}: status rendering is documented as surfacing ia_autoimport_last_* (core/autoimport.js kv contract)`,
    /ia_autoimport_last_fb/.test(src) && /ia_autoimport_last_ig/.test(src));

  // renderSettings() must actually wire these controls, guarded off the PWA (whose Store has
  // no auto-import methods) via the same window.IA_IDB check the hide-list below relies on.
  ok(`${label}: renderSettings wiring block is gated by !window.IA_IDB`,
    /if\(!window\.IA_IDB && document\.getElementById\("autoImportToggle"\)\)\{/.test(src));
});

// --- PWA-only: the section must be hidden via the existing desktop-only hide list ---
ok("pwa: secAutoImport is added to the window.IA_IDB hide list", /\[\s*"secBrowserExt","newsMixBlock","sbKeyBlock","secAppUpdates","secAutoImport"\s*\]\.forEach/.test(pwa));
ok("web: secAutoImport is added to the SAME hide list (byte-identical hide-list line, binding parity)",
  /\[\s*"secBrowserExt","newsMixBlock","sbKeyBlock","secAppUpdates","secAutoImport"\s*\]\.forEach/.test(web));

// --- web/storage.js: the Store methods the renderer calls must actually exist ---
const storage = fs.readFileSync(path.join(__dirname, "..", "web", "storage.js"), "utf8");
ok("web/storage.js: SE.autoImportRequest() endpoint builder present", /autoImportRequest:\s*function\s*\(\)\s*\{\s*return\s*"\/api\/auto-import\/request";/.test(storage));
ok("web/storage.js: SE.autoImportStatus() endpoint builder present", /autoImportStatus:\s*function\s*\(\)\s*\{\s*return\s*"\/api\/auto-import\/status";/.test(storage));
ok("web/storage.js: Store.setAutoImportRequest POSTs SE.autoImportRequest()", /setAutoImportRequest:\s*function\s*\(req\)\s*\{\s*return\s*jsend\("POST",\s*SE\.autoImportRequest\(\)/.test(storage));
ok("web/storage.js: Store.getAutoImportStatus GETs SE.autoImportStatus()", /getAutoImportStatus:\s*function\s*\(\)\s*\{\s*return\s*jget\(SE\.autoImportStatus\(\)\)/.test(storage));

console.log("autoimport-ui-wiring: " + pass + " passed, " + fail + " failed");
if (fail) process.exitCode = 1;
