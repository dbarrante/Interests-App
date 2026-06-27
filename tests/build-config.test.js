// tests/build-config.test.js
// Asserts the electron-builder NSIS config in package.json matches the design contract.
const assert = require("assert");
const path = require("path");
const pkg = require(path.join(__dirname, "..", "package.json"));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok  " + name); } catch (e) { fail++; console.log("  FAIL " + name + " — " + e.message); } }

t("build block exists", () => {
  assert.ok(pkg.build && typeof pkg.build === "object", "package.json.build missing");
});
t("appId and productName set", () => {
  assert.ok(pkg.build.appId, "build.appId missing");
  assert.ok(pkg.build.productName, "build.productName missing");
});
t("buildResources points at build/", () => {
  assert.strictEqual(pkg.build.directories && pkg.build.directories.buildResources, "build");
});
t("nsis.oneClick === false (assisted wizard)", () => {
  assert.strictEqual(pkg.build.nsis.oneClick, false);
});
t("nsis.allowToChangeInstallationDirectory === true", () => {
  assert.strictEqual(pkg.build.nsis.allowToChangeInstallationDirectory, true);
});
t("nsis.perMachine === false (per-user install)", () => {
  assert.strictEqual(pkg.build.nsis.perMachine, false);
});
t("nsis creates desktop + start-menu shortcuts", () => {
  assert.strictEqual(pkg.build.nsis.createDesktopShortcut, true);
  assert.strictEqual(pkg.build.nsis.createStartMenuShortcut, true);
});
t("nsis.artifactName defined", () => {
  assert.ok(pkg.build.nsis.artifactName, "build.nsis.artifactName missing");
});
t("nsis.include points to build/installer.nsh", () => {
  assert.strictEqual(pkg.build.nsis.include, "build/installer.nsh");
});
t("win target is nsis", () => {
  const tg = pkg.build.win && pkg.build.win.target;
  const ok = tg === "nsis" || (Array.isArray(tg) && tg.includes("nsis")) ||
    (Array.isArray(tg) && tg.some(x => x && x.target === "nsis"));
  assert.ok(ok, "build.win.target must include nsis");
});
t("packaging excludes the data folder (asar payload)", () => {
  assert.ok(Array.isArray(pkg.build.files), "build.files must be an array");
  const excludesData = pkg.build.files.some(f =>
    typeof f === "string" && /^!data(\/|$|\/\*)/.test(f.replace(/\\/g, "/")));
  assert.ok(excludesData, "build.files must contain an exclusion like '!data/**/*'");
});

const fs = require("fs");
const nshPath = path.join(__dirname, "..", "build", "installer.nsh");
t("build/installer.nsh exists", () => {
  assert.ok(fs.existsSync(nshPath), "build/installer.nsh missing");
});
t("installer.nsh keeps data/ on update via customRemoveFiles", () => {
  const nsh = fs.readFileSync(nshPath, "utf8");
  assert.ok(/!macro\s+customRemoveFiles/i.test(nsh), "customRemoveFiles macro missing");
  assert.ok(/\$INSTDIR\\data/i.test(nsh), "must reference $INSTDIR\\data");
  assert.ok(/isUpdated/i.test(nsh), "must branch on the update flag (isUpdated)");
});
t("installer.nsh uninstaller prompts before deleting the library (default No)", () => {
  const nsh = fs.readFileSync(nshPath, "utf8");
  assert.ok(/!macro\s+customUnInstall/i.test(nsh), "customUnInstall macro missing");
  assert.ok(/MB_YESNO/i.test(nsh), "uninstall MessageBox must be MB_YESNO");
  assert.ok(/MB_DEFBUTTON2/i.test(nsh), "default button must be No (MB_DEFBUTTON2)");
  assert.ok(/Also delete your saved library/i.test(nsh), "uninstall prompt text missing");
  assert.ok(/RMDir\s+\/r\s+"\$INSTDIR\\data"/i.test(nsh), "library delete (RMDir /r data) missing");
});

const icoPath = path.join(__dirname, "..", "build", "icon.ico");
t("build/icon.ico exists", () => {
  assert.ok(fs.existsSync(icoPath), "build/icon.ico missing");
});
t("build/icon.ico is a valid ICO (header + non-trivial size)", () => {
  const buf = fs.readFileSync(icoPath);
  // ICO header: reserved=0x0000, type=0x0001 (icon)
  assert.strictEqual(buf.readUInt16LE(0), 0, "ICO reserved field must be 0");
  assert.strictEqual(buf.readUInt16LE(2), 1, "ICO type field must be 1 (icon)");
  assert.ok(buf.readUInt16LE(4) >= 1, "ICO must declare at least one image");
  assert.ok(buf.length > 1000, "ICO unexpectedly tiny");
});
t("package.json win.icon points at build/icon.ico", () => {
  assert.strictEqual(pkg.build.win.icon, "build/icon.ico");
});

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
