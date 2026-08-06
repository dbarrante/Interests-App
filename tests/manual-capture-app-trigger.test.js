// tests/manual-capture-app-trigger.test.js — impManualCapture (the card-face
// "manual point-to-point capture" icon) and its CSS/markup wiring.
//
// impManualCapture arms a manual:true capture request AND opens the article
// itself via openLink, the same instant/reliable mechanism impOpen uses
// (2026-08-06: the extension's own chrome.tabs.create path was found, via
// live reproduction, to produce no tab at all even though the poller
// correctly claimed the request). The extension's job is reduced to finding
// that same tab (see extension/background.js's findAppOpenedTab) and driving
// the point-to-point overlay from there.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, fn) { try { fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  t(label + ": impManualCapture arms a manual:true request with the card's id, and also calls openLink with the card's url", () => {
    const imported = [{ id: "c1", url: "https://example.com/a" }];
    const calls = [];
    let openLinkUrl = null;
    const Store = { putCards: () => {}, setCaptureRequest: (req) => calls.push(req) };
    const factory = new Function(
      "imported", "Store", "anchorImpOnCard", "toast", "newId", "openLink",
      extractFn(src, "impManualCapture") + "\nreturn impManualCapture;"
    );
    const impManualCapture = factory(
      imported, Store, () => {}, () => {}, () => "genid",
      (url) => { openLinkUrl = url; }
    );
    impManualCapture(0);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0], { url: "https://example.com/a", id: "c1", manual: true });
    // openLink (the same instant, reliable mechanism impOpen uses) opens the
    // article right away -- the extension's job is reduced to finding that
    // same tab and injecting the overlay, not creating its own (2026-08-06:
    // live reproduction found the extension's own chrome.tabs.create path
    // producing no tab at all, even though the poller correctly claimed the
    // request).
    assert.strictEqual(openLinkUrl, "https://example.com/a", "impManualCapture must open the article itself via openLink, same as impOpen");
  });

  t(label + ": impManualCapture assigns a new id to an id-less card before arming the request", () => {
    const imported = [{ url: "https://example.com/b" }];
    const calls = [];
    let putCardsCalls = 0;
    const Store = { putCards: () => { putCardsCalls++; }, setCaptureRequest: (req) => calls.push(req) };
    const factory = new Function(
      "imported", "Store", "anchorImpOnCard", "toast", "newId", "openLink",
      extractFn(src, "impManualCapture") + "\nreturn impManualCapture;"
    );
    const impManualCapture = factory(imported, Store, () => {}, () => {}, () => "newgenid", () => {});
    impManualCapture(0);
    assert.strictEqual(imported[0].id, "newgenid");
    assert.strictEqual(calls[0].id, "newgenid");
    assert.ok(putCardsCalls >= 1, "the freshly-assigned id must be persisted");
  });

  t(label + ": impManualCapture no-ops on a card with no url", () => {
    const imported = [{ id: "c2" }];
    const calls = [];
    const Store = { putCards: () => {}, setCaptureRequest: (req) => calls.push(req) };
    const factory = new Function(
      "imported", "Store", "anchorImpOnCard", "toast", "newId",
      extractFn(src, "impManualCapture") + "\nreturn impManualCapture;"
    );
    const impManualCapture = factory(imported, Store, () => {}, () => {}, () => "x");
    impManualCapture(0);
    assert.strictEqual(calls.length, 0);
  });

  t(label + ": impManualCapture no-ops on an out-of-range index", () => {
    const imported = [];
    const calls = [];
    const Store = { putCards: () => {}, setCaptureRequest: (req) => calls.push(req) };
    const factory = new Function(
      "imported", "Store", "anchorImpOnCard", "toast", "newId",
      extractFn(src, "impManualCapture") + "\nreturn impManualCapture;"
    );
    const impManualCapture = factory(imported, Store, () => {}, () => {}, () => "x");
    impManualCapture(0);
    assert.strictEqual(calls.length, 0);
  });

  t(label + ": impManualCapture anchors the card and stamps a pending-ish lastUpdate before arming", () => {
    const it = { id: "c3", url: "https://example.com/c" };
    const imported = [it];
    let anchored = null;
    const Store = { putCards: () => {}, setCaptureRequest: () => {} };
    const factory = new Function(
      "imported", "Store", "anchorImpOnCard", "toast", "newId", "openLink",
      extractFn(src, "impManualCapture") + "\nreturn impManualCapture;"
    );
    const impManualCapture = factory(imported, Store, (card) => { anchored = card; }, () => {}, () => "x", () => {});
    const before = Date.now();
    impManualCapture(0);
    assert.strictEqual(anchored, it, "anchorImpOnCard must be called with the card");
    assert.ok(it.lastUpdate >= before);
    assert.strictEqual(it.lastResult, "pending");
  });

  t(label + ": impManualCapture leaves an already-ok lastResult alone", () => {
    const it = { id: "c4", url: "https://example.com/d", lastResult: "ok" };
    const imported = [it];
    const Store = { putCards: () => {}, setCaptureRequest: () => {} };
    const factory = new Function(
      "imported", "Store", "anchorImpOnCard", "toast", "newId", "openLink",
      extractFn(src, "impManualCapture") + "\nreturn impManualCapture;"
    );
    const impManualCapture = factory(imported, Store, () => {}, () => {}, () => "x", () => {});
    impManualCapture(0);
    assert.strictEqual(it.lastResult, "ok");
  });

  t(label + ": impManualCapture toasts guidance to draw a box", () => {
    const imported = [{ id: "c5", url: "https://example.com/e" }];
    let toasted = "";
    const Store = { putCards: () => {}, setCaptureRequest: () => {} };
    const factory = new Function(
      "imported", "Store", "anchorImpOnCard", "toast", "newId", "openLink",
      extractFn(src, "impManualCapture") + "\nreturn impManualCapture;"
    );
    const impManualCapture = factory(imported, Store, () => {}, (msg) => { toasted = msg; }, () => "x", () => {});
    impManualCapture(0);
    assert.ok(toasted.toLowerCase().indexOf("box") >= 0, "toast should mention drawing a box");
  });

  t(label + ": impCardHTML renders the manual-capture icon only when the card has a url, alongside imp-refresh", () => {
    const body = extractFn(src, "impCardHTML");
    assert.ok(body, "impCardHTML not found");
    assert.match(body, /it\.url\?`<button class="imp-refresh[\s\S]*?<\/button><button class="imp-manualcap"[\s\S]*?impManualCapture\(\$\{idx\}\)/,
      "the imp-manualcap button must be inside the same it.url? ternary as imp-refresh");
  });

  t(label + ": .imp-manualcap joins the shared hover-reveal CSS group (base, hover-display, hover-color)", () => {
    assert.match(src, /\.imp-manualcap,\.imp-edit,\.imp-refresh,\.imp-reader,\.imp-title,\.imp-revert\{/,
      "base positioning/sizing group");
    assert.match(src, /\.imp-card:hover \.imp-manualcap,\.imp-card:hover \.imp-edit,\.imp-card:hover \.imp-refresh,\.imp-card:hover \.imp-reader,\.imp-card:hover \.imp-title,\.imp-card:hover \.imp-revert\{display:flex\}/,
      "hover-reveal group");
    assert.match(src, /\.imp-manualcap:hover,\.imp-edit:hover,\.imp-refresh:hover,\.imp-reader:hover,\.imp-title:hover,\.imp-revert:hover\{/,
      "hover color-change group");
  });

  t(label + ": .imp-manualcap has its own right:142px offset (doesn't overlap .imp-title or the relocated .imp-revert)", () => {
    assert.match(src, /\.imp-manualcap\{right:142px/);
  });

  t(label + ": .imp-manualcap is included in the touch-reachability @media(max-width:760px) rule", () => {
    assert.match(src, /@media\(max-width:760px\)\{\.imp-edit,\.imp-refresh,\.imp-reader,\.imp-title,\.imp-revert,\.imp-manualcap\{display:flex\}\}/);
  });
}

console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
