// tests/sync-indicator.test.js — the header sync indicator's two pure functions:
// relTime (friendly "N min ago") and syncIndicatorView (state -> {text,spin,cls,title}).
// Extracted from the real source and run, then a byte-identical web/pwa parity check.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const web = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwa = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
function t(n, f) { try { f(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.message)); } }

function load(src) {
  const relSrc = extractFn(src, "relTime"), viewSrc = extractFn(src, "syncIndicatorView");
  assert.ok(relSrc, "relTime not found");
  assert.ok(viewSrc, "syncIndicatorView not found");
  return new Function(relSrc + "\n" + viewSrc + "\nreturn { relTime, syncIndicatorView };")();
}

for (const [label, src] of [["web", web], ["pwa", pwa]]) {
  const { relTime, syncIndicatorView } = load(src);

  t(label + ": relTime formats each bucket and guards empty input", () => {
    const now = Date.now();
    assert.strictEqual(relTime(now - 10 * 1000), "just now");
    assert.strictEqual(relTime(now - 5 * 60 * 1000), "5 min ago");
    assert.strictEqual(relTime(now - 2 * 3600 * 1000), "2 hours ago");
    assert.strictEqual(relTime(now - 3 * 86400 * 1000), "3 days ago");
    assert.strictEqual(relTime(0), "");
    assert.strictEqual(relTime(null), "");
  });

  t(label + ": syncIndicatorView — off (sync disabled) shows a muted 'sync off' chip, no spin", () => {
    const v = syncIndicatorView({ enabled: false });
    assert.strictEqual(v.cls, "off");
    assert.strictEqual(v.spin, false);
    assert.match(v.text, /sync off/i);
  });

  t(label + ": syncIndicatorView — spins while a UI sync is in flight", () => {
    const v = syncIndicatorView({ enabled: true, inFlight: true });
    assert.strictEqual(v.spin, true);
    assert.match(v.text, /syncing/i);
  });

  t(label + ": syncIndicatorView — spins on the server 'running' flag (background desktop sync)", () => {
    const v = syncIndicatorView({ enabled: true, running: true });
    assert.strictEqual(v.spin, true);
  });

  t(label + ": syncIndicatorView — shows progress detail when a cycle reports it", () => {
    const v = syncIndicatorView({ enabled: true, inFlight: true, progress: { phase: "images", done: 240, total: 1200 } });
    assert.match(v.text, /images 240\/1200/);
  });

  t(label + ": syncIndicatorView — idle shows relative last-sync time", () => {
    const v = syncIndicatorView({ enabled: true, last: { ok: true, at: Date.now() - 5 * 60 * 1000 } });
    assert.strictEqual(v.spin, false);
    assert.match(v.text, /synced 5 min ago/);
  });

  t(label + ": syncIndicatorView — surfaces a failed last sync", () => {
    const v = syncIndicatorView({ enabled: true, last: { ok: false, reason: "boom" } });
    assert.strictEqual(v.spin, false);
    assert.match(v.text, /failed/i);
  });
}

t("all shared sync-indicator functions are byte-identical between web and pwa", () => {
  for (const n of ["relTime", "syncIndicatorView", "renderSyncIndicator", "refreshSyncIndicatorState", "syncChipClick", "startSyncIndicatorLoop"]) {
    assert.strictEqual(extractFn(web, n), extractFn(pwa, n), n + " has drifted between web/ and pwa/");
  }
});

t("both surfaces mount the #syncIndicator chip in the header and start its loop at boot", () => {
  for (const [label, src] of [["web", web], ["pwa", pwa]]) {
    assert.match(src, /id="syncIndicator"[^>]*onclick="syncChipClick\(\)"/, label + " must place the sync chip in the header");
    assert.match(src, /startSyncIndicatorLoop\(\);/, label + " must start the indicator loop at boot");
    assert.match(src, /\.sync-chip\{/, label + " must define the sync-chip CSS");
  }
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
