const path = require("path");
const { app, BrowserWindow, dialog, shell, ipcMain } = require("electron");
const config = require("./core/config");
const { buildContext } = require("./core/appctx");
const { startServer } = require("./core/server");
const sync = require("./core/sync");
const undiciGuard = require("./core/undici-guard");
const { setKV } = require("./core/db");
const { startSyncTimers } = require("./core/synctimers");

// Swallow the benign async undici socket-teardown assertion (`assert(!this.paused)` fired
// from a cancelled/aborted response body during a link sweep) that would otherwise crash
// the main process with a scary dialog. Genuine errors still surface via onFatal.
undiciGuard.installCrashGuard({
  log: function (m) { try { console.warn(m); } catch (e) {} },
  onFatal: function (err) {
    try { dialog.showErrorBox("Interests App — unexpected error", String((err && err.stack) || err) + "\n\nYour data is safe."); } catch (e) {}
    try { app.quit(); } catch (e) {}
  }
});

let mainWindow = null;
let httpServer = null;
let ctx = null;                 // hoisted so will-quit / timers can reach it
let timers = null;              // { stop() } from core/synctimers — hoisted for will-quit

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      // Persist device identity (deviceId/deviceLabel) once, before anything reads
      // sync config — getSyncConfig() is a pure read from here on and must not write.
      config.ensureSyncConfig();

      const storeDir = config.getStorePath();

      // ctx for the Core service: opens the live DB at the resolved store path and
      // provides reopen() for restore/move flows (core/appctx.buildContext).
      // Assign (no const/let) so it binds the module-scope `ctx` that will-quit
      // and the sync timers reach.
      ctx = buildContext(storeDir);

      // Dropbox sync (non-fatal): merge peers + publish before the server serves data.
      try {
        const sc = config.getSyncConfig();
        if (sc.enabled && (sc.dir || sync.defaultSyncDir())) {
          const syncDir = sc.dir || sync.defaultSyncDir();
          sync.runSync(ctx, { syncDir, deviceId: sc.deviceId, deviceLabel: sc.deviceLabel, publish: true });
        }
      } catch (e) { console.error("launch sync skipped:", e && e.message); }   // NEVER hard-fail launch

      // Sync timers self-gate on live config (re-read every tick), so start them
      // unconditionally — enabling/disabling Dropbox sync in Settings takes effect
      // on the next tick with no app restart required.
      timers = startSyncTimers({ ctx, config, sync, setKV, log: console.error });

      const { server, port } = await startServer(ctx, 3456);
      httpServer = server;

      // Record the chosen port so discovery/relaunch can find it.
      config.saveConfig(Object.assign({}, config.loadConfig(), { port }));

      createWindow(port);

      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
      });
    } catch (err) {
      // Never fail silently — a startup error (e.g. an un-writable store or a
      // busy port) must be visible, not an app that "won't open".
      try {
        dialog.showErrorBox(
          "Interests App couldn't start",
          "The app hit an error while starting up:\n\n" +
            String((err && err.stack) || err) +
            "\n\nYour data is safe. Please report this message."
        );
      } catch (_) { /* dialog unavailable */ }
      app.quit();
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("will-quit", () => {
    // Final best-effort publish if a write left the store dirty. Keep it
    // synchronous — Electron does not await will-quit handlers.
    try {
      if (ctx && ctx.syncDirty) {
        const sc = config.getSyncConfig();
        if (sc.enabled) {
          const syncDir = sc.dir || sync.defaultSyncDir();
          if (syncDir) sync.publishSnapshot(ctx, syncDir, sc.deviceId, sc.deviceLabel);
        }
      }
    } catch (e) { /* best-effort */ }
    if (timers) { try { timers.stop(); } catch (e) {} }
    if (httpServer) {
      try { httpServer.close(); } catch (_) { /* ignore */ }
    }
  });
}

function createWindow(port) {
  const origin = "http://127.0.0.1:" + port;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "Interests App",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadURL(origin + "/");
  mainWindow.on("closed", () => { mainWindow = null; });

  // Open external article links (window.open / target=_blank) in the user's real
  // browser, never an in-app window. Deny everything else.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) { shell.openExternal(url).catch(() => {}); }
    return { action: "deny" };
  });

  // Keep the window pinned to the localhost app origin. In-app navigation away
  // from it is blocked; http(s) destinations are routed to the external browser.
  // Compare exact URL origins (not a string prefix) so a look-alike host like
  // http://127.0.0.1:<port>.evil.com cannot masquerade as same-origin.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    let u = null;
    try { u = new URL(url); } catch (e) { u = null; }
    if (u && u.origin === origin) return;   // same-origin nav within the app is fine
    event.preventDefault();
    if (/^https?:/i.test(url)) { shell.openExternal(url).catch(() => {}); }
  });
}

// Native-shell IPC: folder picker + open external link.
ipcMain.handle("ia:pick-folder", async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle("ia:open-external", async (_evt, url) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) {
    await shell.openExternal(url);
    return true;
  }
  return false;
});

// "Reuse window" setting: open a clicked link in ONE in-app window that is reused for
// every click (no browser-tab pile-up). The window is a plain, hardened browser surface
// for UNTRUSTED external pages: no preload (so the page can't reach our IPC), no node,
// context-isolated + sandboxed; child-window opens go to the real browser; only http(s).
let linkWin = null;
ipcMain.handle("ia:open-in-app", (_evt, url) => {
  // Only the main app UI may drive this — never a frame inside the viewer itself.
  if (mainWindow && _evt.senderFrame !== mainWindow.webContents.mainFrame) return false;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return false;
  if (linkWin && !linkWin.isDestroyed()) {
    linkWin.loadURL(url);
    if (linkWin.isMinimized()) linkWin.restore();
    linkWin.show();
    linkWin.focus();
    return true;
  }
  linkWin = new BrowserWindow({
    width: 1100,
    height: 820,
    title: "Interests — link viewer",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // NO preload here: this window shows untrusted external sites and must not have
      // any bridge into the app's IPC / main process.
    },
  });
  // A link inside the viewer that opens a new window goes to the real browser (don't
  // spawn more in-app windows); deny non-http(s).
  linkWin.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/i.test(u)) shell.openExternal(u).catch(() => {});
    return { action: "deny" };
  });
  // Keep the viewer http(s)-only: block a page/redirect that tries to load file:// etc.
  linkWin.webContents.on("will-navigate", (e, u) => { if (!/^https?:\/\//i.test(u)) e.preventDefault(); });
  linkWin.webContents.on("will-redirect", (e, u) => { if (!/^https?:\/\//i.test(u)) e.preventDefault(); });
  linkWin.on("closed", () => { linkWin = null; });
  linkWin.loadURL(url);
  return true;
});
