import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import { startServer, stopServer } from "./server.js";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
let mainWindow = null;
let appUrl = "";

function encryptSecret(value) {
  if (!safeStorage.isEncryptionAvailable()) return null;
  return safeStorage.encryptString(value).toString("base64");
}

function decryptSecret(value) {
  if (!safeStorage.isEncryptionAvailable()) return "";
  try {
    return safeStorage.decryptString(Buffer.from(value, "base64"));
  } catch {
    return "";
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 980,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#eef1f3",
    icon: path.join(appRoot, "resources", "icon.png"),
    webPreferences: {
      preload: path.join(appRoot, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith(appUrl)) return;
    event.preventDefault();
    shell.openExternal(url);
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  await mainWindow.loadURL(appUrl);
}

function registerDesktopHandlers() {
  ipcMain.handle("paperbridge:choose-folder", async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
    return result.canceled ? "" : result.filePaths[0];
  });
  ipcMain.handle("paperbridge:choose-zip", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile"],
      filters: [{ name: "Overleaf ZIP", extensions: ["zip"] }]
    });
    return result.canceled ? "" : result.filePaths[0];
  });
  ipcMain.handle("paperbridge:choose-format-files", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "格式材料", extensions: ["doc", "docx", "pdf", "tex", "zip"] },
        { name: "所有文件", extensions: ["*"] }
      ]
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("paperbridge:export-pdf", async (_event, defaultName) => {
    const safeName = String(defaultName || "paper.pdf").replace(/[^a-z0-9._-]/gi, "-") || "paper.pdf";
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath("downloads"), safeName),
      filters: [{ name: "PDF", extensions: ["pdf"] }]
    });
    if (result.canceled || !result.filePath) return "";
    const response = await fetch(`${appUrl}/api/pdf`);
    if (!response.ok) throw new Error("PDF 尚未生成，请先编译论文。");
    await fs.writeFile(result.filePath, Buffer.from(await response.arrayBuffer()));
    return result.filePath;
  });
  ipcMain.handle("paperbridge:open-external", async (_event, url) => {
    if (!/^https:\/\//i.test(String(url || ""))) return false;
    await shell.openExternal(url);
    return true;
  });
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  app.setAppUserModelId("com.paperbridge.desktop");
  registerDesktopHandlers();
  const portableRoot = process.env.PORTABLE_EXECUTABLE_DIR
    ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, "PaperBridge-Data")
    : "";
  const tectonicPath = app.isPackaged
    ? path.join(process.resourcesPath, "bin", "tectonic.exe")
    : path.join(appRoot, "resources", "bin", "tectonic.exe");
  const server = await startServer({
    port: 0,
    dataRoot: process.env.PAPERBRIDGE_DATA_ROOT || (portableRoot ? path.join(portableRoot, "Settings") : app.getPath("userData")),
    projectsRoot: process.env.PAPERBRIDGE_PROJECTS_ROOT || (portableRoot ? path.join(portableRoot, "Projects") : path.join(app.getPath("documents"), "PaperBridge Projects")),
    tectonicPath: process.env.PAPERBRIDGE_TECTONIC_PATH || tectonicPath,
    encryptSecret,
    decryptSecret
  });
  appUrl = server.url;
  await createWindow();
}).catch((error) => {
  dialog.showErrorBox("PaperBridge 无法启动", error.stack || error.message);
  app.quit();
});

app.on("activate", () => {
  if (!mainWindow && appUrl) createWindow();
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  stopServer().catch(() => {});
});
