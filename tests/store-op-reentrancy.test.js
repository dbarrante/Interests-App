// tests/store-op-reentrancy.test.js — Task 5 follow-up (code review finding):
// the original in-flight indicator only disabled three known buttons
// (backupNowBtn/restoreLatestBtn/moveDataBtn). Other live surfaces stayed
// reachable while an op was running and could clobber the shared
// _storeOpInFlight flag out from under the operation actually in progress:
//   - renderBackupList()'s per-row "Restore" buttons call restoreFromList(name)
//     directly and were never disabled.
//   - The durability banner's own "Back up now" button is a separate DOM
//     element, not backupNowBtn.
//   - Ctrl+Shift+B calls backupNow() unconditionally.
// Fix: each of backupNow/restoreFromList/restoreLatest/moveDataLocation now
// checks _storeOpInFlight itself and no-ops (with a toast) if another op is
// already running, regardless of which surface called in. This file proves
// that function-level guard directly -- exactly the reviewer's scenario:
// seed _storeOpInFlight as though one operation is already running, then
// call a DIFFERENT entry point and confirm it's rejected instead of
// clobbering the flag.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); pass++; console.log("  ok  " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); }
}
function fnSrc(src, name) {
  const m = extractFn(src, name);
  assert.ok(m, name + " not found in source");
  return m;
}

// Wires restoreByName/restoreFromList/restoreLatest into ONE shared scope
// against a single _storeOpInFlight `let` -- exactly how they share it on
// the real page (a module-scope `let`) -- so seeding it before a call is
// visible to that call, and a call's own mutation of it is visible to the
// test afterward. This is what makes the "different entry point sees the
// flag another op already set" scenario reproducible.
function loadRestoreFns(src, initialFlight, mocks) {
  const body =
    "let _storeOpInFlight = " + JSON.stringify(initialFlight) + ";\n" +
    fnSrc(src, "restoreByName") + "\n" +
    fnSrc(src, "restoreFromList") + "\n" +
    fnSrc(src, "restoreLatest") + "\n" +
    "return { restoreFromList, restoreLatest, restoreByName, get flight(){ return _storeOpInFlight; } };";
  const factory = new Function("toast", "confirm", "Store", "renderStoreOpIndicator", "location", "setTimeout", body);
  return factory(
    mocks.toast, mocks.confirm, mocks.Store,
    mocks.renderStoreOpIndicator || function () {},
    mocks.location || { reload: function () {} },
    mocks.setTimeout || function () {}
  );
}
function loadBackupNow(src, initialFlight, mocks) {
  const body =
    "let _storeOpInFlight = " + JSON.stringify(initialFlight) + ";\n" +
    fnSrc(src, "backupNow") + "\n" +
    "return { backupNow, get flight(){ return _storeOpInFlight; } };";
  const factory = new Function("toast", "renderStoreOpIndicator", "doBackup", body);
  return factory(mocks.toast, mocks.renderStoreOpIndicator || function () {}, mocks.doBackup || function () { return Promise.resolve({ ok: true }); });
}
function loadMoveDataLocation(src, initialFlight, mocks) {
  const body =
    "let _storeOpInFlight = " + JSON.stringify(initialFlight) + ";\n" +
    fnSrc(src, "moveDataLocation") + "\n" +
    "return { moveDataLocation, get flight(){ return _storeOpInFlight; } };";
  const factory = new Function("toast", "confirm", "prompt", "Store", "renderStoreOpIndicator", "window", body);
  return factory(
    mocks.toast, mocks.confirm || function () { return false; }, mocks.prompt || function () { return null; },
    mocks.Store, mocks.renderStoreOpIndicator || function () {}, mocks.window || {}
  );
}

async function run() {
  for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
    await t(label + ": restoreFromList (a DIFFERENT entry point than backupNow) is rejected, not clobbering _storeOpInFlight, when a backup is already in flight", async () => {
      const toastCalls = [];
      let confirmCalls = 0, restoreCalls = 0;
      const api = loadRestoreFns(src, "backup", {
        toast: (msg) => toastCalls.push(msg),
        confirm: () => { confirmCalls++; return true; },
        Store: { restore: async (name) => { restoreCalls++; return { ok: true }; }, listBackups: async () => [] },
      });
      assert.strictEqual(api.flight, "backup", "precondition: a backup is already in flight");

      await api.restoreFromList("some-backup.json");   // the per-row Restore button's exact call

      assert.strictEqual(restoreCalls, 0, "Store.restore must never be reached -- the guard must reject before doing any work");
      assert.strictEqual(confirmCalls, 0, "must not even prompt the user while another op is running");
      assert.ok(toastCalls.some((m) => /already in progress/i.test(m)), "must tell the user an operation is already running; toast calls: " + JSON.stringify(toastCalls));
      assert.strictEqual(api.flight, "backup", "must NOT clobber the in-flight backup's flag to \"restore\" -- this is the exact bug the reviewer found");
    });

    await t(label + ": restoreLatest is also rejected via the same guard when another op is in flight", async () => {
      const toastCalls = [];
      let listCalls = 0;
      const api = loadRestoreFns(src, "move", {
        toast: (msg) => toastCalls.push(msg),
        confirm: () => true,
        Store: { restore: async () => ({ ok: true }), listBackups: async () => { listCalls++; return []; } },
      });

      await api.restoreLatest();

      assert.strictEqual(listCalls, 0, "must reject before even listing backups");
      assert.ok(toastCalls.some((m) => /already in progress/i.test(m)));
      assert.strictEqual(api.flight, "move", "must not clobber the in-flight move's flag");
    });

    await t(label + ": backupNow is rejected via the same guard when another op is in flight", async () => {
      const toastCalls = [];
      let doBackupCalls = 0;
      const api = loadBackupNow(src, "restore", {
        toast: (msg) => toastCalls.push(msg),
        doBackup: () => { doBackupCalls++; return Promise.resolve({ ok: true }); },
      });

      await api.backupNow();

      assert.strictEqual(doBackupCalls, 0, "must reject before doing any backup work");
      assert.ok(toastCalls.some((m) => /already in progress/i.test(m)));
      assert.strictEqual(api.flight, "restore", "must not clobber the in-flight restore's flag");
    });

    await t(label + ": moveDataLocation is rejected via the same guard when another op is in flight", async () => {
      const toastCalls = [];
      let storeLocationCalls = 0;
      const api = loadMoveDataLocation(src, "backup", {
        toast: (msg) => toastCalls.push(msg),
        Store: { storeLocation: async () => { storeLocationCalls++; return {}; }, moveStore: async () => ({ ok: true }) },
      });

      await api.moveDataLocation();

      assert.strictEqual(storeLocationCalls, 0, "must reject before even reading the current store location");
      assert.ok(toastCalls.some((m) => /already in progress/i.test(m)));
      assert.strictEqual(api.flight, "backup", "must not clobber the in-flight backup's flag");
    });

    // Sanity/regression pass: the guard must not break the legitimate paths,
    // including restoreLatest's internal handoff to restoreByName (Task 5's
    // shared helper, extracted specifically so restoreLatest doesn't trip its
    // own sibling's re-entrancy guard).
    await t(label + ": restoreFromList still completes normally when no operation is in flight", async () => {
      const toastCalls = [];
      let restoredName = null, confirmCalls = 0, restoreCalls = 0;
      const api = loadRestoreFns(src, null, {
        toast: (msg) => toastCalls.push(msg),
        confirm: () => { confirmCalls++; return true; },
        Store: { restore: async (name) => { restoreCalls++; restoredName = name; return { ok: true }; }, listBackups: async () => [] },
      });

      await api.restoreFromList("2026-07-30.json");

      // Data-safety review flagged that the restoreByName extraction moved
      // the "A safety snapshot..." confirm() prompt into a function nothing
      // asserted -- deleting that confirm() call still passed every test.
      // Asserting it fires exactly once, plus that Store.restore fires
      // exactly once, closes that gap (and would also catch a guard that
      // always rejects, or a double-invocation regression, neither of which
      // a name-only assertion would notice).
      assert.strictEqual(confirmCalls, 1, "the safety-snapshot confirm() dialog must still run on the normal path");
      assert.strictEqual(restoreCalls, 1);
      assert.strictEqual(restoredName, "2026-07-30.json");
      assert.ok(toastCalls.some((m) => /^Restored from/.test(m)));
      assert.strictEqual(api.flight, null, "flag must be released after a normal completion");
    });

    await t(label + ": restoreLatest still completes normally via restoreByName when no operation is in flight", async () => {
      const toastCalls = [];
      let restoredName = null, confirmCalls = 0, restoreCalls = 0;
      const api = loadRestoreFns(src, null, {
        toast: (msg) => toastCalls.push(msg),
        confirm: () => { confirmCalls++; return true; },
        Store: {
          restore: async (name) => { restoreCalls++; restoredName = name; return { ok: true }; },
          listBackups: async () => [{ name: "mirror.json", mirror: true }, { name: "2026-07-29.json" }],
        },
      });

      await api.restoreLatest();

      assert.strictEqual(confirmCalls, 1, "the safety-snapshot confirm() dialog must still run on the normal path");
      assert.strictEqual(restoreCalls, 1, "must restore exactly once -- not zero (guard-always-rejects regression) and not twice");
      assert.strictEqual(restoredName, "2026-07-29.json", "must skip the rolling mirror, same as before this refactor");
      assert.ok(toastCalls.some((m) => /^Restored from/.test(m)));
      assert.strictEqual(api.flight, null, "flag must be released after a normal completion");
    });
  }

  console.log(pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}

run();
