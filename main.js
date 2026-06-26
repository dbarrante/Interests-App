const path = require("path");
const { app, BrowserWindow, dialog, shell, ipcMain } = require("electron");
const config = require("./core/config");
const { buildContext } = require("./core/appctx");
const { startServer } = require("./core/server");

let mainWindow = null;
let httpServer = null;

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
    const storeDir = config.getStorePath();

    // ctx for the Core service: opens the live DB at the resolved store path and
    // provides reopen() for restore/move flows (core/appctx.buildContext).
    const ctx = buildContext(storeDir);

    const { server, port } = await startServer(ctx, 3456);
    httpServer = server;

    // Record the chosen port so discovery/relaunch can find it.
    config.saveConfig(Object.assign({}, config.loadConfig(), { port }));

    createWindow(port);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("will-quit", () => {
    if (httpServer) {
      try { httpServer.close(); } catch (_) { /* ignore */ }
    }
  });
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "Interests App",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL("http://127.0.0.1:" + port + "/");
  mainWindow.on("closed", () => { mainWindow = null; });
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
