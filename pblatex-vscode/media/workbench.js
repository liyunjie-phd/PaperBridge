(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById("app");
  let state = JSON.parse(root?.dataset.initial || "{}");

  root.innerHTML = `
    <header class="header">
      <div class="brand-row">
        <strong>PBLaTex</strong>
        <span class="status-dot" title="PBLaTex 已启动"></span>
      </div>
      <div class="project-path" id="projectPath"></div>
    </header>
    <div class="actions">
      <button class="primary" data-action="openWorkbench">打开工作台</button>
      <button class="secondary" data-action="connectWorkspace">连接当前项目</button>
    </div>
    <div class="action-status" id="actionStatus" role="status" aria-live="polite"></div>
  `;

  const projectPath = document.getElementById("projectPath");
  const actionStatus = document.getElementById("actionStatus");

  function render() {
    const projectRoot = state?.project?.config?.projectRoot || "";
    const mainTex = state?.project?.config?.mainTex || "";
    projectPath.textContent = projectRoot
      ? `${projectRoot}${mainTex ? ` / ${mainTex}` : ""}`
      : "尚未连接项目";
    projectPath.title = projectPath.textContent;
  }

  function setPending(type, pending) {
    const button = document.querySelector(`[data-action="${type}"]`);
    if (button) button.disabled = pending;
  }

  function runAction(type) {
    setPending(type, true);
    actionStatus.textContent = type === "connectWorkspace" ? "正在连接当前项目..." : "正在打开工作台...";
    actionStatus.className = "action-status busy";
    vscode.postMessage({ type });
  }

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => runAction(button.dataset.action));
  });

  window.addEventListener("message", (event) => {
    const message = event.data || {};
    if (message.type === "setData") {
      state = message.data || {};
      render();
      return;
    }
    if (message.type === "actionComplete") {
      setPending(message.action, false);
      actionStatus.textContent = message.action === "connectWorkspace" ? "当前项目已连接" : "";
      actionStatus.className = "action-status success";
      return;
    }
    if (message.type === "actionError") {
      setPending(message.action, false);
      actionStatus.textContent = message.message || "操作失败";
      actionStatus.className = "action-status error";
    }
  });

  render();
})();
