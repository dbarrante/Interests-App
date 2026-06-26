---
name: release
description: Build a shareable Windows installer for the Interests App (test gate, native rebuild for Electron, electron-builder NSIS). User-invoked only.
disable-model-invocation: true
---

# Release — build the Interests App installer

Run this when the user asks to cut a build/installer. Execute the steps in order and stop on the first failure, reporting it plainly.

## Preconditions
- `package.json` exists with the `test`, `rebuild`, and `dist` scripts and the electron-builder `build` config (NSIS assisted wizard: `oneClick:false`, `allowToChangeInstallationDirectory:true`, `perMachine:false`, custom `build/installer.nsh`).
- Dependencies installed (`npm install`). If `node_modules` is missing, run `npm install` first.

## Steps
1. **Test gate** — `npm test` (runs `node tests/run.js`: the inline-`<script>` syntax gate plus every `tests/*.test.js`). If anything fails, STOP and report — do not build on red.
2. **Native rebuild** — `npm run rebuild` (`electron-rebuild -f -w better-sqlite3`). `better-sqlite3` is a native module; the test run uses the Node ABI, but the packaged app needs it rebuilt for Electron's ABI. Skipping this yields an installer that crashes on launch with a NODE_MODULE_VERSION mismatch.
3. **Package** — `npm run dist` (`electron-builder`). Produces the NSIS installer under `dist/`.
4. **Report** — print the installer path (e.g. `dist/Interests App Setup <version>.exe`) and its size.

## Tell the user
- The installer is **unsigned** (no paid certificate). On first run Windows SmartScreen shows *"Windows protected your PC / unknown publisher"* — they (and anyone they share it with) click **More info → Run anyway**. This is expected, not a failure.
- The build does **not** auto-update; a new version means sending a new installer.
- The `data/` store is **excluded** from the package (it's the user's live library, not shippable). Confirm `dist/` and `data/` are gitignored before any commit.

## Do not
- Do not bump the version, tag, or push without the user asking.
- Do not run this on a branch with failing tests.
