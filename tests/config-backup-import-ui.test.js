// tests/config-backup-import-ui.test.js — the import modal's file-read +
// password flow, sandboxed with a stubbed FileReader/document/Store.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

// A FileReader stand-in that resolves with a preset text result (or errors)
// as soon as readAsText is called — mirrors this project's existing
// restoreData()-testing shape for the same "read a picked file" idiom.
function makeFileReader(readResult, shouldError) {
  return function FakeFileReader() {
    this.readAsText = () => {
      if (shouldError) { if (this.onerror) this.onerror(); return; }
      this.result = readResult;
      if (this.onload) this.onload();
    };
  };
}

// Wires submitConfigBackupImport up against a module-scope `let
// _cfgImportInFlight` -- exactly how it lives on the real page -- and exposes
// it (plus a closeConfigBackupModal call counter) so tests can assert on the
// re-entrancy guard and the modal-close-on-success behavior added by the
// data-safety review's Finding 1 fix, not just the file/password/Store
// plumbing the earlier version of this file covered.
function loadSubmit(src, mocks) {
  const factory = new Function(
    "document", "Store", "FileReader", "toast", "location", "closeConfigBackupModal", "setTimeout",
    "let _cfgImportInFlight = false;\n" +
    extractFn(src, "submitConfigBackupImport") +
    "\nreturn { submitConfigBackupImport, get inFlight(){ return _cfgImportInFlight; } };"
  );
  return factory(
    mocks.document, mocks.Store, mocks.FileReader, mocks.toast || (() => {}),
    mocks.location || { reload: () => {} },
    mocks.closeConfigBackupModal || (() => {}),
    mocks.setTimeout || setTimeout
  );
}

(async () => {
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  await t(label + ": submitConfigBackupImport requires a file", async () => {
    const els = { cfgRestoreFile: { files: [] }, cfgBackupPw1: { value: "pw" }, cfgBackupErr: { textContent: "" } };
    const document = { getElementById: (id) => els[id] };
    const api = loadSubmit(src, {
      document,
      Store: { importConfigBackup: async () => { throw new Error("must not be called"); } },
      FileReader: makeFileReader("{}"),
    });
    api.submitConfigBackupImport();
    assert.ok(els.cfgBackupErr.textContent.length > 0);
  });

  await t(label + ": submitConfigBackupImport requires a password", async () => {
    const fakeFile = {};
    const els = { cfgRestoreFile: { files: [fakeFile] }, cfgBackupPw1: { value: "" }, cfgBackupErr: { textContent: "" } };
    const document = { getElementById: (id) => els[id] };
    const api = loadSubmit(src, {
      document,
      Store: { importConfigBackup: async () => { throw new Error("must not be called"); } },
      FileReader: makeFileReader("{}"),
    });
    api.submitConfigBackupImport();
    assert.ok(els.cfgBackupErr.textContent.length > 0);
  });

  await t(label + ": submitConfigBackupImport rejects a file that isn't valid JSON, without calling Store", async () => {
    const fakeFile = {};
    const els = { cfgRestoreFile: { files: [fakeFile] }, cfgBackupPw1: { value: "pw" }, cfgBackupErr: { textContent: "" } };
    const document = { getElementById: (id) => els[id] };
    let called = false;
    const api = loadSubmit(src, {
      document,
      Store: { importConfigBackup: async () => { called = true; } },
      FileReader: makeFileReader("not json{{{"),
    });
    api.submitConfigBackupImport();
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(called, false);
    assert.ok(els.cfgBackupErr.textContent.length > 0);
    assert.strictEqual(api.inFlight, false, "the guard must be released after a synchronous validation failure so a real retry isn't locked out");
  });

  await t(label + ": submitConfigBackupImport on success calls Store.importConfigBackup, closes the modal, and registers the reload (not synchronously, but for real)", async () => {
    const fakeFile = {};
    const els = { cfgRestoreFile: { files: [fakeFile] }, cfgBackupPw1: { value: "my-pw" }, cfgBackupErr: { textContent: "" } };
    const document = { getElementById: (id) => els[id] };
    let sentPw = null, sentEnvelope = null, reloaded = false, closeCalls = 0;
    let scheduledFn = null, scheduledDelay = null;
    const envelope = { v: 1, salt: "s", iv: "i", authTag: "a", ciphertext: "c" };
    const api = loadSubmit(src, {
      document,
      Store: { importConfigBackup: async (pw, env) => { sentPw = pw; sentEnvelope = env; return { ok: true }; } },
      FileReader: makeFileReader(JSON.stringify(envelope)),
      location: { reload: () => { reloaded = true; } },
      closeConfigBackupModal: () => { closeCalls++; },
      // Stub setTimeout itself (rather than waiting out the real 800ms) so we
      // can prove the reload is actually REGISTERED with the right delay --
      // the previous version of this test only asserted `reloaded === false`
      // at the 10ms mark, which a build that silently dropped the
      // location.reload() call entirely would also pass. Capturing the
      // callback and invoking it ourselves proves it really does reload.
      setTimeout: (fn, delay) => { scheduledFn = fn; scheduledDelay = delay; return 0; },
    });
    api.submitConfigBackupImport();
    await new Promise((r) => setTimeout(r, 10));   // let the async onload handler run up to (not through) the stubbed setTimeout
    assert.strictEqual(sentPw, "my-pw");
    assert.deepStrictEqual(sentEnvelope, envelope);
    assert.strictEqual(closeCalls, 1, "must close the modal (and its Enter-to-resubmit handler) on success, same as submitConfigBackupExport already does");
    assert.strictEqual(reloaded, false, "must not reload synchronously -- the toast needs to be visible first");
    assert.strictEqual(typeof scheduledFn, "function", "the reload must actually be scheduled via setTimeout");
    assert.strictEqual(scheduledDelay, 800);
    scheduledFn();   // simulate the deferred reload firing
    assert.strictEqual(reloaded, true, "invoking the scheduled callback must actually reload -- proves setTimeout wasn't called with a no-op");
    assert.strictEqual(api.inFlight, false, "the guard must be released once the flow completes");
  });

  await t(label + ": submitConfigBackupImport shows the reason and does not reload when Store.importConfigBackup resolves {ok:false} (the PWA/iPad stub's only path -- it never throws)", async () => {
    const fakeFile = {};
    const els = { cfgRestoreFile: { files: [fakeFile] }, cfgBackupPw1: { value: "pw" }, cfgBackupErr: { textContent: "" } };
    const document = { getElementById: (id) => els[id] };
    let reloaded = false, closeCalls = 0, importCalls = 0;
    const envelope = { v: 1, salt: "s", iv: "i", authTag: "a", ciphertext: "c" };
    const api = loadSubmit(src, {
      document,
      Store: { importConfigBackup: async () => { importCalls++; return { ok: false, reason: "Not applicable on iPad -- config restore isn't supported on this platform." }; } },
      FileReader: makeFileReader(JSON.stringify(envelope)),
      location: { reload: () => { reloaded = true; } },
      closeConfigBackupModal: () => { closeCalls++; },
      setTimeout: () => { throw new Error("must not schedule a reload on the ok:false path"); },
    });
    api.submitConfigBackupImport();
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(importCalls, 1);
    assert.strictEqual(els.cfgBackupErr.textContent, "Not applicable on iPad -- config restore isn't supported on this platform.");
    assert.strictEqual(reloaded, false);
    assert.strictEqual(closeCalls, 0, "the modal must stay open so the user can see the error");
    assert.strictEqual(api.inFlight, false, "the guard must be released so the user isn't locked out after a resolved failure");
  });

  await t(label + ": a second submitConfigBackupImport call while the first is still awaiting Store.importConfigBackup is a no-op (data-safety review Finding 1)", async () => {
    const fakeFile = {};
    const els = { cfgRestoreFile: { files: [fakeFile] }, cfgBackupPw1: { value: "pw" }, cfgBackupErr: { textContent: "" } };
    const document = { getElementById: (id) => els[id] };
    let importCalls = 0, resolveImport = null, closeCalls = 0;
    const toasts = [];
    const envelope = { v: 1, salt: "s", iv: "i", authTag: "a", ciphertext: "c" };
    const api = loadSubmit(src, {
      document,
      Store: {
        importConfigBackup: () => { importCalls++; return new Promise((resolve) => { resolveImport = resolve; }); },
      },
      FileReader: makeFileReader(JSON.stringify(envelope)),
      toast: (m) => toasts.push(m),
      closeConfigBackupModal: () => { closeCalls++; },
    });

    api.submitConfigBackupImport();   // starts the first import; Store.importConfigBackup is now pending
    assert.strictEqual(importCalls, 1);
    assert.strictEqual(api.inFlight, true, "precondition: the guard must be set while the first call awaits Store");

    api.submitConfigBackupImport();   // simulates the double-click / double-Enter during the in-flight window
    assert.strictEqual(importCalls, 1, "the second call must NOT reach Store.importConfigBackup a second time -- that's exactly what clobbers the one undo safety snapshot");
    assert.ok(toasts.some((m) => /already in progress/i.test(m)), "the no-op second call should tell the user, not silently swallow it; toasts: " + JSON.stringify(toasts));

    resolveImport({ ok: true });
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(closeCalls, 1, "the (single, real) import must still complete normally and close the modal");
    assert.strictEqual(api.inFlight, false);
  });

  await t(label + ": the import modal warns this replaces the device's current configuration", () => {
    assert.match(src, /replaces this device's current/i);
  });
}
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
})();
