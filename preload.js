// Minimal, safe bridge. Renderer data access is over HTTP (fetch), not here.
// Only native-shell needs are exposed: pick a folder, open an external link.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ia", {
  pickFolder: () => ipcRenderer.invoke("ia:pick-folder"),
  openExternal: (url) => ipcRenderer.invoke("ia:open-external", url),
});
