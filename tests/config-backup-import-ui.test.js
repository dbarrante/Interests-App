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

(async () => {
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  await t(label + ": submitConfigBackupImport requires a file", async () => {
    const els = { cfgRestoreFile: { files: [] }, cfgBackupPw1: { value: "pw" }, cfgBackupErr: { textContent: "" } };
    const document = { getElementById: (id) => els[id] };
    const factory = new Function(
      "document", "Store", "FileReader", "toast", "location",
      extractFn(src, "submitConfigBackupImport") + "\nreturn submitConfigBackupImport;"
    );
    const submitConfigBackupImport = factory(document, { importConfigBackup: async () => { throw new Error("must not be called"); } }, makeFileReader("{}"), () => {}, { reload: () => {} });
    submitConfigBackupImport();
    assert.ok(els.cfgBackupErr.textContent.length > 0);
  });

  await t(label + ": submitConfigBackupImport requires a password", async () => {
    const fakeFile = {};
    const els = { cfgRestoreFile: { files: [fakeFile] }, cfgBackupPw1: { value: "" }, cfgBackupErr: { textContent: "" } };
    const document = { getElementById: (id) => els[id] };
    const factory = new Function(
      "document", "Store", "FileReader", "toast", "location",
      extractFn(src, "submitConfigBackupImport") + "\nreturn submitConfigBackupImport;"
    );
    const submitConfigBackupImport = factory(document, { importConfigBackup: async () => { throw new Error("must not be called"); } }, makeFileReader("{}"), () => {}, { reload: () => {} });
    submitConfigBackupImport();
    assert.ok(els.cfgBackupErr.textContent.length > 0);
  });

  await t(label + ": submitConfigBackupImport rejects a file that isn't valid JSON, without calling Store", async () => {
    const fakeFile = {};
    const els = { cfgRestoreFile: { files: [fakeFile] }, cfgBackupPw1: { value: "pw" }, cfgBackupErr: { textContent: "" } };
    const document = { getElementById: (id) => els[id] };
    let called = false;
    const factory = new Function(
      "document", "Store", "FileReader", "toast", "location",
      extractFn(src, "submitConfigBackupImport") + "\nreturn submitConfigBackupImport;"
    );
    const submitConfigBackupImport = factory(document, { importConfigBackup: async () => { called = true; } }, makeFileReader("not json{{{"), () => {}, { reload: () => {} });
    submitConfigBackupImport();
    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(called, false);
    assert.ok(els.cfgBackupErr.textContent.length > 0);
  });

  await t(label + ": submitConfigBackupImport on success calls Store.importConfigBackup and defers the reload (doesn't reload synchronously)", async () => {
    const fakeFile = {};
    const els = { cfgRestoreFile: { files: [fakeFile] }, cfgBackupPw1: { value: "my-pw" }, cfgBackupErr: { textContent: "" } };
    const document = { getElementById: (id) => els[id] };
    let sentPw = null, sentEnvelope = null, reloaded = false;
    const envelope = { v: 1, salt: "s", iv: "i", authTag: "a", ciphertext: "c" };
    const factory = new Function(
      "document", "Store", "FileReader", "toast", "location",
      extractFn(src, "submitConfigBackupImport") + "\nreturn submitConfigBackupImport;"
    );
    const submitConfigBackupImport = factory(
      document,
      { importConfigBackup: async (pw, env) => { sentPw = pw; sentEnvelope = env; return { ok: true }; } },
      makeFileReader(JSON.stringify(envelope)),
      () => {},
      { reload: () => { reloaded = true; } }
    );
    submitConfigBackupImport();
    await new Promise((r) => setTimeout(r, 10));   // let the async onload handler run (well short of the real 800ms reload delay)
    assert.strictEqual(sentPw, "my-pw");
    assert.deepStrictEqual(sentEnvelope, envelope);
    assert.strictEqual(reloaded, false, "the reload must be deliberately deferred (800ms, so the toast is visible first), not synchronous");
  });

  await t(label + ": the import modal warns this replaces the device's current configuration", () => {
    assert.match(src, /replaces this device's current/i);
  });
}
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
})();
