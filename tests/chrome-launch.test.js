const assert = require("assert");
const path = require("path");
const fs = require("fs");
const chrome = require("../core/chrome-launch");

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log("  ok  " + name); }
  catch (e) { failed++; console.error("  FAIL " + name + "\n    " + (e && e.stack || e)); }
}

(async () => {
  await t("auto-import disabled: never probes or launches Chrome", async () => {
    let probed = 0, launched = 0;
    const r = await chrome.ensureChromeForAutoImport({
      settingsRaw: JSON.stringify({ autoImportOn: false }),
      isRunning: async () => { probed++; return false; },
      findExecutable: () => "chrome.exe",
      launch: () => { launched++; },
    });
    assert.deepStrictEqual(r, { action: "disabled" });
    assert.strictEqual(probed, 0);
    assert.strictEqual(launched, 0);
  });

  await t("malformed, missing, or wrong-type settings fail closed", async () => {
    const disabledValues = [null, "", "not-json", JSON.stringify({})]
      .concat(["false", 1, [], {}].map((autoImportOn) => JSON.stringify({ autoImportOn })));
    for (const raw of disabledValues) {
      const r = await chrome.ensureChromeForAutoImport({ settingsRaw: raw });
      assert.deepStrictEqual(r, { action: "disabled" });
    }
  });

  await t("Chrome already running: does not resolve a path or launch", async () => {
    let found = 0, launched = 0;
    const r = await chrome.ensureChromeForAutoImport({
      settingsRaw: JSON.stringify({ autoImportOn: true }),
      isRunning: async () => true,
      findExecutable: () => { found++; return "chrome.exe"; },
      launch: () => { launched++; },
    });
    assert.deepStrictEqual(r, { action: "already-running" });
    assert.strictEqual(found, 0);
    assert.strictEqual(launched, 0);
  });

  await t("process detection failure: fails closed without launching", async () => {
    let launched = 0;
    const r = await chrome.ensureChromeForAutoImport({
      settingsRaw: JSON.stringify({ autoImportOn: true }),
      isRunning: async () => null,
      findExecutable: () => "chrome.exe",
      launch: () => { launched++; },
    });
    assert.deepStrictEqual(r, { action: "check-failed" });
    assert.strictEqual(launched, 0);
  });

  await t("Chrome absent: launches the resolved executable exactly once", async () => {
    const calls = [];
    const r = await chrome.ensureChromeForAutoImport({
      settingsRaw: JSON.stringify({ autoImportOn: true }),
      isRunning: async () => false,
      findExecutable: () => "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      launch: (exe) => { calls.push(exe); },
    });
    assert.deepStrictEqual(r, {
      action: "launched",
      executable: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    });
    assert.deepStrictEqual(calls, ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"]);
  });

  await t("Chrome absent but not installed at a trusted path: fails soft", async () => {
    const r = await chrome.ensureChromeForAutoImport({
      settingsRaw: JSON.stringify({ autoImportOn: true }),
      isRunning: async () => false,
      findExecutable: () => null,
      launch: () => { throw new Error("must not launch"); },
    });
    assert.deepStrictEqual(r, { action: "not-found" });
  });

  await t("Windows candidates are fixed machine-wide Google Chrome locations only", () => {
    assert.deepStrictEqual(chrome.chromeCandidates("win32"), [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ]);
  });

  await t("executable resolution requires canonical regular file and valid Google signature", async () => {
    const candidate = chrome.chromeCandidates("win32")[0];
    const good = await chrome.findChromeExecutable({
      platform: "win32",
      realpath: () => candidate,
      stat: () => ({ isFile: () => true }),
      verifySignature: async () => true,
    });
    assert.strictEqual(good, candidate);
    const unsigned = await chrome.findChromeExecutable({
      platform: "win32",
      realpath: () => candidate,
      stat: () => ({ isFile: () => true }),
      verifySignature: async () => false,
    });
    assert.strictEqual(unsigned, null);
  });

  await t("asynchronous Chrome spawn errors are reported", async () => {
    const child = {
      handlers: {},
      once(name, fn) { this.handlers[name] = fn; },
      unref() {},
    };
    const pending = chrome.launchChrome("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", {
      spawn: () => child,
    });
    child.handlers.error(new Error("ENOENT"));
    await assert.rejects(pending, /ENOENT/);
  });

  await t("background Chrome processes without a visible window count as closed", async () => {
    let calledExe = "", calledArgs = [];
    const r = await chrome.isChromeRunning({
      platform: "win32",
      execFile: (exe, args, _opts, cb) => {
        calledExe = exe; calledArgs = args;
        cb(null, "CLOSED\r\n");
      },
    });
    assert.strictEqual(r, false);
    assert.strictEqual(calledExe, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.ok(calledArgs.includes("-EncodedCommand"));
    const encoded = calledArgs[calledArgs.indexOf("-EncodedCommand") + 1];
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    assert.match(script, /EnumWindows/);
    assert.match(script, /GetWindowThreadProcessId/);
    assert.match(script, /GetWindowTextLength/);
    assert.match(script, /IsWindowVisible/);
    assert.match(script, /IsIconic/);
    assert.match(script, /ErrorActionPreference='Stop'/);
  });

  await t("a visible Chrome window counts as open", async () => {
    const r = await chrome.isChromeRunning({
      platform: "win32",
      execFile: (_exe, _args, _opts, cb) => cb(null, "OPEN\r\n"),
    });
    assert.strictEqual(r, true);
  });

  await t("empty or diagnostic detector output is unknown and fails closed", async () => {
    for (const stdout of ["", "diagnostic output", "OPEN extra"]) {
      const r = await chrome.isChromeRunning({
        platform: "win32",
        execFile: (_exe, _args, _opts, cb) => cb(null, stdout),
      });
      assert.strictEqual(r, null);
    }
  });

  await t("window-detection errors are unknown, not a false 'not open' result", async () => {
    const r = await chrome.isChromeRunning({
      platform: "win32",
      execFile: (_exe, _args, _opts, cb) => cb(new Error("blocked"), ""),
    });
    assert.strictEqual(r, null);
  });

  await t("synchronous window-detection spawn failures are contained", async () => {
    const r = await chrome.isChromeRunning({
      platform: "win32",
      execFile: () => { throw new Error("EPERM"); },
    });
    assert.strictEqual(r, null);
  });

  await t("main process wires the helper after the window is created", () => {
    const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
    const windowAt = main.indexOf("createWindow(port)");
    const ensureAt = main.indexOf("ensureChromeForAutoImport({");
    assert.ok(/require\("\.\/core\/chrome-launch"\)/.test(main));
    assert.ok(/getKV\(ctx\.db,\s*"ia_settings"\)/.test(main));
    assert.ok(windowAt >= 0 && ensureAt > windowAt, "Chrome check must not delay the app window");
  });

  console.log("chrome-launch: " + passed + " passed, " + failed + " failed");
  process.exitCode = failed ? 1 : 0;
})();
