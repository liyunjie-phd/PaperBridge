import * as vscode from "vscode";

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function renderHtml(extensionUri, view, data) {
  const stylesheet = view.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "workbench.css"));
  const script = view.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "workbench.js"));
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src ${view.webview.cspSource};
    script-src ${view.webview.cspSource};
  ">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${stylesheet}">
</head>
<body>
  <div id="app" data-initial="${escapeHtml(safeJson(data || {}))}"></div>
  <script src="${script}"></script>
</body>
</html>`;
}

export class ReferenceWorkbenchProvider {
  constructor(extensionUri, getData, callbacks = {}) {
    this.extensionUri = extensionUri;
    this.getData = getData;
    this.callbacks = callbacks;
    this.view = null;
    this.data = null;
  }

  async refresh() {
    this.data = await this.getData();
    if (this.view) {
      this.view.webview.postMessage({ type: "setData", data: this.data });
    }
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")]
    };
    view.webview.html = renderHtml(this.extensionUri, view, this.data || {});
    view.webview.onDidReceiveMessage(async (message) => {
      try {
        if (message.type === "refresh") {
          await this.callbacks.refresh?.();
        } else if (message.type === "insertCitation") {
          await this.callbacks.insertCitation?.(message.key);
        } else if (message.type === "addReference") {
          await this.callbacks.addReference?.();
        } else if (message.type === "connectWorkspace") {
          await this.callbacks.connectWorkspace?.();
        } else if (message.type === "openWorkbench") {
          await this.callbacks.openWorkbench?.();
        } else if (message.type === "openBilingualEditor") {
          await this.callbacks.openBilingualEditor?.();
        } else if (message.type === "openFastPreview") {
          await this.callbacks.openFastPreview?.();
        } else if (message.type === "openReferences") {
          await this.callbacks.openReferences?.();
        } else if (message.type === "reviewActiveDocument") {
          await this.callbacks.reviewActiveDocument?.();
        }
        view.webview.postMessage({ type: "actionComplete", action: message.type });
      } catch (error) {
        view.webview.postMessage({ type: "actionError", action: message.type, message: error.message });
      }
    });
  }
}
