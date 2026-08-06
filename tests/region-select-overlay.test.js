const assert = require("assert");
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "extension", "region-select.js"), "utf8");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + (e && e.message)); } }

t("guards against double injection on an already-active tab", () => {
  assert.ok(/if \(window\.__iaRegionSelectActive\) return;/.test(src));
});
t("sends regionSelectCrop with a {x,y,w,h} rect on mouseup, and hides the dim before capturing", () => {
  assert.ok(/action: "regionSelectCrop", rect: r/.test(src));
  assert.ok(/overlay\.style\.background = "transparent";/.test(src), "the overlay's dimming must be hidden before the screenshot so it isn't captured in the crop");
});
t("ignores a too-small drag instead of treating it as a deliberate selection", () => {
  assert.ok(/r\.w < 8 \|\| r\.h < 8/.test(src));
});
t("shows a preview with Use this / Redo before finalizing", () => {
  assert.ok(/__ia_use_this/.test(src) && /__ia_redo/.test(src));
  assert.ok(/Use this/.test(src) && />Redo</.test(src));
});
t("Use this sends regionSelectFinalize; Redo does not (stays local, re-arms for another drag)", () => {
  // Find the Use This querySelector call and verify regionSelectFinalize appears in its handler
  const useThisQsIdx = src.indexOf('querySelector("#__ia_use_this")');
  assert.ok(useThisQsIdx >= 0);
  const useThisBlock = src.slice(useThisQsIdx, useThisQsIdx + 600);
  assert.ok(/action: "regionSelectFinalize"/.test(useThisBlock), "Use this handler should send regionSelectFinalize");

  // Find the Redo querySelector call and verify regionSelectFinalize does NOT appear in its handler
  const redoQsIdx = src.indexOf('querySelector("#__ia_redo")');
  assert.ok(redoQsIdx >= 0);
  const redoBlock = src.slice(redoQsIdx, redoQsIdx + 400);
  assert.ok(!/action: "regionSelectFinalize"/.test(redoBlock), "Redo handler should NOT send regionSelectFinalize");
});
t("Escape sends regionSelectCancel and cleans up", () => {
  assert.ok(/e\.key !== "Escape"/.test(src));
  assert.ok(/action: "regionSelectCancel"/.test(src));
});
t("cleanup resets the re-entrancy flag and removes the shadow-root host (takes overlay/box/msg/preview with it)", () => {
  const start = src.indexOf("function cleanup() {");
  const body = src.slice(start, start + 300);
  assert.ok(/window\.__iaRegionSelectActive = false;/.test(body));
  assert.ok(/host\.remove\(\);/.test(body), "cleanup must remove the shadow-root host, not just detach the overlay from it");
});
t("overlay is mounted in a closed shadow root, not the page's light DOM (page script can't reach in/exfiltrate the preview)", () => {
  assert.ok(/attachShadow\(\s*\{\s*mode:\s*"closed"\s*\}\s*\)/.test(src), "must use a CLOSED shadow root");
  assert.ok(/document\.documentElement\.appendChild\(host\)/.test(src), "the shadow host itself is what's appended to the page");
  assert.ok(!/document\.documentElement\.appendChild\(overlay\)/.test(src), "the overlay must no longer be appended directly to the page's light DOM");
});
t("in-overlay element lookups use the shadow root, not document", () => {
  assert.ok(/root\.getElementById\("__ia_region_select_msg"\)/.test(src));
  assert.ok(/root\.getElementById\("__ia_region_select_preview"\)/.test(src));
  assert.ok(!/document\.getElementById\("__ia_region_select_msg"\)/.test(src), "must look up the message element via the shadow root, not document");
  assert.ok(!/document\.getElementById\("__ia_region_select_preview"\)/.test(src), "must look up the preview element via the shadow root, not document");
});
t("Use this / Redo click handlers and the Escape keydown handler all reject untrusted (script-synthesized) events", () => {
  const useThisQsIdx = src.indexOf('querySelector("#__ia_use_this")');
  const useThisBlock = src.slice(useThisQsIdx, useThisQsIdx + 600);
  assert.ok(/if \(!e\.isTrusted\) return;/.test(useThisBlock), "Use this handler must gate on e.isTrusted");

  const redoQsIdx = src.indexOf('querySelector("#__ia_redo")');
  const redoBlock = src.slice(redoQsIdx, redoQsIdx + 400);
  assert.ok(/if \(!e\.isTrusted\) return;/.test(redoBlock), "Redo handler must gate on e.isTrusted");

  const keyDownStart = src.indexOf("function onKeyDown(e) {");
  const keyDownBody = src.slice(keyDownStart, keyDownStart + 200);
  assert.ok(/if \(!e\.isTrusted\) return;/.test(keyDownBody), "Escape keydown handler must gate on e.isTrusted");
});
t("catches mouseup events outside the overlay (document-level listener)", () => {
  assert.ok(/document\.addEventListener\("mouseup", onDocumentMouseUp\)/.test(src), "must add document-level mouseup listener");
  assert.ok(/function onDocumentMouseUp/.test(src), "must define onDocumentMouseUp handler");
  // Verify it processes the drag when cursor leaves viewport before mouseup
  assert.ok(/if \(!dragging\) return;/.test(src), "onDocumentMouseUp must check dragging state");
});
t("aborts in-progress selection if window loses focus mid-drag", () => {
  assert.ok(/window\.addEventListener\("blur", onWindowBlur\)/.test(src), "must add window blur listener");
  assert.ok(/function onWindowBlur/.test(src), "must define onWindowBlur handler");
  // Verify it resets dragging state without trying to capture
  const blurStart = src.indexOf("function onWindowBlur");
  const blurEnd = src.indexOf("}", blurStart) + 1;
  const blurBody = src.slice(blurStart, blurEnd);
  assert.ok(/dragging = false/.test(blurBody), "blur handler must reset dragging state");
  assert.ok(/box\.style\.display = "none"/.test(blurBody), "blur handler must hide the selection box");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
