import * as vscode from "vscode";
import fs from "node:fs/promises";
import path from "node:path";
import { lookupReferenceUrl, metadataToBibEntry, suggestCitationKey } from "../../lib/reference-import.js";
import { ReferenceWorkbenchProvider } from "./referenceWorkbench.js";

const state = {
  serverUrl: "",
  serverStartPromise: null,
  serverModulePromise: null,
  context: null,
  provider: null,
  statusBar: null
};

function installDomMatrixStub() {
  if (typeof globalThis.DOMMatrix !== "undefined") return;
  globalThis.DOMMatrix = class PBLaTexDOMMatrix {
    constructor(init) {
      const values = Array.isArray(init) ? init : [];
      this.a = Number(values[0] ?? 1);
      this.b = Number(values[1] ?? 0);
      this.c = Number(values[2] ?? 0);
      this.d = Number(values[3] ?? 1);
      this.e = Number(values[4] ?? 0);
      this.f = Number(values[5] ?? 0);
      this.m11 = this.a;
      this.m12 = this.b;
      this.m21 = this.c;
      this.m22 = this.d;
      this.m41 = this.e;
      this.m42 = this.f;
    }

    multiplySelf() { return this; }
    preMultiplySelf() { return this; }
    translateSelf() { return this; }
    scaleSelf() { return this; }
    rotateSelf() { return this; }
    invertSelf() { return this; }
    transformPoint(point) { return point; }
  };
}

async function loadServerModule() {
  if (!state.serverModulePromise) {
    installDomMatrixStub();
    state.serverModulePromise = import("../../server.js");
  }
  return state.serverModulePromise;
}

function pickWorkspaceFolder() {
  const editorFolder = vscode.window.activeTextEditor
    ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
    : null;
  return editorFolder || vscode.workspace.workspaceFolders?.[0] || null;
}

async function ensureServer(context) {
  if (state.serverUrl) return state.serverUrl;
  if (state.serverStartPromise) return state.serverStartPromise;
  const activeContext = context || state.context;
  if (!activeContext) {
    throw new Error("PBLaTex is still starting.");
  }
  state.serverStartPromise = (async () => {
    const dataRoot = path.join(activeContext.globalStorageUri.fsPath, "pblatex");
    const projectsRoot = path.join(dataRoot, "projects");
    await fs.mkdir(projectsRoot, { recursive: true });
    const { startServer } = await loadServerModule();
    const started = await startServer({
      port: 0,
      dataRoot,
      projectsRoot,
      storageRoot: dataRoot
    });
    state.serverUrl = started.url;
    return state.serverUrl;
  })();
  try {
    return await state.serverStartPromise;
  } finally {
    state.serverStartPromise = null;
  }
}

async function requestJson(pathname, options = {}) {
  await ensureServer();
  const response = await fetch(`${state.serverUrl}${pathname}`, {
    headers: { "Content-Type": "application/json" },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || payload.message || response.statusText);
  }
  return payload;
}

async function connectWorkspace(workspaceFolder = pickWorkspaceFolder()) {
  if (!workspaceFolder) {
    vscode.window.showInformationMessage("Open a LaTeX workspace first.");
    return null;
  }
  await requestJson("/api/setup", {
    method: "POST",
    body: JSON.stringify({
      source: {
        mode: "local",
        localPath: workspaceFolder.uri.fsPath
      },
      preserveProviders: true
    })
  });
  if (state.statusBar) {
    state.statusBar.text = `PBLaTex: ${workspaceFolder.name}`;
    state.statusBar.tooltip = workspaceFolder.uri.fsPath;
  }
  return workspaceFolder;
}

async function showWorkbenchPage(view = "edit") {
  const workspaceFolder = await connectWorkspace();
  if (!workspaceFolder) return;
  const serverUrl = await ensureServer();
  const target = vscode.Uri.parse(serverUrl).with({
    query: new URLSearchParams({ pblatex: "1", view }).toString()
  });
  const externalTarget = await vscode.env.asExternalUri(target);
  try {
    await vscode.commands.executeCommand("simpleBrowser.show", externalTarget.toString(true));
  } catch {
    await vscode.env.openExternal(externalTarget);
  }
}

async function loadWorkbenchData() {
  try {
    await ensureServer();
    const [project, references] = await Promise.all([
      requestJson("/api/bootstrap"),
      requestJson("/api/references")
    ]);
    return { project, references };
  } catch (error) {
    return {
      project: null,
      references: {
        bibliographyFiles: [],
        entries: [],
        missing: [],
        unused: [],
        duplicates: []
      },
      error: error.message
    };
  }
}

async function loadSidebarData() {
  try {
    await ensureServer();
    return { project: await requestJson("/api/bootstrap") };
  } catch (error) {
    return { project: null, error: error.message };
  }
}

async function refreshWorkbench() {
  if (!state.provider) return;
  await state.provider.refresh();
}

async function insertCitation(key) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || path.extname(editor.document.uri.fsPath).toLowerCase() !== ".tex") {
    vscode.window.showInformationMessage("Open a TeX file first.");
    return;
  }
  await editor.edit((editBuilder) => {
    editBuilder.insert(editor.selection.active, `\\cite{${key}}`);
  });
}

async function addReference() {
  const workbench = await loadWorkbenchData();
  if (!workbench.project?.config?.projectRoot) {
    vscode.window.showInformationMessage("Connect a LaTeX workspace first.");
    return;
  }
  const url = await vscode.window.showInputBox({
    title: "Add Reference",
    prompt: "Paste a DOI or paper URL",
    placeHolder: "https://doi.org/..."
  });
  if (!url) return;
  const metadata = await lookupReferenceUrl(url);
  const existingKeys = (workbench.references.entries || []).map((entry) => entry.key);
  const key = suggestCitationKey(metadata, existingKeys);
  const bibFile = workbench.references.bibliographyFiles?.[0] || "references.bib";
  const entry = metadataToBibEntry(metadata, key);
  await requestJson("/api/references/add", {
    method: "POST",
    body: JSON.stringify({
      bibFile,
      raw: entry.raw,
      key
    })
  });
  await refreshWorkbench();
  vscode.window.showInformationMessage(`Added ${key}`);
}

async function openWorkbench() {
  await showWorkbenchPage("edit");
}

async function reviewActiveDocument() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || path.extname(editor.document.uri.fsPath).toLowerCase() !== ".tex") {
    vscode.window.showInformationMessage("Open a TeX file before running AI review.");
    return;
  }
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (!workspaceFolder) {
    vscode.window.showInformationMessage("Open the TeX file inside a VS Code workspace first.");
    return;
  }
  await connectWorkspace(workspaceFolder);
  const selected = editor.document.getText(editor.selection).trim();
  const content = selected || editor.document.getText();
  const file = path.relative(workspaceFolder.uri.fsPath, editor.document.uri.fsPath).replaceAll("\\", "/");
  const scope = selected ? "selected text" : "current TeX file";
  const result = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Window,
    title: `PBLaTex is reviewing the ${scope}`,
    cancellable: false
  }, () => requestJson("/api/review", {
    method: "POST",
    body: JSON.stringify({ file, content, scope })
  }));
  const report = [
    `# PBLaTex AI Review`,
    "",
    `- File: \`${file}\``,
    `- Scope: ${scope}`,
    "",
    result.report || "No review result was returned."
  ].join("\n");
  const document = await vscode.workspace.openTextDocument({ language: "markdown", content: report });
  await vscode.window.showTextDocument(document, {
    preview: false,
    viewColumn: vscode.ViewColumn.Beside
  });
}

export async function activate(context) {
  state.context = context;
  state.provider = new ReferenceWorkbenchProvider(context.extensionUri, loadSidebarData, {
    refresh: refreshWorkbench,
    insertCitation,
    addReference,
    connectWorkspace: async () => {
      await connectWorkspace();
      await refreshWorkbench();
    },
    openWorkbench,
    openBilingualEditor: () => showWorkbenchPage("edit"),
    openFastPreview: () => showWorkbenchPage("preview"),
    openReferences: () => showWorkbenchPage("references"),
    reviewActiveDocument
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("pblatex.references", state.provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  state.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  state.statusBar.command = "pblatex.openWorkbench";
  state.statusBar.text = "PBLaTex";
  state.statusBar.tooltip = "Open the PBLaTex workbench";
  state.statusBar.show();
  context.subscriptions.push(state.statusBar);

  context.subscriptions.push(vscode.commands.registerCommand("pblatex.openWorkbench", openWorkbench));
  context.subscriptions.push(vscode.commands.registerCommand("pblatex.openBilingualEditor", () => showWorkbenchPage("edit")));
  context.subscriptions.push(vscode.commands.registerCommand("pblatex.openFastPreview", () => showWorkbenchPage("preview")));
  context.subscriptions.push(vscode.commands.registerCommand("pblatex.openReferences", () => showWorkbenchPage("references")));
  context.subscriptions.push(vscode.commands.registerCommand("pblatex.reviewActiveDocument", reviewActiveDocument));
  context.subscriptions.push(vscode.commands.registerCommand("pblatex.refreshReferences", refreshWorkbench));
  context.subscriptions.push(vscode.commands.registerCommand("pblatex.insertCitation", insertCitation));
  context.subscriptions.push(vscode.commands.registerCommand("pblatex.addReference", addReference));
  context.subscriptions.push(vscode.commands.registerCommand("pblatex.connectCurrentWorkspace", async () => {
    await connectWorkspace();
    await refreshWorkbench();
  }));

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (document) => {
    if (![".tex", ".bib"].includes(path.extname(document.uri.fsPath).toLowerCase())) return;
    await refreshWorkbench();
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(async () => {
    await connectWorkspace();
    await refreshWorkbench();
  }));

  void (async () => {
    try {
      await ensureServer(context);
      await connectWorkspace();
      await refreshWorkbench();
    } catch (error) {
      vscode.window.showErrorMessage(`PBLaTex failed to start: ${error.message}`);
    }
  })();
}

export async function deactivate() {
  const serverModule = await state.serverModulePromise?.catch(() => null);
  await serverModule?.stopServer?.().catch(() => {});
}
