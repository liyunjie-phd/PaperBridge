import * as pdfjsLib from "/vendor/pdfjs/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";

const state = {
  project: null,
  currentFile: null,
  currentDocument: null,
  warnings: [],
  mode: "edit",
  saveTimers: new Map(),
  pdfRenderToken: 0,
  visiblePdfPage: 1,
  pdfZoom: Math.min(200, Math.max(50, Number(localStorage.getItem("paperBridge.pdfZoom") || 100))),
  pdfPan: null,
  formatFiles: [],
  formatJob: null,
  editorFontSize: Math.min(20, Math.max(14, Number(localStorage.getItem("paperBridge.editorFontSize") || 16))),
  bilingualSplit: Math.min(70, Math.max(30, Number(localStorage.getItem("paperBridge.bilingualSplit") || 50))),
  resizeFrame: 0,
  setupMode: "initial",
  paragraphAnchor: null,
  gitPushResolver: null
};

const elements = {
  projectName: document.querySelector("#projectName"),
  syncState: document.querySelector("#syncState"),
  documentCount: document.querySelector("#documentCount"),
  documentList: document.querySelector("#documentList"),
  translationProgress: document.querySelector("#translationProgress"),
  translationProgressBar: document.querySelector("#translationProgressBar"),
  currentFile: document.querySelector("#currentFile"),
  fileMeta: document.querySelector("#fileMeta"),
  editorFontSize: document.querySelector("#editorFontSize"),
  bilingualHeadings: document.querySelector("#bilingualHeadings"),
  splitHandle: document.querySelector("#splitHandle"),
  segmentList: document.querySelector("#segmentList"),
  pageStatus: document.querySelector("#pageStatus"),
  pageMeterFill: document.querySelector("#pageMeterFill"),
  pdfScroll: document.querySelector("#pdfScroll"),
  visiblePage: document.querySelector("#visiblePage"),
  pdfZoomValue: document.querySelector("#pdfZoomValue"),
  warningCount: document.querySelector("#warningCount"),
  warningList: document.querySelector("#warningList"),
  buildDrawer: document.querySelector("#buildDrawer"),
  editView: document.querySelector("#editView"),
  reviewView: document.querySelector("#reviewView"),
  reviewMeta: document.querySelector("#reviewMeta"),
  reviewSummary: document.querySelector("#reviewSummary"),
  reviewList: document.querySelector("#reviewList"),
  formatView: document.querySelector("#formatView"),
  formatMeta: document.querySelector("#formatMeta"),
  formatRequirements: document.querySelector("#formatRequirements"),
  formatFileList: document.querySelector("#formatFileList"),
  formatAnalysisSection: document.querySelector("#formatAnalysisSection"),
  formatTargetName: document.querySelector("#formatTargetName"),
  formatAnalysisSummary: document.querySelector("#formatAnalysisSummary"),
  formatStatus: document.querySelector("#formatStatus"),
  formatDifferenceList: document.querySelector("#formatDifferenceList"),
  formatWarningList: document.querySelector("#formatWarningList"),
  setupDialog: document.querySelector("#setupDialog"),
  setupForm: document.querySelector("#setupForm"),
  setupMessage: document.querySelector("#setupMessage"),
  dependencyStatus: document.querySelector("#dependencyStatus"),
  settingsDialog: document.querySelector("#settingsDialog"),
  settingsForm: document.querySelector("#settingsForm"),
  paragraphDialog: document.querySelector("#paragraphDialog"),
  paragraphForm: document.querySelector("#paragraphForm"),
  newParagraphChinese: document.querySelector("#newParagraphChinese"),
  gitPushDialog: document.querySelector("#gitPushDialog"),
  gitPushForm: document.querySelector("#gitPushForm"),
  gitPushList: document.querySelector("#gitPushList"),
  toastRegion: document.querySelector("#toastRegion")
};

function refreshIcons() {
  window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } });
}

function fitSegmentRow(row) {
  const textareas = [...row.querySelectorAll(".segment-textarea")];
  if (!textareas.length) return;
  for (const textarea of textareas) textarea.style.height = "auto";
  const height = Math.max(196, ...textareas.map((textarea) => textarea.scrollHeight + 2));
  for (const textarea of textareas) textarea.style.height = `${height}px`;
}

function fitAllSegmentRows() {
  window.cancelAnimationFrame(state.resizeFrame);
  state.resizeFrame = window.requestAnimationFrame(() => {
    elements.segmentList.querySelectorAll(".segment-row").forEach(fitSegmentRow);
  });
}

function applyEditorPreferences(persist = true) {
  document.documentElement.style.setProperty("--editor-font-size", `${state.editorFontSize}px`);
  document.documentElement.style.setProperty("--bilingual-split", `${state.bilingualSplit}%`);
  elements.editorFontSize.textContent = String(state.editorFontSize);
  if (persist) {
    localStorage.setItem("paperBridge.editorFontSize", String(state.editorFontSize));
    localStorage.setItem("paperBridge.bilingualSplit", String(state.bilingualSplit));
  }
  fitAllSegmentRows();
}

function changeEditorFont(delta) {
  state.editorFontSize = Math.min(20, Math.max(14, state.editorFontSize + delta));
  applyEditorPreferences();
}

function setBilingualSplit(clientX) {
  const bounds = elements.bilingualHeadings.getBoundingClientRect();
  const percent = ((clientX - bounds.left) / bounds.width) * 100;
  state.bilingualSplit = Math.min(70, Math.max(30, Math.round(percent * 10) / 10));
  applyEditorPreferences(false);
}

function setupProviderProfile() {
  const selectedModel = document.querySelector("#setupModel").value;
  return {
    type: document.querySelector("#setupProviderType").value,
    model: selectedModel === "__custom__"
      ? document.querySelector("#setupCustomModel").value.trim()
      : selectedModel,
    baseUrl: document.querySelector("#setupBaseUrl").value.trim(),
    apiKey: document.querySelector("#setupApiKey").value.trim(),
    apiPath: "",
    jsonMode: true,
    extraHeaders: ""
  };
}

function updateSetupCustomModel() {
  const custom = document.querySelector("#setupModel").value === "__custom__";
  document.querySelector("#setupCustomModelField").classList.toggle("hidden", !custom);
  document.querySelector("#setupCustomModel").required = custom;
}

function updateSetupModelOptions(type) {
  const model = document.querySelector("#setupModel");
  const previous = model.value;
  const options = type === "openai-compatible"
    ? [
        ["deepseek-v4-flash", "DeepSeek V4 Flash（推荐）"],
        ["deepseek-v4-pro", "DeepSeek V4 Pro"],
        ["__custom__", "其他 / 自定义模型"]
      ]
    : [["__custom__", "自定义模型"]];
  model.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  model.value = options.some(([value]) => value === previous) ? previous : options[0][0];
  updateSetupCustomModel();
}

function setSetupMessage(message = "", type = "") {
  elements.setupMessage.textContent = message;
  elements.setupMessage.className = `setup-message ${type}`.trim();
}

function updateSetupSource() {
  const mode = document.querySelector('input[name="setupSource"]:checked').value;
  document.querySelectorAll("[data-source-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.sourcePanel !== mode);
  });
  const canConnectGit = ["zip", "local"].includes(mode);
  document.querySelector("#setupOptionalGit").classList.toggle("hidden", !canConnectGit);
  if (!canConnectGit) document.querySelector("#setupConnectGit").checked = false;
  updateOptionalGitFields();
}

function updateOptionalGitFields() {
  const enabled = document.querySelector("#setupConnectGit").checked;
  document.querySelector("#setupOptionalGitFields").classList.toggle("hidden", !enabled);
}

function updateSetupProviderDefaults() {
  const type = document.querySelector("#setupProviderType").value;
  updateSetupModelOptions(type);
  const baseUrl = document.querySelector("#setupBaseUrl");
  const knownDefaults = ["", "https://api.deepseek.com", "https://api.anthropic.com", "https://generativelanguage.googleapis.com/v1beta"];
  if (!knownDefaults.includes(baseUrl.value.trim())) return;
  baseUrl.value = type === "anthropic"
    ? "https://api.anthropic.com"
    : type === "gemini"
      ? "https://generativelanguage.googleapis.com/v1beta"
      : "https://api.deepseek.com";
}

function openSetup(project, { switching = false } = {}) {
  state.setupMode = switching ? "switch" : "initial";
  document.querySelector("#setupTitle").textContent = switching ? "添加或切换论文" : "开始使用 PaperBridge";
  document.querySelector("#setupSubtitle").textContent = switching
    ? "打开另一个 Overleaf、Git、ZIP 或本地 LaTeX 项目"
    : "连接论文并配置你的 AI 接口";
  document.querySelector("#setupSubmitLabel").textContent = switching ? "打开论文" : "进入 PaperBridge";
  document.querySelector("#closeSetupButton").classList.toggle("hidden", !switching);
  document.querySelector("#setupAiSection").classList.toggle("hidden", switching);
  document.querySelector("#setupTestButton").classList.toggle("hidden", switching);
  document.querySelector("#setupProjectUrl").value = "";
  document.querySelector("#setupGitUrl").value = "";
  document.querySelector("#setupZipPath").value = "";
  document.querySelector("#setupLocalPath").value = "";
  document.querySelector("#setupLinkedGitUrl").value = "";
  document.querySelector("#setupConnectGit").checked = false;
  const tokenInput = document.querySelector("#setupOverleafToken");
  tokenInput.value = "";
  tokenInput.placeholder = project.config?.hasOverleafToken ? "已保存，留空继续使用" : "";
  for (const prefix of ["setupGit", "setupLinkedGit"]) {
    document.querySelector(`#${prefix}Username`).value = project.config?.gitUsername || "";
    const gitToken = document.querySelector(`#${prefix}Token`);
    gitToken.value = "";
    gitToken.placeholder = project.config?.hasGitToken ? "已保存，留空继续使用" : "公开仓库可以留空";
  }
  document.querySelector("#setupPageLimit").value = project.config?.pageLimit || 14;
  document.querySelector("#setupAutoCompile").checked = project.config?.autoCompile !== false;
  setSetupMessage();
  const compiler = project.dependencies?.compiler;
  elements.dependencyStatus.textContent = compiler === "latexmk"
    ? "排版：本机 LaTeX"
    : compiler === "tectonic"
      ? "排版：内置 Tectonic"
      : "排版组件不可用";
  elements.dependencyStatus.className = `dependency-status ${compiler === "missing" ? "error" : "ready"}`;
  updateSetupSource();
  updateSetupProviderDefaults();
  if (!elements.setupDialog.open) elements.setupDialog.showModal();
}

async function chooseDesktopPath(kind, input) {
  const bridge = window.paperBridgeDesktop;
  if (!bridge) {
    input.readOnly = false;
    input.focus();
    setSetupMessage("请直接输入完整路径。", "");
    return;
  }
  const selected = kind === "zip" ? await bridge.chooseZip() : await bridge.chooseFolder();
  if (selected) input.value = selected;
}

async function testSetupProvider() {
  const button = document.querySelector("#setupTestButton");
  setBusy(button, true);
  setSetupMessage("正在连接 AI 接口...");
  try {
    const result = await api("/api/provider/test-inline", {
      method: "POST",
      body: JSON.stringify({ profile: setupProviderProfile() })
    });
    setSetupMessage(result.ok ? "AI 接口连接成功。" : `接口已响应：${result.response}`, result.ok ? "success" : "error");
  } catch (error) {
    setSetupMessage(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function submitSetup(event) {
  event.preventDefault();
  const button = document.querySelector("#setupSubmitButton");
  const mode = document.querySelector('input[name="setupSource"]:checked').value;
  const translation = setupProviderProfile();
  const source = {
    mode,
    projectUrl: document.querySelector("#setupProjectUrl").value.trim(),
    token: document.querySelector("#setupOverleafToken").value.trim(),
    zipPath: document.querySelector("#setupZipPath").value.trim(),
    localPath: document.querySelector("#setupLocalPath").value.trim(),
    connectGit: ["zip", "local"].includes(mode) && document.querySelector("#setupConnectGit").checked,
    gitUrl: mode === "git"
      ? document.querySelector("#setupGitUrl").value.trim()
      : document.querySelector("#setupLinkedGitUrl").value.trim(),
    gitUsername: mode === "git"
      ? document.querySelector("#setupGitUsername").value.trim()
      : document.querySelector("#setupLinkedGitUsername").value.trim(),
    gitToken: mode === "git"
      ? document.querySelector("#setupGitToken").value.trim()
      : document.querySelector("#setupLinkedGitToken").value.trim()
  };
  setBusy(button, true);
  setSetupMessage(mode === "overleaf"
    ? "正在从 Overleaf 获取论文..."
    : mode === "git"
      ? "正在克隆 Git 仓库..."
      : source.connectGit
        ? "正在导入论文并连接 Git 仓库..."
        : "正在导入论文...");
  try {
    state.project = await api("/api/setup", {
      method: "POST",
      body: JSON.stringify({
        source,
        preserveProviders: state.setupMode === "switch",
        pageLimit: Number(document.querySelector("#setupPageLimit").value),
        autoCompile: document.querySelector("#setupAutoCompile").checked,
        translation,
        review: { ...translation }
      })
    });
    elements.setupDialog.close();
    updateProjectHeader();
    renderDocumentList();
    updatePdf();
    updateWarnings([]);
    if (state.project.documents.length) await loadDocument(state.project.documents[0].file);
    toast(state.setupMode === "switch" ? "已打开新的论文项目，正在生成英文 PDF。" : "论文已经连接，正在生成英文 PDF。", "success");
    await compilePaper();
  } catch (error) {
    setSetupMessage(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

function resizePdfPages() {
  const scale = state.pdfZoom / 100;
  elements.pdfScroll.querySelectorAll(".pdf-page").forEach((canvas) => {
    canvas.style.width = `${Number(canvas.dataset.baseWidth) * scale}px`;
    canvas.style.height = `${Number(canvas.dataset.baseHeight) * scale}px`;
  });
}

function setPdfZoom(nextZoom, { persist = true, preserveViewport = true } = {}) {
  const scroll = elements.pdfScroll;
  const centerX = (scroll.scrollLeft + scroll.clientWidth / 2) / Math.max(scroll.scrollWidth, 1);
  const centerY = (scroll.scrollTop + scroll.clientHeight / 2) / Math.max(scroll.scrollHeight, 1);
  state.pdfZoom = Math.min(200, Math.max(50, Math.round(nextZoom / 10) * 10));
  elements.pdfZoomValue.textContent = `${state.pdfZoom}%`;
  resizePdfPages();
  if (persist) localStorage.setItem("paperBridge.pdfZoom", String(state.pdfZoom));
  if (!preserveViewport) return;
  window.requestAnimationFrame(() => {
    scroll.scrollLeft = centerX * scroll.scrollWidth - scroll.clientWidth / 2;
    scroll.scrollTop = centerY * scroll.scrollHeight - scroll.clientHeight / 2;
  });
}

function beginPdfPan(event) {
  if (event.button !== 0 || !event.target.closest(".pdf-page")) return;
  state.pdfPan = {
    pointerId: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY,
    scrollLeft: elements.pdfScroll.scrollLeft,
    scrollTop: elements.pdfScroll.scrollTop
  };
  elements.pdfScroll.setPointerCapture(event.pointerId);
  elements.pdfScroll.classList.add("panning");
  event.preventDefault();
}

function movePdfPan(event) {
  if (!state.pdfPan || state.pdfPan.pointerId !== event.pointerId) return;
  elements.pdfScroll.scrollLeft = state.pdfPan.scrollLeft - (event.clientX - state.pdfPan.clientX);
  elements.pdfScroll.scrollTop = state.pdfPan.scrollTop - (event.clientY - state.pdfPan.clientY);
  event.preventDefault();
}

function endPdfPan(event) {
  if (!state.pdfPan || state.pdfPan.pointerId !== event.pointerId) return;
  state.pdfPan = null;
  elements.pdfScroll.classList.remove("panning");
  if (elements.pdfScroll.hasPointerCapture(event.pointerId)) elements.pdfScroll.releasePointerCapture(event.pointerId);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed: ${response.status}`);
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function toast(message, type = "success", timeout = 3600) {
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  node.textContent = message;
  elements.toastRegion.append(node);
  window.setTimeout(() => node.remove(), timeout);
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.classList.toggle("busy", busy);
  const icon = button.querySelector("[data-lucide], svg");
  if (busy && icon) {
    button.dataset.previousIcon = icon.getAttribute("data-lucide") || button.dataset.previousIcon || "circle";
    icon.setAttribute("data-lucide", "loader-circle");
  } else if (icon && button.dataset.previousIcon) {
    icon.setAttribute("data-lucide", button.dataset.previousIcon);
  }
  refreshIcons();
}

function confirmUnexpectedLatexCommands(error) {
  if (error.payload?.code !== "UNEXPECTED_LATEX_COMMANDS") return false;
  const commands = error.payload.details?.unexpectedCommands || [];
  return window.confirm([
    "AI 输出新增了原文中没有的 LaTeX 命令：",
    "",
    ...commands,
    "",
    "这些命令不是已知危险命令，但可能改变排版或文件结构。确认写入吗？"
  ].join("\n"));
}

function dangerousLatexMessage(error) {
  const commands = error.payload?.details?.dangerousCommands || [];
  return commands.length
    ? `已阻止危险 LaTeX 命令：${commands.join(", ")}`
    : error.message;
}

function fileLabel(file) {
  return file
    .replace(/\.tex$/i, "")
    .replace(/^\d+_/, "")
    .replaceAll("_", " ");
}

function statusLabel(status) {
  if (status === "synced") return "已对齐";
  if (status === "pending") return "待更新";
  if (status === "english-changed") return "需重译";
  return "无中文";
}

function updateProjectHeader() {
  const config = state.project.config;
  elements.projectName.textContent = `${config.mainTex} · ${config.projectRoot}`;
  const git = state.project.git;
  const hasRemote = Boolean(git.remoteName);
  const remoteLabel = git.overleaf
    ? "Overleaf"
    : git.remoteUrl
      ? (() => {
          try {
            const host = new URL(git.remoteUrl).hostname.toLowerCase();
            if (host.includes("github")) return "GitHub";
            if (host.includes("gitlab")) return "GitLab";
          } catch {
            // Use a generic label for non-HTTP test or local remotes.
          }
          return "Git 远端";
        })()
      : "Git 远端";
  document.querySelector("#pullButton").disabled = !hasRemote;
  document.querySelector("#pushButton").disabled = !hasRemote;
  document.querySelector("#pullButton").title = `从 ${remoteLabel} 拉取最新版本`;
  document.querySelector("#pushButton").title = `编译、提交并推送至 ${remoteLabel}`;
  elements.syncState.className = `sync-state ${git.available ? (git.dirty ? "dirty" : "clean") : "error"}`;
  let syncText = "未连接 Git";
  if (git.available && !hasRemote) syncText = "本地 Git，未连接远端";
  else if (git.dirty) syncText = `${git.changedFiles.length} 个文件待提交`;
  else if (git.behind) syncText = `${remoteLabel} 有 ${git.behind} 次更新`;
  else if (git.ahead) syncText = `${git.ahead} 次提交待推送`;
  else if (hasRemote) syncText = `已与 ${remoteLabel} 对齐`;
  elements.syncState.querySelector("span:last-child").textContent = syncText;
}

function updateTranslationProgress() {
  const documents = state.project.documents;
  const total = documents.reduce((sum, item) => sum + item.segments, 0);
  const translated = documents.reduce((sum, item) => sum + item.translated, 0);
  const percent = total ? Math.round((translated / total) * 100) : 0;
  elements.translationProgress.textContent = `${percent}%`;
  elements.translationProgressBar.style.width = `${percent}%`;
}

function renderDocumentList() {
  const documents = state.project.documents;
  elements.documentCount.textContent = String(documents.length);
  elements.documentList.replaceChildren();
  for (const item of documents) {
    const button = document.createElement("button");
    button.className = `document-button ${item.file === state.currentFile ? "active" : ""}`;
    button.type = "button";
    button.innerHTML = `
      <i data-lucide="file-text"></i>
      <span class="document-label"></span>
      <span class="document-progress"></span>
    `;
    button.querySelector(".document-label").textContent = fileLabel(item.file);
    button.querySelector(".document-progress").textContent = `${item.translated}/${item.segments}`;
    button.addEventListener("click", () => loadDocument(item.file));
    elements.documentList.append(button);
  }
  updateTranslationProgress();
  refreshIcons();
}

async function renderPdf() {
  const token = ++state.pdfRenderToken;
  elements.pdfScroll.innerHTML = '<div class="pdf-loading">正在渲染 PDF...</div>';
  try {
    const pdf = await pdfjsLib.getDocument({ url: `/api/pdf?t=${Date.now()}` }).promise;
    if (token !== state.pdfRenderToken) return;
    elements.pdfScroll.replaceChildren();
    const availableWidth = Math.max(280, elements.pdfScroll.clientWidth - 26);
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (token !== state.pdfRenderToken) return;
      const page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const cssScale = availableWidth / baseViewport.width;
      const viewport = page.getViewport({ scale: cssScale * pixelRatio });
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-page";
      canvas.dataset.page = String(pageNumber);
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.dataset.baseWidth = String(Math.floor(viewport.width / pixelRatio));
      canvas.dataset.baseHeight = String(Math.floor(viewport.height / pixelRatio));
      const zoomScale = state.pdfZoom / 100;
      canvas.style.width = `${Number(canvas.dataset.baseWidth) * zoomScale}px`;
      canvas.style.height = `${Number(canvas.dataset.baseHeight) * zoomScale}px`;
      elements.pdfScroll.append(canvas);
      await page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport }).promise;
      canvas.dataset.rendered = "true";
    }
    state.visiblePdfPage = 1;
    elements.visiblePage.textContent = `1 / ${pdf.numPages}`;
    setPdfZoom(state.pdfZoom, { persist: false, preserveViewport: false });
  } catch (error) {
    if (token !== state.pdfRenderToken) return;
    elements.pdfScroll.innerHTML = '<div class="pdf-loading">PDF 渲染失败</div>';
    toast(error.message, "error");
  }
}

function updatePdf(pdf = state.project?.pdf) {
  if (!pdf?.exists) {
    elements.pageStatus.textContent = "PDF 未生成";
    elements.pageStatus.classList.remove("over-limit");
    elements.pageMeterFill.style.width = "0%";
    elements.pdfScroll.replaceChildren();
    return;
  }
  const limit = Number(state.project.config.pageLimit || 1);
  const over = pdf.pages > limit;
  elements.pageStatus.textContent = `${pdf.pages} / ${limit} 页${over ? ` · 超出 ${pdf.pages - limit} 页` : ""}`;
  elements.pageStatus.classList.toggle("over-limit", over);
  const ratio = Math.min(100, Math.round((pdf.pages / limit) * 100));
  elements.pageMeterFill.style.width = `${ratio}%`;
  elements.pageMeterFill.className = `page-meter-fill ${over ? "danger" : ratio >= 90 ? "warning" : ""}`;
  renderPdf();
}

function updateVisiblePdfPage() {
  const pages = [...elements.pdfScroll.querySelectorAll(".pdf-page")];
  if (!pages.length) return;
  const top = elements.pdfScroll.scrollTop + 18;
  let current = pages[0];
  for (const page of pages) {
    if (page.offsetTop <= top) current = page;
    else break;
  }
  state.visiblePdfPage = Number(current.dataset.page || 1);
  elements.visiblePage.textContent = `${state.visiblePdfPage} / ${pages.length}`;
}

function movePdfPage(delta) {
  const pages = [...elements.pdfScroll.querySelectorAll(".pdf-page")];
  if (!pages.length) return;
  const targetNumber = Math.min(pages.length, Math.max(1, state.visiblePdfPage + delta));
  pages[targetNumber - 1].scrollIntoView({ behavior: "smooth", block: "start" });
  state.visiblePdfPage = targetNumber;
  elements.visiblePage.textContent = `${targetNumber} / ${pages.length}`;
}

function updateWarnings(warnings = [], layoutChanges = []) {
  const layoutWarnings = layoutChanges.map((change) => {
    const kind = change.type === "figure" ? "图" : "表";
    if (change.kind === "moved") return `${kind} ${change.label}：第 ${change.from} 页 → 第 ${change.to} 页`;
    if (change.kind === "added") return `${kind} ${change.label}：新增在第 ${change.to} 页`;
    return `${kind} ${change.label}：从第 ${change.from} 页消失`;
  });
  const combined = [...layoutWarnings, ...warnings];
  state.warnings = combined;
  elements.warningCount.textContent = String(combined.length);
  elements.warningCount.classList.toggle("hidden", combined.length === 0);
  elements.warningList.replaceChildren();
  if (!combined.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "没有编译告警";
    elements.warningList.append(empty);
    return;
  }
  for (const warning of combined) {
    const row = document.createElement("div");
    row.className = "warning-item";
    row.textContent = warning;
    elements.warningList.append(row);
  }
}

function updateBuild(build) {
  if (!build) return;
  if (build.pdf) {
    state.project.pdf = build.pdf;
    updatePdf(build.pdf);
  }
  updateWarnings(build.warnings || [], build.layoutChanges || []);
  if (!build.success && !build.skipped) toast("编译失败，请查看告警。", "error", 5200);
}

async function refreshProject({ preserveDocument = true } = {}) {
  state.project = await api("/api/bootstrap");
  if (state.project.setupRequired) {
    openSetup(state.project);
    return false;
  }
  updateProjectHeader();
  renderDocumentList();
  updatePdf();
  if (!preserveDocument && state.project.documents.length) {
    await loadDocument(state.project.documents[0].file);
  }
  return true;
}

function createSegmentRow(segment) {
  const row = document.createElement("article");
  row.className = "segment-row";
  row.dataset.segmentId = segment.id;
  row.innerHTML = `
    <div class="segment-header">
      <div class="segment-identity">
        <span class="segment-index"></span>
        <span class="line-range"></span>
        <span class="segment-status"></span>
      </div>
      <div class="segment-actions">
        <button class="mini-button add-paragraph-button" type="button" title="在本段前后新增段落"><i data-lucide="plus"></i></button>
        <button class="mini-button translate-button accent" type="button" title="用中文更新英文"><i data-lucide="arrow-right"></i></button>
        <button class="mini-button save-english-button" type="button" title="保存英文修改"><i data-lucide="save"></i></button>
        <button class="mini-button revert-button" type="button" title="恢复已加载的英文"><i data-lucide="undo-2"></i></button>
        <button class="mini-button delete-paragraph-button danger" type="button" title="删除本段"><i data-lucide="trash-2"></i></button>
      </div>
    </div>
    <div class="segment-columns">
      <div class="segment-editor"><textarea class="segment-textarea chinese" lang="zh-CN"></textarea></div>
      <div class="segment-editor"><textarea class="segment-textarea english" lang="en"></textarea></div>
    </div>
  `;

  const status = row.querySelector(".segment-status");
  const chinese = row.querySelector(".chinese");
  const english = row.querySelector(".english");
  const addParagraphButton = row.querySelector(".add-paragraph-button");
  const translateButton = row.querySelector(".translate-button");
  const saveEnglishButton = row.querySelector(".save-english-button");
  const revertButton = row.querySelector(".revert-button");
  const deleteParagraphButton = row.querySelector(".delete-paragraph-button");

  row.querySelector(".segment-index").textContent = `P${String(segment.index + 1).padStart(2, "0")}`;
  row.querySelector(".line-range").textContent = `L${segment.startLine}–${segment.endLine}`;
  status.textContent = statusLabel(segment.translationStatus);
  status.className = `segment-status ${segment.translationStatus}`;
  chinese.value = segment.chinese || "";
  english.value = segment.english;

  chinese.addEventListener("input", () => {
    fitSegmentRow(row);
    chinese.classList.add("changed");
    status.textContent = "待更新英文";
    status.className = "segment-status english-changed";
    window.clearTimeout(state.saveTimers.get(segment.id));
    state.saveTimers.set(segment.id, window.setTimeout(async () => {
      try {
        await api("/api/segment/chinese", {
          method: "POST",
          body: JSON.stringify({ file: segment.file, index: segment.index, chinese: chinese.value })
        });
        chinese.classList.remove("changed");
      } catch (error) {
        toast(error.message, "error");
      }
    }, 700));
  });

  english.addEventListener("input", () => {
    fitSegmentRow(row);
    english.classList.add("changed");
    status.textContent = "英文待保存";
    status.className = "segment-status english-changed";
  });

  translateButton.addEventListener("click", async () => {
    if (!chinese.value.trim()) {
      toast("请先填写中文工作稿。", "error");
      chinese.focus();
      return;
    }
    setBusy(translateButton, true);
    try {
      let approvalToken = "";
      let result;
      while (!result) {
        try {
          result = await api("/api/segment/translate", {
            method: "POST",
            body: JSON.stringify({
              file: segment.file,
              index: segment.index,
              sourceHash: segment.sourceHash,
              chinese: chinese.value,
              approvalToken
            })
          });
        } catch (error) {
          if (confirmUnexpectedLatexCommands(error)) {
            approvalToken = error.payload.details.approvalToken;
            continue;
          }
          throw error;
        }
      }
      state.currentDocument = result.document;
      renderSegments();
      updateBuild(result.build);
      await refreshProject();
      toast("英文段落已更新。", "success");
    } catch (error) {
      const missing = error.payload?.details?.missingTokens;
      toast(
        missing?.length
          ? `模型丢失 LaTeX 标记：${missing.join(", ")}`
          : error.payload?.code === "DANGEROUS_LATEX_COMMANDS"
            ? dangerousLatexMessage(error)
            : error.message,
        "error",
        6200
      );
    } finally {
      setBusy(translateButton, false);
    }
  });

  async function saveEnglish(force = false) {
    setBusy(saveEnglishButton, true);
    try {
      const result = await api("/api/segment/english", {
        method: "POST",
        body: JSON.stringify({
          file: segment.file,
          index: segment.index,
          sourceHash: segment.sourceHash,
          english: english.value,
          chinese: chinese.value,
          force
        })
      });
      state.currentDocument = result.document;
      renderSegments();
      updateBuild(result.build);
      await refreshProject();
      toast("英文修改已保存。", "success");
    } catch (error) {
      if (error.status === 409 && error.payload?.code === "LATEX_TOKEN_LOSS" && !force) {
        const confirmed = window.confirm(`修改删除了 LaTeX 标记：\n${error.payload.details.missingTokens.join("\n")}\n\n仍然保存吗？`);
        if (confirmed) return saveEnglish(true);
      } else {
        toast(error.message, "error", 5200);
      }
    } finally {
      setBusy(saveEnglishButton, false);
    }
  }

  saveEnglishButton.addEventListener("click", () => saveEnglish(false));
  addParagraphButton.addEventListener("click", () => openParagraphDialog(segment));
  revertButton.addEventListener("click", () => {
    english.value = segment.english;
    fitSegmentRow(row);
    english.classList.remove("changed");
    status.textContent = statusLabel(segment.translationStatus);
    status.className = `segment-status ${segment.translationStatus}`;
  });
  deleteParagraphButton.addEventListener("click", async () => {
    const confirmed = window.confirm("删除当前段落会同时移除英文 TeX 内容和中文工作稿，且无法撤销。继续吗？");
    if (!confirmed) return;
    setBusy(deleteParagraphButton, true);
    try {
      const result = await api("/api/segment/delete", {
        method: "POST",
        body: JSON.stringify({
          file: segment.file,
          index: segment.index,
          sourceHash: segment.sourceHash
        })
      });
      state.currentDocument = result.document;
      renderSegments();
      updateBuild(result.build);
      await refreshProject();
      toast("段落已删除。", "success");
    } catch (error) {
      toast(error.payload?.code === "LAST_PARAGRAPH" ? "每个文件至少需要保留一个可编辑正文段落。" : error.message, "error", 5200);
    } finally {
      setBusy(deleteParagraphButton, false);
    }
  });
  return row;
}

function openParagraphDialog(segment) {
  state.paragraphAnchor = segment;
  elements.newParagraphChinese.value = "";
  document.querySelector('input[name="newParagraphPosition"][value="after"]').checked = true;
  document.querySelector("#paragraphAnchorLabel").textContent = `相对于 P${String(segment.index + 1).padStart(2, "0")} 插入`;
  if (!elements.paragraphDialog.open) elements.paragraphDialog.showModal();
  window.requestAnimationFrame(() => elements.newParagraphChinese.focus());
}

function closeParagraphDialog() {
  state.paragraphAnchor = null;
  if (elements.paragraphDialog.open) elements.paragraphDialog.close();
}

async function submitNewParagraph(event) {
  event.preventDefault();
  const anchor = state.paragraphAnchor;
  if (!anchor) return;
  const chinese = elements.newParagraphChinese.value.trim();
  if (!chinese) {
    toast("请先输入新增段落的中文工作稿。", "error");
    elements.newParagraphChinese.focus();
    return;
  }
  const button = document.querySelector("#addParagraphSubmitButton");
  const position = document.querySelector('input[name="newParagraphPosition"]:checked').value;
  setBusy(button, true);
  try {
    let approvalToken = "";
    let result;
    while (!result) {
      try {
        result = await api("/api/segment/add", {
          method: "POST",
          body: JSON.stringify({
            file: anchor.file,
            index: anchor.index,
            sourceHash: anchor.sourceHash,
            chinese,
            position,
            approvalToken
          })
        });
      } catch (error) {
        if (confirmUnexpectedLatexCommands(error)) {
          approvalToken = error.payload.details.approvalToken;
          continue;
        }
        throw error;
      }
    }
    state.currentDocument = result.document;
    closeParagraphDialog();
    renderSegments();
    updateBuild(result.build);
    await refreshProject();
    toast("新段落已生成并插入。", "success");
  } catch (error) {
    const missing = error.payload?.details?.missingTokens;
    toast(
      missing?.length
        ? `模型丢失 LaTeX 标记：${missing.join(", ")}`
        : error.payload?.code === "DANGEROUS_LATEX_COMMANDS"
          ? dangerousLatexMessage(error)
          : error.message,
      "error",
      6200
    );
  } finally {
    setBusy(button, false);
  }
}

function renderSegments() {
  const documentPayload = state.currentDocument;
  elements.currentFile.textContent = fileLabel(documentPayload.file);
  elements.fileMeta.textContent = `${documentPayload.segments.length} 个可编辑段落`;
  elements.segmentList.replaceChildren();
  if (!documentPayload.segments.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "此文件没有检测到可编辑的正文段落";
    elements.segmentList.append(empty);
  } else {
    for (const segment of documentPayload.segments) elements.segmentList.append(createSegmentRow(segment));
  }
  fitAllSegmentRows();
  renderDocumentList();
  refreshIcons();
}

async function loadDocument(file) {
  state.currentFile = file;
  elements.segmentList.innerHTML = '<div class="empty-state">正在读取段落...</div>';
  try {
    state.currentDocument = await api(`/api/document?file=${encodeURIComponent(file)}`);
    renderSegments();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function compilePaper() {
  const button = document.querySelector("#compileButton");
  setBusy(button, true);
  try {
    const build = await api("/api/compile", { method: "POST", body: "{}" });
    updateBuild(build);
    await refreshProject();
    toast(build.success ? "英文 PDF 已重新编译。" : "编译失败。", build.success ? "success" : "error");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function pullPaper() {
  const button = document.querySelector("#pullButton");
  setBusy(button, true);
  try {
    await api("/api/git/pull", { method: "POST", body: "{}" });
    await refreshProject({ preserveDocument: false });
    await compilePaper();
    toast("已拉取远端仓库的最新版本。", "success");
  } catch (error) {
    toast(error.message, "error", 5200);
  } finally {
    setBusy(button, false);
  }
}

function updateGitPushSelectionCount() {
  const checkboxes = [...elements.gitPushList.querySelectorAll('input[type="checkbox"]')];
  const selected = checkboxes.filter((input) => input.checked).length;
  document.querySelector("#gitPushFileCount").textContent = `已选择 ${selected} / ${checkboxes.length}`;
}

function finishGitPushSelection(value) {
  const resolve = state.gitPushResolver;
  state.gitPushResolver = null;
  if (elements.gitPushDialog.open) elements.gitPushDialog.close();
  if (resolve) resolve(value);
}

function chooseGitPushFiles(preview) {
  elements.gitPushList.replaceChildren();
  for (const item of preview.files || []) {
    const label = document.createElement("label");
    label.className = "git-push-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(item.recommended);
    checkbox.disabled = Boolean(item.committed);
    checkbox.dataset.file = item.file;
    checkbox.dataset.recommended = item.recommended ? "true" : "false";
    checkbox.addEventListener("change", updateGitPushSelectionCount);
    const file = document.createElement("span");
    file.className = "git-push-path";
    file.textContent = item.file;
    const kind = document.createElement("span");
    kind.className = `git-push-kind ${item.recommended ? "recommended" : ""}`;
    kind.textContent = item.committed ? "已有提交" : item.recommended ? "推荐" : item.tracked ? "已跟踪" : "其他";
    label.append(checkbox, file, kind);
    elements.gitPushList.append(label);
  }
  document.querySelector("#selectRecommendedGitFiles").checked = true;
  updateGitPushSelectionCount();
  if (!elements.gitPushDialog.open) elements.gitPushDialog.showModal();
  refreshIcons();
  return new Promise((resolve) => {
    state.gitPushResolver = resolve;
  });
}

async function pushPaper() {
  const button = document.querySelector("#pushButton");
  let selection = null;
  setBusy(button, true);
  try {
    const preview = await api("/api/git/push-preview");
    if (preview.required) {
      selection = await chooseGitPushFiles(preview);
      if (!selection) return;
    }
    const result = await api("/api/git/push", {
      method: "POST",
      body: JSON.stringify({
        message: "Update bilingual paper draft",
        confirmed: Boolean(selection),
        files: selection || []
      })
    });
    updateBuild(result.build);
    await refreshProject();
    toast(result.pushed ? "已推送至远端 Git 仓库。" : "没有需要推送的修改。", "success");
  } catch (error) {
    updateBuild(error.payload?.details);
    toast(error.message, "error", 5600);
  } finally {
    setBusy(button, false);
  }
}

async function translateCurrentFile() {
  const button = document.querySelector("#translateFileButton");
  if (!state.currentFile) return;
  setBusy(button, true);
  try {
    state.currentDocument = await api("/api/file/translate-to-chinese", {
      method: "POST",
      body: JSON.stringify({ file: state.currentFile })
    });
    renderSegments();
    await refreshProject();
    toast("当前文件的中文工作稿已更新。", "success");
  } catch (error) {
    toast(error.message, "error", 5600);
  } finally {
    setBusy(button, false);
  }
}

function renderReview(review) {
  elements.reviewSummary.textContent = review.summary || "";
  elements.reviewMeta.textContent = review.createdAt
    ? `${review.issues.length} 项 · ${new Date(review.createdAt).toLocaleString()}`
    : "尚未运行";
  elements.reviewList.replaceChildren();
  if (!review.issues?.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "暂无审校问题";
    elements.reviewList.append(empty);
    return;
  }
  for (const issue of review.issues) {
    const item = document.createElement("article");
    item.className = `review-item ${issue.severity || "low"} ${issue.status === "applied" ? "applied" : ""}`;
    item.innerHTML = `
      <div class="review-header">
        <span class="review-category"></span>
        <span class="review-location"></span>
      </div>
      <div class="review-body">
        <div class="review-message"></div>
        <div class="review-revision"></div>
        <div class="review-actions">
          <button class="button secondary locate-button" type="button"><i data-lucide="locate-fixed"></i><span>定位</span></button>
          <button class="button primary apply-button" type="button"><i data-lucide="check-check"></i><span>应用修改</span></button>
        </div>
      </div>
    `;
    item.querySelector(".review-category").textContent = `${issue.severity || "low"} · ${issue.category || "clarity"}`;
    item.querySelector(".review-location").textContent = issue.id;
    item.querySelector(".review-message").textContent = issue.message || "";
    item.querySelector(".review-revision").textContent = issue.revisedEnglish || "";
    const applyButton = item.querySelector(".apply-button");
    if (issue.status === "applied") applyButton.disabled = true;
    item.querySelector(".locate-button").addEventListener("click", async () => {
      const match = issue.id.match(/^(.*):(\d+)$/);
      if (!match) return;
      setMode("edit");
      await loadDocument(match[1]);
      const row = elements.segmentList.querySelector(`[data-segment-id="${CSS.escape(issue.id)}"]`);
      row?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    applyButton.addEventListener("click", async () => {
      setBusy(applyButton, true);
      try {
        let approveCommands = false;
        let result;
        while (!result) {
          try {
            result = await api("/api/review/apply", {
              method: "POST",
              body: JSON.stringify({ issueId: issue.issueId, approveCommands })
            });
          } catch (error) {
            if (confirmUnexpectedLatexCommands(error)) {
              approveCommands = true;
              continue;
            }
            throw error;
          }
        }
        renderReview(result.review);
        updateBuild(result.build);
        await refreshProject();
        toast("审校修改已应用。", "success");
      } catch (error) {
        toast(error.payload?.code === "DANGEROUS_LATEX_COMMANDS" ? dangerousLatexMessage(error) : error.message, "error", 6200);
      } finally {
        setBusy(applyButton, false);
      }
    });
    elements.reviewList.append(item);
  }
  refreshIcons();
}

async function loadReview() {
  try {
    renderReview(await api("/api/review"));
  } catch (error) {
    toast(error.message, "error");
  }
}

async function runReview() {
  const button = document.querySelector("#runReviewButton");
  setBusy(button, true);
  elements.reviewMeta.textContent = "正在检查全文...";
  try {
    renderReview(await api("/api/review", { method: "POST", body: "{}" }));
    toast("全文英文审校完成。", "success");
  } catch (error) {
    toast(error.message, "error", 5600);
  } finally {
    setBusy(button, false);
  }
}

function formatFileName(filePath) {
  return String(filePath || "").split(/[\\/]/).pop() || "format-file";
}

function renderFormatFiles(files = state.formatFiles.map((file) => ({ name: formatFileName(file), path: file }))) {
  elements.formatFileList.replaceChildren();
  if (!files.length) {
    const empty = document.createElement("div");
    empty.className = "format-empty";
    empty.textContent = "未添加格式文件";
    elements.formatFileList.append(empty);
    return;
  }
  for (const file of files) {
    const row = document.createElement("div");
    row.className = "format-file-row";
    row.innerHTML = `
      <i data-lucide="file-text"></i>
      <span class="format-file-name"></span>
      <span class="format-file-type"></span>
      <button class="mini-button format-remove-button" type="button" title="移除"><i data-lucide="x"></i></button>
    `;
    row.querySelector(".format-file-name").textContent = file.name;
    row.querySelector(".format-file-type").textContent = file.type || file.name.split(".").pop()?.toUpperCase() || "FILE";
    const removeButton = row.querySelector(".format-remove-button");
    if (!file.path) removeButton.classList.add("hidden");
    else removeButton.addEventListener("click", () => {
      state.formatFiles = state.formatFiles.filter((item) => item !== file.path);
      renderFormatFiles();
    });
    elements.formatFileList.append(row);
  }
  refreshIcons();
}

function renderFormatJob(job) {
  state.formatJob = job;
  if (!job) {
    elements.formatAnalysisSection.classList.add("hidden");
    elements.formatMeta.textContent = "尚未分析目标格式";
    return;
  }
  if (!state.formatFiles.length && job.sourceFiles?.length) renderFormatFiles(job.sourceFiles);
  if (job.requirements && !elements.formatRequirements.value) elements.formatRequirements.value = job.requirements;
  if (!job.analysis) {
    elements.formatAnalysisSection.classList.add("hidden");
    elements.formatMeta.textContent = "格式分析未完成";
    return;
  }

  const statusLabels = {
    analyzed: "已分析",
    applying: "正在应用",
    applied: "已应用",
    "awaiting-command-approval": "等待命令确认",
    "apply-failed": "应用失败",
    "analysis-failed": "分析失败"
  };
  elements.formatAnalysisSection.classList.remove("hidden");
  elements.formatTargetName.textContent = job.analysis.targetName;
  elements.formatAnalysisSummary.textContent = job.analysis.summary;
  elements.formatMeta.textContent = `${job.analysis.differences.length} 项格式差异`;
  elements.formatStatus.textContent = statusLabels[job.status] || job.status;
  elements.formatStatus.classList.toggle("failed", job.status.includes("failed"));
  elements.formatDifferenceList.replaceChildren();

  const header = document.createElement("div");
  header.className = "format-difference-row header";
  for (const label of ["项目", "当前格式", "目标格式", "修改动作", "风险"]) {
    const cell = document.createElement("span");
    cell.textContent = label;
    header.append(cell);
  }
  elements.formatDifferenceList.append(header);
  for (const difference of job.analysis.differences) {
    const row = document.createElement("div");
    row.className = "format-difference-row";
    const category = document.createElement("span");
    category.className = "format-category";
    category.textContent = difference.category;
    const current = document.createElement("span");
    current.textContent = difference.current;
    const target = document.createElement("span");
    target.textContent = difference.target;
    const action = document.createElement("span");
    action.textContent = difference.action;
    const risk = document.createElement("span");
    risk.className = `format-risk ${difference.risk}`;
    risk.textContent = difference.risk === "high" ? "高" : difference.risk === "medium" ? "中" : "低";
    row.append(category, current, target, action, risk);
    elements.formatDifferenceList.append(row);
  }

  elements.formatWarningList.replaceChildren();
  for (const warning of job.analysis.warnings || []) {
    const item = document.createElement("div");
    item.textContent = `• ${warning}`;
    elements.formatWarningList.append(item);
  }
  document.querySelector("#applyFormatButton").disabled = job.status === "applying";
}

async function loadLatestFormatJob() {
  try {
    renderFormatJob(await api("/api/format/latest"));
  } catch (error) {
    toast(error.message, "error");
  }
}

async function chooseFormatFiles() {
  if (!window.paperBridgeDesktop) {
    toast("格式文件选择需要桌面版 PaperBridge。", "error");
    return;
  }
  const selected = await window.paperBridgeDesktop.chooseFormatFiles();
  state.formatFiles = [...new Set([...state.formatFiles, ...(selected || [])])];
  renderFormatFiles();
}

async function analyzeTargetFormat() {
  const button = document.querySelector("#analyzeFormatButton");
  const requirements = elements.formatRequirements.value.trim();
  if (!requirements && !state.formatFiles.length) {
    toast("请描述目标格式或添加格式文件。", "error");
    elements.formatRequirements.focus();
    return;
  }
  setBusy(button, true);
  elements.formatMeta.textContent = "正在解析并比较格式...";
  try {
    const job = await api("/api/format/analyze", {
      method: "POST",
      body: JSON.stringify({ requirements, filePaths: state.formatFiles })
    });
    renderFormatJob(job);
    toast("格式差异分析完成。", "success");
  } catch (error) {
    elements.formatMeta.textContent = "格式分析失败";
    toast(error.message, "error", 6800);
  } finally {
    setBusy(button, false);
  }
}

async function applyTargetFormat() {
  if (!state.formatJob?.id) return;
  const confirmed = window.confirm("将按照差异清单修改当前 LaTeX 全文。编译失败时会自动恢复原文件。继续吗？");
  if (!confirmed) return;
  const button = document.querySelector("#applyFormatButton");
  setBusy(button, true);
  elements.formatStatus.textContent = "正在迁移";
  try {
    let approvalToken = "";
    let result;
    while (!result) {
      try {
        result = await api("/api/format/apply", {
          method: "POST",
          body: JSON.stringify({ jobId: state.formatJob.id, approvalToken })
        });
      } catch (error) {
        if (confirmUnexpectedLatexCommands(error)) {
          approvalToken = error.payload.details.approvalToken;
          continue;
        }
        throw error;
      }
    }
    renderFormatJob(result.job);
    updateBuild(result.build);
    await refreshProject({ preserveDocument: false });
    toast(`格式迁移完成，PDF 共 ${result.build.pdf.pages} 页。`, "success", 5200);
  } catch (error) {
    elements.formatStatus.textContent = "应用失败";
    elements.formatStatus.classList.add("failed");
    if (error.payload?.details?.pdf || error.payload?.details?.warnings) updateBuild(error.payload.details);
    toast(error.payload?.code === "DANGEROUS_LATEX_COMMANDS" ? dangerousLatexMessage(error) : error.message, "error", 7600);
    await loadLatestFormatJob();
  } finally {
    setBusy(button, false);
  }
}

async function exportPdf() {
  const name = state.project?.config?.mainTex?.replace(/\.tex$/i, ".pdf") || "paper.pdf";
  try {
    if (window.paperBridgeDesktop) {
      const destination = await window.paperBridgeDesktop.exportPdf(name);
      if (destination) toast(`PDF 已导出到 ${destination}`, "success", 5200);
      return;
    }
    const link = document.createElement("a");
    link.href = "/api/pdf";
    link.download = name;
    link.click();
  } catch (error) {
    toast(error.message, "error");
  }
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll(".mode-button").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  elements.editView.classList.toggle("hidden", mode !== "edit");
  elements.reviewView.classList.toggle("hidden", mode !== "review");
  elements.formatView.classList.toggle("hidden", mode !== "format");
  if (mode === "review") loadReview();
  if (mode === "format") loadLatestFormatJob();
}

function providerMarkup(prefix) {
  return `
    <label class="field">
      <span>接口类型</span>
      <select id="${prefix}Type">
        <option value="openai-compatible">OpenAI-compatible</option>
        <option value="anthropic">Anthropic Messages</option>
        <option value="gemini">Gemini GenerateContent</option>
      </select>
    </label>
    <label class="field">
      <span>模型</span>
      <input id="${prefix}Model" type="text" autocomplete="off">
    </label>
    <label class="field wide">
      <span>Base URL</span>
      <input id="${prefix}BaseUrl" type="text" autocomplete="off">
    </label>
    <label class="field">
      <span>API Key</span>
      <input id="${prefix}ApiKey" type="password" autocomplete="new-password">
    </label>
    <label class="field">
      <span>自定义路径</span>
      <input id="${prefix}ApiPath" type="text" autocomplete="off" placeholder="可留空">
    </label>
    <label class="field wide">
      <span>附加 Headers (JSON)</span>
      <input id="${prefix}ExtraHeaders" type="text" autocomplete="off" placeholder='{"X-Provider-Key":"..."}'>
    </label>
    <label class="toggle-row field wide">
      <input id="${prefix}JsonMode" type="checkbox">
      <span>接口支持 JSON response_format</span>
    </label>
  `;
}

function fillProvider(prefix, profile) {
  document.querySelector(`#${prefix}Type`).value = profile.type || "openai-compatible";
  document.querySelector(`#${prefix}Model`).value = profile.model || "";
  document.querySelector(`#${prefix}BaseUrl`).value = profile.baseUrl || "";
  document.querySelector(`#${prefix}ApiKey`).value = "";
  document.querySelector(`#${prefix}ApiKey`).placeholder = profile.hasApiKey ? "已保存，留空保持不变" : "";
  document.querySelector(`#${prefix}ApiPath`).value = profile.apiPath || "";
  document.querySelector(`#${prefix}ExtraHeaders`).value = profile.extraHeaders || "";
  document.querySelector(`#${prefix}JsonMode`).checked = Boolean(profile.jsonMode);
}

function collectProvider(prefix) {
  return {
    type: document.querySelector(`#${prefix}Type`).value,
    model: document.querySelector(`#${prefix}Model`).value.trim(),
    baseUrl: document.querySelector(`#${prefix}BaseUrl`).value.trim(),
    apiKey: document.querySelector(`#${prefix}ApiKey`).value.trim(),
    apiPath: document.querySelector(`#${prefix}ApiPath`).value.trim(),
    extraHeaders: document.querySelector(`#${prefix}ExtraHeaders`).value.trim(),
    jsonMode: document.querySelector(`#${prefix}JsonMode`).checked
  };
}

function openSettings() {
  const config = state.project.config;
  document.querySelector("#projectRootInput").value = config.projectRoot;
  const overleafToken = document.querySelector("#overleafTokenInput");
  overleafToken.value = "";
  overleafToken.placeholder = config.hasOverleafToken ? "已保存，留空保持不变" : "用于自动拉取和推送";
  document.querySelector("#gitUsernameInput").value = config.gitUsername || "";
  const gitToken = document.querySelector("#gitTokenInput");
  gitToken.value = "";
  gitToken.placeholder = config.hasGitToken ? "已保存，留空保持不变" : "私有仓库使用 Personal Access Token";
  document.querySelector("#mainTexInput").value = config.mainTex;
  document.querySelector("#pageLimitInput").value = config.pageLimit;
  document.querySelector("#autoCompileInput").checked = config.autoCompile;
  document.querySelectorAll(".provider-grid").forEach((container) => {
    const prefix = container.dataset.provider;
    container.innerHTML = providerMarkup(prefix);
    fillProvider(prefix, config[prefix]);
  });
  refreshIcons();
  elements.settingsDialog.showModal();
}

async function saveSettings({ close = true } = {}) {
  const previous = state.project.config;
  const projectRoot = document.querySelector("#projectRootInput").value.trim();
  const mainTex = document.querySelector("#mainTexInput").value.trim();
  const next = await api("/api/config", {
    method: "POST",
    body: JSON.stringify({
      pageLimit: Number(document.querySelector("#pageLimitInput").value),
      autoCompile: document.querySelector("#autoCompileInput").checked,
      overleafToken: document.querySelector("#overleafTokenInput").value.trim(),
      gitUsername: document.querySelector("#gitUsernameInput").value.trim(),
      gitToken: document.querySelector("#gitTokenInput").value.trim(),
      translation: collectProvider("translation"),
      review: collectProvider("review")
    })
  });
  if (projectRoot !== previous.projectRoot || mainTex !== previous.mainTex) {
    await api("/api/project/open", {
      method: "POST",
      body: JSON.stringify({ projectRoot, mainTex })
    });
  }
  state.project.config = next;
  await refreshProject({ preserveDocument: false });
  if (close) elements.settingsDialog.close();
  toast("设置已保存。", "success");
}

async function testProvider(purpose, button) {
  setBusy(button, true);
  try {
    await saveSettings({ close: false });
    const result = await api("/api/provider/test", {
      method: "POST",
      body: JSON.stringify({ purpose })
    });
    toast(result.ok ? "接口连接成功。" : `接口已响应：${result.response}`, result.ok ? "success" : "error");
  } catch (error) {
    toast(error.message, "error", 5600);
  } finally {
    setBusy(button, false);
  }
}

function bindEvents() {
  document.querySelector("#compileButton").addEventListener("click", compilePaper);
  document.querySelector("#pullButton").addEventListener("click", pullPaper);
  document.querySelector("#pushButton").addEventListener("click", pushPaper);
  document.querySelector("#translateFileButton").addEventListener("click", translateCurrentFile);
  document.querySelector("#decreaseFontButton").addEventListener("click", () => changeEditorFont(-1));
  document.querySelector("#increaseFontButton").addEventListener("click", () => changeEditorFont(1));
  elements.splitHandle.addEventListener("pointerdown", (event) => {
    elements.splitHandle.setPointerCapture(event.pointerId);
    document.body.classList.add("split-dragging");
    setBilingualSplit(event.clientX);
  });
  elements.splitHandle.addEventListener("pointermove", (event) => {
    if (!elements.splitHandle.hasPointerCapture(event.pointerId)) return;
    setBilingualSplit(event.clientX);
  });
  elements.splitHandle.addEventListener("pointerup", (event) => {
    if (elements.splitHandle.hasPointerCapture(event.pointerId)) elements.splitHandle.releasePointerCapture(event.pointerId);
    document.body.classList.remove("split-dragging");
    localStorage.setItem("paperBridge.bilingualSplit", String(state.bilingualSplit));
  });
  elements.splitHandle.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    state.bilingualSplit = Math.min(70, Math.max(30, state.bilingualSplit + (event.key === "ArrowRight" ? 2 : -2)));
    applyEditorPreferences();
  });
  document.querySelector("#runReviewButton").addEventListener("click", runReview);
  document.querySelector("#settingsButton").addEventListener("click", openSettings);
  document.querySelector("#addProjectButton").addEventListener("click", () => openSetup(state.project, { switching: true }));
  document.querySelector("#closeSetupButton").addEventListener("click", () => elements.setupDialog.close());
  document.querySelector("#addFormatFilesButton").addEventListener("click", chooseFormatFiles);
  document.querySelector("#analyzeFormatButton").addEventListener("click", analyzeTargetFormat);
  document.querySelector("#applyFormatButton").addEventListener("click", applyTargetFormat);
  document.querySelectorAll('input[name="setupSource"]').forEach((input) => input.addEventListener("change", updateSetupSource));
  document.querySelector("#setupConnectGit").addEventListener("change", updateOptionalGitFields);
  document.querySelector("#setupProviderType").addEventListener("change", updateSetupProviderDefaults);
  document.querySelector("#setupModel").addEventListener("change", updateSetupCustomModel);
  document.querySelector("#chooseZipButton").addEventListener("click", () => chooseDesktopPath("zip", document.querySelector("#setupZipPath")));
  document.querySelector("#chooseLocalButton").addEventListener("click", () => chooseDesktopPath("folder", document.querySelector("#setupLocalPath")));
  document.querySelector("#chooseSettingsFolderButton").addEventListener("click", async () => {
    const input = document.querySelector("#projectRootInput");
    await chooseDesktopPath("folder", input);
    if (input.value) document.querySelector("#mainTexInput").value = "";
  });
  const openOverleafTokenPage = () => {
    const url = "https://cn.overleaf.com/user/settings";
    if (window.paperBridgeDesktop) window.paperBridgeDesktop.openExternal(url);
    else window.open(url, "_blank", "noopener");
  };
  document.querySelector("#openOverleafTokenButton").addEventListener("click", openOverleafTokenPage);
  document.querySelector("#openSettingsOverleafTokenButton").addEventListener("click", openOverleafTokenPage);
  document.querySelector("#setupTestButton").addEventListener("click", testSetupProvider);
  elements.setupForm.addEventListener("submit", submitSetup);
  elements.paragraphForm.addEventListener("submit", submitNewParagraph);
  document.querySelector("#closeParagraphButton").addEventListener("click", closeParagraphDialog);
  document.querySelector("#cancelParagraphButton").addEventListener("click", closeParagraphDialog);
  elements.paragraphDialog.addEventListener("close", () => {
    state.paragraphAnchor = null;
  });
  document.querySelector("#selectRecommendedGitFiles").addEventListener("change", (event) => {
    elements.gitPushList.querySelectorAll('input[data-recommended="true"]').forEach((input) => {
      if (!input.disabled) input.checked = event.currentTarget.checked;
    });
    updateGitPushSelectionCount();
  });
  elements.gitPushForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const files = [...elements.gitPushList.querySelectorAll('input[type="checkbox"]:checked')]
      .map((input) => input.dataset.file);
    if (!files.length) {
      toast("请至少选择一个需要上传的论文文件。", "error");
      return;
    }
    finishGitPushSelection(files);
  });
  document.querySelector("#closeGitPushButton").addEventListener("click", () => finishGitPushSelection(null));
  document.querySelector("#cancelGitPushButton").addEventListener("click", () => finishGitPushSelection(null));
  elements.gitPushDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finishGitPushSelection(null);
  });
  document.querySelector("#refreshPdfButton").addEventListener("click", renderPdf);
  document.querySelector("#exportPdfButton").addEventListener("click", exportPdf);
  document.querySelector("#previousPageButton").addEventListener("click", () => movePdfPage(-1));
  document.querySelector("#nextPageButton").addEventListener("click", () => movePdfPage(1));
  document.querySelector("#zoomOutButton").addEventListener("click", () => setPdfZoom(state.pdfZoom - 10));
  document.querySelector("#zoomInButton").addEventListener("click", () => setPdfZoom(state.pdfZoom + 10));
  elements.pdfZoomValue.addEventListener("click", () => setPdfZoom(100));
  elements.pdfScroll.addEventListener("pointerdown", beginPdfPan);
  elements.pdfScroll.addEventListener("pointermove", movePdfPan);
  elements.pdfScroll.addEventListener("pointerup", endPdfPan);
  elements.pdfScroll.addEventListener("pointercancel", endPdfPan);
  elements.pdfScroll.addEventListener("lostpointercapture", endPdfPan);
  elements.pdfScroll.addEventListener("scroll", updateVisiblePdfPage, { passive: true });
  document.querySelector("#warningsButton").addEventListener("click", () => elements.buildDrawer.classList.toggle("hidden"));
  document.querySelector("#closeWarningsButton").addEventListener("click", () => elements.buildDrawer.classList.add("hidden"));
  document.querySelectorAll(".mode-button").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
  elements.settingsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveSettings();
    } catch (error) {
      toast(error.message, "error", 5200);
    }
  });
  document.querySelector("#testTranslationButton").addEventListener("click", (event) => testProvider("translation", event.currentTarget));
  document.querySelector("#testReviewButton").addEventListener("click", (event) => testProvider("review", event.currentTarget));
}

async function initialize() {
  bindEvents();
  renderFormatFiles();
  applyEditorPreferences(false);
  setPdfZoom(state.pdfZoom, { persist: false, preserveViewport: false });
  refreshIcons();
  try {
    const ready = await refreshProject({ preserveDocument: false });
    updateWarnings([]);
    if (ready) await loadReview();
  } catch (error) {
    toast(error.message, "error", 8000);
    elements.segmentList.innerHTML = '<div class="empty-state">无法打开论文项目</div>';
  }
}

initialize();
