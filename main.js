const path = require("path");
const { app, BrowserWindow, dialog, shell, ipcMain } = require("electron");
const config = require("./core/config");
const { buildContext } = require("./core/appctx");
const { startServer } = require("./core/server");
const sync = require("./core/sync");
const { createAsyncSync } = require("./core/syncworker");
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

      // All periodic/launch/manual sync cycles run OFF the main process via a
      // worker-thread façade — a synchronous merge on the main process froze
      // every window into "Not responding" (live 2026-07-18). Same call
      // shapes, async results; one cycle at a time.
      const asyncSync = createAsyncSync(storeDir);
      ctx.syncRunner = asyncSync;   // POST /api/sync/now uses this when present

      // Sync timers self-gate on live config (re-read every tick), so start them
      // unconditionally — enabling/disabling Dropbox sync in Settings takes effect
      // on the next tick with no app restart required.
      timers = startSyncTimers({ ctx, config, sync: asyncSync, setKV, log: console.error });

      const { server, port } = await startServer(ctx, 3456);
      httpServer = server;

      // Record the chosen port so discovery/relaunch can find it.
      config.saveConfig(Object.assign({}, config.loadConfig(), { port }));

      createWindow(port);

      // Launch merge AFTER the window exists. It used to run synchronously
      // BEFORE the server/window: with a big peer delta the app showed no
      // window at all for the whole merge — "clicking does nothing" — and the
      // single-instance lock made a second click a silent no-op (live
      // complaint 2026-07-18). The renderer boots from the local store
      // immediately; the launch merge lands like any timer merge, signalled
      // via ia_sync_changed_at so the "updates synced" toast + rehydrate fire.
      setTimeout(() => {
        try {
          const sc = config.getSyncConfig();
          if (sc.enabled && (sc.dir || sync.defaultSyncDir())) {
            const syncDir = sc.dir || sync.defaultSyncDir();
            asyncSync.runSync(ctx, { syncDir, deviceId: sc.deviceId, deviceLabel: sc.deviceLabel, publish: true })
              .then((res) => {
                if (res && res.ok === false) { console.error("launch sync failed:", res.error); return; }
                if (res && res.changed) { try { setKV(ctx.db, "ia_sync_changed_at", String(Date.now())); } catch (e) {} }
              });
          }
        } catch (e) { console.error("launch sync failed:", e && e.message); }   // NEVER hard-fail launch
      }, 3000);

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

// ---- In-app auto-update ---------------------------------------------------
// electron-updater against the PRIVATE GitHub repo. The renderer passes a user-supplied
// fine-grained READ-ONLY token per check (stored only in the user's local settings, never
// here, never synced, never in the packaged app). We lazy-require electron-updater so dev
// runs — which short-circuit before any updater call — never touch it.
let _updater = null, _updaterWired = false;
function getUpdater() {
  if (_updater) return _updater;
  try { _updater = require("electron-updater").autoUpdater; }
  catch (e) { return null; }
  _updater.autoDownload = true;
  _updater.autoInstallOnAppQuit = true;
  if (!_updaterWired) {
    _updaterWired = true;
    const send = (status, data) => {
      try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("ia:update-status", { status, data }); }
      catch (e) { /* window gone */ }
    };
    _updater.on("update-available", (i) => send("available", { version: i && i.version }));
    _updater.on("update-not-available", () => send("none", {}));
    _updater.on("download-progress", (p) => send("progress", { percent: Math.round((p && p.percent) || 0) }));
    _updater.on("update-downloaded", (i) => send("downloaded", { version: i && i.version }));
    _updater.on("error", (err) => send("error", { message: String((err && err.message) || err) }));
  }
  return _updater;
}

ipcMain.handle("ia:check-updates", async (_evt, token) => {
  if (!app.isPackaged) return { ok: false, reason: "dev" };
  if (typeof token !== "string" || !token.trim()) return { ok: false, reason: "no-token" };
  const up = getUpdater();
  if (!up) return { ok: false, reason: "error", message: "Updater unavailable" };
  try {
    up.setFeedURL({ provider: "github", owner: "dbarrante", repo: "Interests-App", private: true, token: token.trim() });
    await up.checkForUpdates();
    return { ok: true };   // result arrives asynchronously via the "ia:update-status" events
  } catch (e) {
    return { ok: false, reason: "error", message: String((e && e.message) || e) };
  }
});

ipcMain.handle("ia:install-update", () => {
  if (!_updater) return false;
  try { _updater.quitAndInstall(); return true; } catch (e) { return false; }
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
