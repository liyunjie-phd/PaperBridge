const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("paperBridgeDesktop", {
  chooseFolder: () => ipcRenderer.invoke("paperbridge:choose-folder"),
  chooseDataFolder: (currentPath) => ipcRenderer.invoke("paperbridge:choose-data-folder", currentPath),
  chooseZip: () => ipcRenderer.invoke("paperbridge:choose-zip"),
  chooseFormatFiles: () => ipcRenderer.invoke("paperbridge:choose-format-files"),
  exportPdf: (defaultName) => ipcRenderer.invoke("paperbridge:export-pdf", defaultName),
  openExternal: (url) => ipcRenderer.invoke("paperbridge:open-external", url),
  onCloseRequest: (callback) => {
    ipcRenderer.on("paperbridge:close-request", async (_event, requestId, save) => {
      try {
        const result = await callback(save === true);
        ipcRenderer.send("paperbridge:close-response", requestId, result);
      } catch (error) {
        ipcRenderer.send("paperbridge:close-response", requestId, {
          ok: false,
          message: error?.message || "保存退出状态时发生未知错误。"
        });
      }
    });
  }
});
