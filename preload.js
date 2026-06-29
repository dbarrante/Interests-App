// Minimal, safe bridge. Renderer data access is over HTTP (fetch), not here.
// Only native-shell needs are exposed: pick a folder, open an external link, or open a
// link in a single reused in-app window (the "reuse window" setting).
const { contextBridge, ipcRenderer } = require("electron");

const api = {
  pickFolder: () => ipcRenderer.invoke("ia:pick-folder"),
  openExternal: (url) => ipcRenderer.invoke("ia:open-external", url),
  openInApp: (url) => ipcRenderer.invoke("ia:open-in-app", url),
};

// Expose under BOTH names: the renderer references window.ia in some places and
// window.app in others. Aliasing prevents a namespace mismatch from breaking the
// native folder picker (Import legacy backup / Move data location).
contextBridge.exposeInMainWorld("ia", api);
contextBridge.exposeInMainWorld("app", api);
