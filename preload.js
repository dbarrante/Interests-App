// Minimal, safe bridge. Renderer data access is over HTTP (fetch), not here.
// Only native-shell needs are exposed: pick a folder, open an external link, or open a
// link in a single reused in-app window (the "reuse window" setting).
const { contextBridge, ipcRenderer } = require("electron");

const api = {
  pickFolder: () => ipcRenderer.invoke("ia:pick-folder"),
  openExternal: (url) => ipcRenderer.invoke("ia:open-external", url),
  openInApp: (url) => ipcRenderer.invoke("ia:open-in-app", url),
};

contextBridge.exposeInMainWorld("ia", api);
