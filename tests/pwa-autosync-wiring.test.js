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
  const region = src.slice(src.indexOf("async function autoSync("), src.indexOf("async function autoSync(") + 2400);
  assert.ok(/_booted/.test(region), "must check _booted");
  assert.ok(/_syncInFlight/.test(region), "must check the shared in-flight guard");
  assert.ok(/AUTO_SYNC_COOLDOWN/.test(region), "must enforce the cooldown");
  assert.ok(/st\.enabled/.test(region) && /st\.connected/.test(region), "must check syncStatus().enabled + .connected");
});

t("autoSync claims the in-flight guard SYNCHRONOUSLY, before any await (TOCTOU fix, data-safety review 2026-07-16)", () => {
  const region = src.slice(src.indexOf("async function autoSync("), src.indexOf("async function autoSync(") + 2400);
  const claimIdx = region.indexOf("_syncInFlight = (async ()=>{");
  const awaitIdx = region.indexOf("await Store.syncStatus()");
  assert.ok(claimIdx >= 0, "guard must be claimed with a synchronous IIFE assignment");
  assert.ok(awaitIdx >= 0 && claimIdx < awaitIdx, "the guard claim must come BEFORE the syncStatus await");
  const beforeClaim = region.slice(0, claimIdx).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/await /.test(beforeClaim), "no await may run before the guard is claimed (comments excluded)");
});

t("every changed-sync path re-hydrates in-memory state BEFORE the user can act on stale globals (data-safety HIGH)", () => {
  assert.ok(/async function rehydrateAfterSync\(/.test(src), "rehydrateAfterSync must exist");
  const rehydrate = src.slice(src.indexOf("async function rehydrateAfterSync("), src.indexOf("async function rehydrateAfterSync(") + 900);
  assert.ok(/imported = await Store\.getCards\(\)/.test(rehydrate), "must refresh cards");
  assert.ok(/saved\s+= await Store\.getSaved\(\)/.test(rehydrate), "must refresh saved");
  assert.ok(/kvGet\("ia_settings"\)/.test(rehydrate), "must refresh settings into S");
  assert.ok(/_lastSettingsJson = JSON\.stringify\(S\)/.test(rehydrate), "must re-baseline so rehydration never stamps ia_settings_updatedAt");
  const auto = src.slice(src.indexOf("async function autoSync("), src.indexOf("async function autoSync(") + 2400);
  assert.ok(/r\.changed\)\{ await rehydrateAfterSync\(\);/.test(auto), "autoSync changed path must rehydrate before toasting");
  const manual = src.slice(src.indexOf("async function syncNowClick("), src.indexOf("async function syncNowClick(") + 1600);
  assert.ok(/await rehydrateAfterSync\(\); setTimeout/.test(manual), "manual changed path must rehydrate before the delayed reload");
  const poll = src.slice(src.indexOf("async function pollSyncChanged("), src.indexOf("async function pollSyncChanged(") + 700);
  assert.ok(/await rehydrateAfterSync\(\)/.test(poll), "pollSyncChanged must rehydrate when the service's timer merge changed the store");
});

t("wake lock held during sync cycles: acquired on start, released in finally, re-acquired on return", () => {
  assert.ok(/async function acquireSyncWakeLock\(/.test(src), "acquireSyncWakeLock must exist");
  assert.ok(/navigator\.wakeLock\.request\("screen"\)/.test(src), "must request a screen wake lock");
  assert.ok(/function releaseSyncWakeLock\(/.test(src), "releaseSyncWakeLock must exist");
  const manual = src.slice(src.indexOf("async function syncNowClick("), src.indexOf("async function syncNowClick(") + 1900);
  assert.ok(/acquireSyncWakeLock\(\);/.test(manual), "manual sync must acquire the lock");
  assert.ok(/finally\{[\s\S]{0,120}releaseSyncWakeLock\(\)/.test(manual), "manual sync must release in finally");
  const auto = src.slice(src.indexOf("async function autoSync("), src.indexOf("async function autoSync(") + 2400);
  assert.ok(/acquireSyncWakeLock\(\);/.test(auto), "auto sync must acquire the lock");
  assert.ok(/finally\{ _syncInFlight = null; releaseSyncWakeLock\(\); \}/.test(auto), "auto sync must release in finally");
  assert.ok(/visibilitychange[\s\S]{0,120}_syncInFlight\) acquireSyncWakeLock\(\)/.test(src),
    "must re-acquire on returning to the page mid-sync (the OS drops the lock whenever the page hides)");
});

t("rehydrateAfterSync is byte-identical between web/index.html and pwa/index.html", () => {
  const webSrc = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
  function grabFn(source) {
    const idx = source.indexOf("async function rehydrateAfterSync(");
    assert.ok(idx >= 0, "rehydrateAfterSync missing");
    const open = source.indexOf("{", idx);
    let depth = 0, i = open;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { i++; break; } }
    }
    return source.slice(idx, i);
  }
  assert.strictEqual(grabFn(src), grabFn(webSrc), "rehydrateAfterSync has diverged between pwa and web — keep them byte-identical");
});

t("all three triggers are wired: boot, visibilitychange, interval", () => {
  assert.ok(/autoSync\("boot"\)/.test(src), "bootData must fire autoSync(\"boot\")");
  const bootedIdx = src.indexOf("_booted = true");
  assert.ok(bootedIdx >= 0 && src.indexOf('autoSync("boot")') > bootedIdx, "boot trigger must come AFTER _booted = true");
  assert.ok(/visibilitychange[\s\S]{0,120}autoSync\("visible"\)/.test(src), "foreground trigger");
  assert.ok(/setInterval\(\(\)=>autoSync\("interval"\), AUTO_SYNC_INTERVAL\)/.test(src), "interval trigger");
});

t("manual sync passes a progress callback so long catch-ups show movement (auto-sync stays silent)", () => {
  const manual = src.slice(src.indexOf("async function syncNowClick("), src.indexOf("async function syncNowClick(") + 1800);
  assert.ok(/Store\.syncNow\(p=>\{ if\(p && p\.total\)\{ toast\(/.test(manual), "syncNowClick must surface onProgress via toast");
  const auto = src.slice(src.indexOf("async function autoSync("), src.indexOf("async function autoSync(") + 2400);
  assert.ok(/return Store\.syncNow\(\);/.test(auto), "autoSync stays silent — no progress toasts from background syncs");
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
  const region = src.slice(start, start + 2400);
  assert.ok(/tap to refresh|click to refresh/.test(region), "must offer, not force, the reload");
  assert.ok(/toast\(/.test(region) && /location\.reload\(\)/.test(region), "toast with reload callback");
});

console.log(passed + " passed, " + failed + " failed");
process.exitCode = failed ? 1 : 0;
