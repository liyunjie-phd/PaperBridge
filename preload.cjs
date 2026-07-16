const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("paperBridgeDesktop", {
  chooseFolder: () => ipcRenderer.invoke("paperbridge:choose-folder"),
  chooseDataFolder: (currentPath) => ipcRenderer.invoke("paperbridge:choose-data-folder", currentPath),
  chooseZip: () => ipcRenderer.invoke("paperbridge:choose-zip"),
  chooseFormatFiles: () => ipcRenderer.invoke("paperbridge:choose-format-files"),
  exportPdf: (defaultName) => ipcRenderer.invoke("paperbridge:export-pdf", defaultName),
  openExternal: (url) => ipcRenderer.invoke("paperbridge:open-external", url)
});
