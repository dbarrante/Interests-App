// tests/pwa-autosync-wiring.test.js — the PWA used to sync ONLY from the manual
// "Sync now" button; settings/cards changed elsewhere never arrived unless the
// user remembered to tap it. This locks in the auto-sync wiring: boot +
// foreground + interval triggers, one shared in-flight guard with the manual
// button, cooldown, and a once-per-disconnect reconnect toast.
const assert = require("assert");
const fs = require("fs"), path = require("path");
const src = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error("FAIL: " + name + "\n  " + (e && e.message)); }
}

t("autoSync exists with cooldown + interval constants", () => {
  assert.ok(/async function autoSync\(/.test(src), "autoSync must exist");
  assert.ok(/AUTO_SYNC_COOLDOWN\s*=\s*5\*60\*1000/.test(src), "5-minute cooldown");
  assert.ok(/AUTO_SYNC_INTERVAL\s*=\s*15\*60\*1000/.test(src), "15-minute interval");
});

t("autoSync bails when not booted, in flight, cooling down, disabled, or disconnected", () => {
  const region = src.slice(src.indexOf("async function autoSync("), src.indexOf("async function autoSync(") + 1600);
  assert.ok(/_booted/.test(region), "must check _booted");
  assert.ok(/_syncInFlight/.test(region), "must check the shared in-flight guard");
  assert.ok(/AUTO_SYNC_COOLDOWN/.test(region), "must enforce the cooldown");
  assert.ok(/st\.enabled/.test(region) && /st\.connected/.test(region), "must check syncStatus().enabled + .connected");
});

t("all three triggers are wired: boot, visibilitychange, interval", () => {
  assert.ok(/autoSync\("boot"\)/.test(src), "bootData must fire autoSync(\"boot\")");
  const bootedIdx = src.indexOf("_booted = true");
  assert.ok(bootedIdx >= 0 && src.indexOf('autoSync("boot")') > bootedIdx, "boot trigger must come AFTER _booted = true");
  assert.ok(/visibilitychange[\s\S]{0,120}autoSync\("visible"\)/.test(src), "foreground trigger");
  assert.ok(/setInterval\(\(\)=>autoSync\("interval"\), AUTO_SYNC_INTERVAL\)/.test(src), "interval trigger");
});

t("syncNowClick shares the in-flight guard (no overlapping cycles) and clears it in finally", () => {
  const start = src.indexOf("async function syncNowClick(");
  const region = src.slice(start, start + 1600);
  assert.ok(/if\(_syncInFlight\)/.test(region), "manual tap must refuse to start a second concurrent cycle");
  assert.ok(/finally\{[\s\S]{0,80}_syncInFlight = null/.test(region), "guard must clear in finally (a thrown sync must not wedge auto-sync forever)");
});

t("AUTH_EXPIRED toasts once per disconnect, reset on success", () => {
  assert.ok(/_authToastShown/.test(src), "needs the once-per-disconnect flag");
  const matches = src.match(/_authToastShown = false/g) || [];
  assert.ok(matches.length >= 1, "flag must reset when a sync succeeds/reconnects");
});

t("auto-sync 'changed' outcome reuses the click-to-refresh toast, never a forced reload", () => {
  const start = src.indexOf("async function autoSync(");
  const region = src.slice(start, start + 1600);
  assert.ok(/tap to refresh|click to refresh/.test(region), "must offer, not force, the reload");
  assert.ok(/toast\(/.test(region) && /location\.reload\(\)/.test(region), "toast with reload callback");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
