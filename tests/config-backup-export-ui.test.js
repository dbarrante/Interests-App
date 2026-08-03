// tests/config-backup-export-ui.test.js — the export modal's password/confirm
// validation and the Blob-download construction, sandboxed with stubbed
// Blob/URL/document/Store (this project's established extractFn() pattern;
// see tests/enrichOnOpen-style sandboxes elsewhere for the stub-DOM technique).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { extractFn } = require("./_extract");

const html = fs.readFileSync(path.join(__dirname, "..", "web", "index.html"), "utf8");
const pwaHtml = fs.readFileSync(path.join(__dirname, "..", "pwa", "index.html"), "utf8");

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); pass++; console.log("  ok  " + n); } catch (e) { fail++; console.log("  FAIL " + n + " — " + (e && e.stack || e)); } }

function makeDom() {
  const body = { innerHTML: "", value: "", textContent: "" };
  const els = {
    configBackupModalBody: body,
    cfgBackupPw1: { value: "", focus: () => {} },
    cfgBackupPw2: { value: "" },
    cfgBackupErr: { textContent: "" },
    configBackupModal: { classList: { add: () => {}, remove: () => {} } },
  };
  const anchor = { href: "", download: "", click: () => { anchor.clicked = true; } };
  const document = {
    getElementById: (id) => els[id] || null,
    createElement: (tag) => (tag === "a" ? anchor : {}),
    body: { appendChild: () => {}, removeChild: () => {} },
  };
  return { document, els, anchor };
}

(async () => {
for (const [label, src] of [["web", html], ["pwa", pwaHtml]]) {
  await t(label + ": submitConfigBackupExport refuses an empty password without calling Store", async () => {
    const { document, els } = makeDom();
    els.cfgBackupPw1.value = ""; els.cfgBackupPw2.value = "";
    let called = false;
    const Store = { exportConfigBackup: async () => { called = true; return { ok: true, envelope: {} }; } };
    const factory = new Function(
      "document", "Store", "Blob", "URL", "toast", "closeConfigBackupModal",
      extractFn(src, "submitConfigBackupExport") + "\nreturn submitConfigBackupExport;"
    );
    const submitConfigBackupExport = factory(document, Store, function () {}, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }, () => {}, () => {});
    await submitConfigBackupExport();
    assert.strictEqual(called, false);
    assert.ok(els.cfgBackupErr.textContent.length > 0);
  });

  await t(label + ": submitConfigBackupExport refuses mismatched passwords without calling Store", async () => {
    const { document, els } = makeDom();
    els.cfgBackupPw1.value = "abc123"; els.cfgBackupPw2.value = "different";
    let called = false;
    const Store = { exportConfigBackup: async () => { called = true; return { ok: true, envelope: {} }; } };
    const factory = new Function(
      "document", "Store", "Blob", "URL", "toast", "closeConfigBackupModal",
      extractFn(src, "submitConfigBackupExport") + "\nreturn submitConfigBackupExport;"
    );
    const submitConfigBackupExport = factory(document, Store, function () {}, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }, () => {}, () => {});
    await submitConfigBackupExport();
    assert.strictEqual(called, false);
    assert.match(els.cfgBackupErr.textContent, /match/i);
  });

  await t(label + ": submitConfigBackupExport with matching passwords calls Store, closes the modal, and triggers a download", async () => {
    const { document, els, anchor } = makeDom();
    els.cfgBackupPw1.value = "abc123"; els.cfgBackupPw2.value = "abc123";
    let sentPassword = null, modalClosed = false;
    const Store = { exportConfigBackup: async (pw) => { sentPassword = pw; return { ok: true, envelope: { v: 1, salt: "s" } }; } };
    let blobContent = null;
    function FakeBlob(parts) { blobContent = parts[0]; }
    const factory = new Function(
      "document", "Store", "Blob", "URL", "toast", "closeConfigBackupModal",
      extractFn(src, "submitConfigBackupExport") + "\nreturn submitConfigBackupExport;"
    );
    const submitConfigBackupExport = factory(document, Store, FakeBlob, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }, () => {}, () => { modalClosed = true; });
    await submitConfigBackupExport();
    assert.ok(modalClosed, "a successful export must close the modal");
    assert.strictEqual(sentPassword, "abc123");
    assert.ok(anchor.clicked, "the download must actually be triggered via a.click()");
    assert.ok(/\.iaconfig$/.test(anchor.download), "download filename must end in .iaconfig");
    assert.ok(JSON.parse(blobContent).v === 1, "the Blob content must be the envelope JSON");
    assert.ok(!blobContent.includes("abc123"), "the downloaded file must never contain the plaintext password");
  });

  await t(label + ": openConfigBackupExport wires the same Enter/Escape handler on both password fields", async () => {
    const { document, els } = makeDom();
    let submitCalled = false, closeCalled = false;
    const factory = new Function(
      "document", "submitConfigBackupExport", "closeConfigBackupModal",
      extractFn(src, "openConfigBackupExport") + "\nreturn openConfigBackupExport;"
    );
    const openConfigBackupExport = factory(document, () => { submitCalled = true; }, () => { closeCalled = true; });
    openConfigBackupExport();
    assert.strictEqual(typeof els.cfgBackupPw1.onkeydown, "function", "password field must have a keydown handler");
    assert.strictEqual(typeof els.cfgBackupPw2.onkeydown, "function", "confirm field must have a keydown handler too");
    assert.strictEqual(els.cfgBackupPw1.onkeydown, els.cfgBackupPw2.onkeydown, "both fields must share the identical handler");
    els.cfgBackupPw2.onkeydown({ key: "Enter" });
    assert.ok(submitCalled, "Enter in the confirm field must submit");
    els.cfgBackupPw1.onkeydown({ key: "Escape" });
    assert.ok(closeCalled, "Escape in the password field must close the modal");
  });

  await t(label + ": closeConfigBackupModal clears the modal body so a typed password doesn't linger in the DOM", () => {
    const { document, els } = makeDom();
    els.configBackupModalBody.innerHTML = "<input value=\"abc123\">";
    const factory = new Function(
      "document",
      extractFn(src, "closeConfigBackupModal") + "\nreturn closeConfigBackupModal;"
    );
    const closeConfigBackupModal = factory(document);
    closeConfigBackupModal();
    assert.strictEqual(els.configBackupModalBody.innerHTML, "", "modal body must be cleared on close");
  });

  await t(label + ": the Settings section has Export/Restore configuration buttons", () => {
    assert.match(src, /onclick="openConfigBackupExport\(\)"/);
    assert.match(src, /onclick="openConfigBackupImport\(\)"/);
  });

  await t(label + ": #configBackupModal markup and CSS exist", () => {
    assert.match(src, /id="configBackupModal"/);
    assert.match(src, /#configBackupModal\{/);
  });
}
console.log(pass + " passed, " + fail + " failed");
process.exitCode = fail ? 1 : 0;
})();
