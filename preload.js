// Minimal, safe bridge. Renderer data access is over HTTP (fetch), not here.
// Only native-shell needs are exposed: pick a folder, open an external link, or open a
// link in a single reused in-app window (the "reuse window" setting).
const { contextBridge, ipcRenderer } = require("electron");

const api = {
  pickFolder: () => ipcRenderer.invoke("ia:pick-folder"),
  openExternal: (url) => ipcRenderer.invoke("ia:open-external", url),
  openInApp: (url) => ipcRenderer.invoke("ia:open-in-app", url),
  // In-app auto-update: the renderer passes its locally-stored read-only token per check
  // (the token never leaves this machine). Update progress/outcome arrives via onUpdateStatus.
  checkUpdates: (token) => ipcRenderer.invoke("ia:check-updates", token),
  installUpdate: () => ipcRenderer.invoke("ia:install-update"),
  onUpdateStatus: (cb) => {
    const h = (_e, msg) => { try { cb(msg); } catch (e) {} };
    ipcRenderer.on("ia:update-status", h);
    return () => ipcRenderer.removeListener("ia:update-status", h);
  },
};

contextBridge.exposeInMainWorld("ia", api);
