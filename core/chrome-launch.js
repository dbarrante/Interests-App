// Startup-only Chrome availability helper for platform auto-import.
// Shell-free by design: tasklist is invoked with fixed arguments and Chrome
// is launched only from known Google installation paths.
const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const TASKLIST_EXE = "C:\\Windows\\System32\\tasklist.exe";
const POWERSHELL_EXE = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

function autoImportEnabled(settingsRaw) {
  try {
    const settings = JSON.parse(settingsRaw || "null");
    return !!settings && settings.autoImportOn === true;
  } catch (_) {
    return false;
  }
}

function chromeCandidates(platform) {
  if (platform !== "win32") return [];
  return [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
}

function verifyGoogleSignature(executable, opts) {
  opts = opts || {};
  const execFile = opts.execFile || childProcess.execFile;
  // The caller only supplies one of chromeCandidates(), after canonical-path
  // equality. Encode the fixed script so PowerShell cannot reinterpret the
  // executable path as command text or split it at spaces.
  const quotedPath = String(executable).replace(/'/g, "''");
  const script = "$p='" + quotedPath + "'; $s=Get-AuthenticodeSignature -LiteralPath $p; if($s.Status -eq 'Valid' -and $s.SignerCertificate.Subject -match '(^|, )O=Google LLC(,|$)'){exit 0}else{exit 1}";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve) => {
    try {
      execFile(POWERSHELL_EXE, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        { windowsHide: true, timeout: 5000 }, (err) => resolve(!err));
    } catch (_) { resolve(false); }
  });
}

async function findChromeExecutable(opts) {
  opts = opts || {};
  const realpath = opts.realpath || fs.realpathSync;
  const stat = opts.stat || fs.statSync;
  const verifySignature = opts.verifySignature || verifyGoogleSignature;
  const candidates = chromeCandidates(opts.platform || process.platform);
  for (const candidate of candidates) {
    try {
      const resolved = realpath(candidate);
      if (path.win32.normalize(resolved).toLowerCase() !== path.win32.normalize(candidate).toLowerCase()) continue;
      if (!stat(resolved).isFile()) continue;
      if (await verifySignature(resolved, opts)) return resolved;
    } catch (_) {}
  }
  return null;
}

function isChromeRunning(opts) {
  opts = opts || {};
  const platform = opts.platform || process.platform;
  if (platform !== "win32") return Promise.resolve(false);
  const execFile = opts.execFile || childProcess.execFile;
  return new Promise((resolve) => {
    try {
      execFile(TASKLIST_EXE, ["/FI", "IMAGENAME eq chrome.exe", "/NH", "/FO", "CSV"],
        { windowsHide: true, timeout: 3000 }, (err, stdout) => {
          if (err) { resolve(null); return; }
          resolve(/"chrome\.exe"/i.test(String(stdout || "")));
        });
    } catch (_) { resolve(null); }
  });
}

function launchChrome(executable, opts) {
  opts = opts || {};
  const spawn = opts.spawn || childProcess.spawn;
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(executable, [], { detached: true, stdio: "ignore" }); }
    catch (e) { reject(e); return; }
    if (!child || typeof child.once !== "function") { reject(new Error("Chrome process did not start")); return; }
    child.once("error", reject);
    child.once("spawn", () => {
      if (typeof child.unref === "function") child.unref();
      resolve();
    });
  });
}

async function ensureChromeForAutoImport(opts) {
  opts = opts || {};
  if (!autoImportEnabled(opts.settingsRaw)) return { action: "disabled" };

  const running = await (opts.isRunning || isChromeRunning)();
  if (running) return { action: "already-running" };
  if (running !== false) return { action: "check-failed" };

  const executable = await (opts.findExecutable || findChromeExecutable)();
  if (!executable) return { action: "not-found" };

  try { await (opts.launch || launchChrome)(executable); }
  catch (e) { return { action: "launch-failed", error: String(e && e.message || e) }; }
  return { action: "launched", executable };
}

module.exports = {
  autoImportEnabled,
  chromeCandidates,
  findChromeExecutable,
  verifyGoogleSignature,
  isChromeRunning,
  launchChrome,
  ensureChromeForAutoImport,
};
