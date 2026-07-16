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
  pdfDocument: null,
  pdfObserver: null,
  pdfPageRenderTasks: new Map(),
  pdfTextLayers: new Map(),
  visiblePdfPage: 1,
  pdfZoom: Math.min(300, Math.max(50, Number(localStorage.getItem("paperBridge.pdfZoom") || 100))),
  pdfPan: null,
  pdfRenderTimer: 0,
  pdfResizeFrame: 0,
  pendingPdfResizeAnchor: null,
  pdfParagraphIndex: null,
  pdfParagraphIndexPromise: null,
  pdfSourceIndex: null,
  pdfSourceIndexPromise: null,
  pdfNavigationToken: 0,
  pdfNavigationBusy: false,
  buildPreviewAvailable: null,
  formatFiles: [],
  formatJob: null,
  editorFontSize: Math.min(20, Math.max(14, Number(localStorage.getItem("paperBridge.editorFontSize") || 16))),
  bilingualSplit: Math.min(70, Math.max(30, Number(localStorage.getItem("paperBridge.bilingualSplit") || 50))),
  workspaceSplit: Math.min(72, Math.max(32, Number(localStorage.getItem("paperBridge.workspaceSplit") || 54))),
  resizeFrame: 0,
  setupMode: "initial",
  paragraphAnchor: null,
  gitPushResolver: null,
  currentSectionId: null,
  mainTexResolver: null,
  sourceFile: null,
  sourceHash: "",
  sourceEol: "\n",
  sourceSavedContent: "",
  sourceDirty: false,
  structurePreview: null,
  formatPreflightPreview: null,
  formatPreflightResolver: null,
  compileDiagnosisToken: 0,
  compileDiagnosisFingerprint: ""
};

const elements = {
  workspace: document.querySelector(".workspace"),
  sidebar: document.querySelector(".sidebar"),
  projectName: document.querySelector("#projectName"),
  syncState: document.querySelector("#syncState"),
  documentCount: document.querySelector("#documentCount"),
  documentList: document.querySelector("#documentList"),
  translationProgress: document.querySelector("#translationProgress"),
  translationProgressBar: document.querySelector("#translationProgressBar"),
  fileTranslationProgress: document.querySelector("#fileTranslationProgress"),
  fileTranslationProgressLabel: document.querySelector("#fileTranslationProgressLabel"),
  fileTranslationProgressCount: document.querySelector("#fileTranslationProgressCount"),
  fileTranslationProgressTrack: document.querySelector("#fileTranslationProgressTrack"),
  fileTranslationProgressBar: document.querySelector("#fileTranslationProgressBar"),
  currentFile: document.querySelector("#currentFile"),
  fileMeta: document.querySelector("#fileMeta"),
  editorFontSize: document.querySelector("#editorFontSize"),
  translationSectionSelect: document.querySelector("#translationSectionSelect"),
  bilingualHeadings: document.querySelector("#bilingualHeadings"),
  splitHandle: document.querySelector("#splitHandle"),
  workspaceSplitHandle: document.querySelector("#workspaceSplitHandle"),
  segmentList: document.querySelector("#segmentList"),
  pageStatus: document.querySelector("#pageStatus"),
  pdfScroll: document.querySelector("#pdfScroll"),
  previewPanel: document.querySelector(".preview-panel"),
  visiblePage: document.querySelector("#visiblePage"),
  pdfZoomValue: document.querySelector("#pdfZoomValue"),
  zoomOutButton: document.querySelector("#zoomOutButton"),
  zoomInButton: document.querySelector("#zoomInButton"),
  warningCount: document.querySelector("#warningCount"),
  warningList: document.querySelector("#warningList"),
  buildDrawer: document.querySelector("#buildDrawer"),
  compileDiagnosis: document.querySelector("#compileDiagnosis"),
  compileDiagnosisStatus: document.querySelector("#compileDiagnosisStatus"),
  compileDiagnosisSummary: document.querySelector("#compileDiagnosisSummary"),
  compileDiagnosisList: document.querySelector("#compileDiagnosisList"),
  editView: document.querySelector("#editView"),
  sourceView: document.querySelector("#sourceView"),
  sourceFileSelect: document.querySelector("#sourceFileSelect"),
  sourceEditor: document.querySelector("#sourceEditor"),
  sourceLineNumbers: document.querySelector("#sourceLineNumbers"),
  sourceStatus: document.querySelector("#sourceStatus"),
  saveSourceButton: document.querySelector("#saveSourceButton"),
  modularizeButton: document.querySelector("#modularizeButton"),
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
  formatWorkflow: document.querySelector("#formatWorkflow"),
  formatDifferenceList: document.querySelector("#formatDifferenceList"),
  formatWarningList: document.querySelector("#formatWarningList"),
  setupDialog: document.querySelector("#setupDialog"),
  setupForm: document.querySelector("#setupForm"),
  setupMessage: document.querySelector("#setupMessage"),
  dependencyStatus: document.querySelector("#dependencyStatus"),
  settingsDialog: document.querySelector("#settingsDialog"),
  settingsForm: document.querySelector("#settingsForm"),
  mainTexDialog: document.querySelector("#mainTexDialog"),
  mainTexForm: document.querySelector("#mainTexForm"),
  mainTexSelect: document.querySelector("#mainTexSelect"),
  paragraphDialog: document.querySelector("#paragraphDialog"),
  paragraphForm: document.querySelector("#paragraphForm"),
  newParagraphChinese: document.querySelector("#newParagraphChinese"),
  gitPushDialog: document.querySelector("#gitPushDialog"),
  gitPushForm: document.querySelector("#gitPushForm"),
  gitPushList: document.querySelector("#gitPushList"),
  structureDialog: document.querySelector("#structureDialog"),
  structureForm: document.querySelector("#structureForm"),
  structureSummary: document.querySelector("#structureSummary"),
  structureFlow: document.querySelector("#structureFlow"),
  structureFileList: document.querySelector("#structureFileList"),
  structureWarning: document.querySelector("#structureWarning"),
  applyStructureButton: document.querySelector("#applyStructureButton"),
  migrateBibliographyButton: document.querySelector("#migrateBibliographyButton"),
  formatPreflightDialog: document.querySelector("#formatPreflightDialog"),
  formatPreflightSummary: document.querySelector("#formatPreflightSummary"),
  formatPreflightFlow: document.querySelector("#formatPreflightFlow"),
  formatPreflightWarning: document.querySelector("#formatPreflightWarning"),
  splitForFormatButton: document.querySelector("#splitForFormatButton"),
  continueWithoutSplitButton: document.querySelector("#continueWithoutSplitButton"),
  toastRegion: document.querySelector("#toastRegion")
};

function refreshIcons() {
  window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } });
}

function fitSegmentRow(row) {
  const chinese = row.querySelector(".segment-textarea.chinese");
  const english = row.querySelector(".segment-textarea.english");
  if (!chinese || !english) return;
  chinese.style.height = "auto";
  const height = Math.max(196, chinese.scrollHeight + 2);
  chinese.style.height = `${height}px`;
  english.style.height = `${height}px`;
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

function applyWorkspaceSplit(persist = true) {
  const anchor = state.pdfDocument ? capturePdfViewportAnchor() : null;
  document.documentElement.style.setProperty("--workspace-editor-share", `${state.workspaceSplit}fr`);
  document.documentElement.style.setProperty("--workspace-preview-share", `${100 - state.workspaceSplit}fr`);
  elements.workspaceSplitHandle.setAttribute("aria-valuenow", String(Math.round(state.workspaceSplit)));
  if (persist) localStorage.setItem("paperBridge.workspaceSplit", String(state.workspaceSplit));
  schedulePdfPanelResize(anchor);
}

function setWorkspaceSplit(clientX) {
  const workspaceBounds = elements.workspace.getBoundingClientRect();
  const sidebarBounds = elements.sidebar.getBoundingClientRect();
  const dividerWidth = elements.workspaceSplitHandle.offsetWidth || 12;
  const availableWidth = Math.max(1, workspaceBounds.right - sidebarBounds.right - dividerWidth);
  const compact = window.innerWidth <= 1220;
  const minimumEditor = compact ? 360 : 400;
  const minimumPreview = compact ? 320 : 340;
  const lower = Math.max(32, minimumEditor / availableWidth * 100);
  const upper = Math.min(72, 100 - minimumPreview / availableWidth * 100);
  const requested = (clientX - sidebarBounds.right - dividerWidth / 2) / availableWidth * 100;
  state.workspaceSplit = Math.round(Math.min(Math.max(lower, requested), Math.max(lower, upper)) * 10) / 10;
  applyWorkspaceSplit(false);
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
  document.querySelector("#setupStorageSection").classList.toggle("hidden", switching);
  document.querySelector("#setupAiSection").classList.toggle("hidden", switching);
  document.querySelector("#setupTestButton").classList.toggle("hidden", switching);
  document.querySelector("#setupSourceStep").textContent = switching ? "1" : "2";
  document.querySelector("#setupTypesetStep").textContent = switching ? "2" : "4";
  document.querySelector("#setupStorageRoot").value = project.config?.storageRoot
    || project.config?.suggestedStorageRoot
    || "";
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

async function chooseStoragePath(input) {
  const bridge = window.paperBridgeDesktop;
  if (!bridge?.chooseDataFolder) {
    input.readOnly = false;
    input.focus();
    setSetupMessage("请直接输入完整路径。", "");
    return false;
  }
  const selected = await bridge.chooseDataFolder(input.value);
  if (selected) input.value = selected;
  return Boolean(selected);
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

function chooseMainTex(candidates, current) {
  elements.mainTexSelect.replaceChildren();
  for (const file of candidates) {
    const option = document.createElement("option");
    option.value = file;
    option.textContent = file;
    elements.mainTexSelect.append(option);
  }
  elements.mainTexSelect.value = candidates.includes(current) ? current : candidates[0];
  elements.mainTexDialog.showModal();
  refreshIcons();
  return new Promise((resolve) => {
    state.mainTexResolver = resolve;
  });
}

function finishMainTexSelection() {
  const resolve = state.mainTexResolver;
  state.mainTexResolver = null;
  elements.mainTexDialog.close();
  resolve?.(elements.mainTexSelect.value);
}

async function submitSetup(event) {
  event.preventDefault();
  if (state.sourceDirty) {
    if (!confirmDiscardSourceChanges()) return;
    state.sourceDirty = false;
  }
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
        storageRoot: state.setupMode === "initial"
          ? document.querySelector("#setupStorageRoot").value.trim()
          : "",
        preserveProviders: state.setupMode === "switch",
        autoCompile: document.querySelector("#setupAutoCompile").checked,
        translation,
        review: { ...translation }
      })
    });
    elements.setupDialog.close();
    const mainTexCandidates = state.project.mainTexCandidates || [];
    if (mainTexCandidates.length > 1) {
      const mainTex = await chooseMainTex(mainTexCandidates, state.project.config.mainTex);
      if (mainTex !== state.project.config.mainTex) {
        state.project = await api("/api/project/open", {
          method: "POST",
          body: JSON.stringify({ projectRoot: state.project.config.projectRoot, mainTex })
        });
      }
    }
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
    const cssWidth = Number(canvas.dataset.baseWidth) * scale;
    const cssHeight = Number(canvas.dataset.baseHeight) * scale;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    const shell = canvas.closest(".pdf-page-shell");
    if (shell) {
      shell.style.width = `${cssWidth}px`;
      shell.style.height = `${cssHeight}px`;
    }
    const textLayer = state.pdfTextLayers.get(canvas);
    if (textLayer?.task && canvas._pdfPage) {
      const baseViewport = canvas._pdfPage.getViewport({ scale: 1 });
      textLayer.task.update({
        viewport: canvas._pdfPage.getViewport({ scale: cssWidth / baseViewport.width })
      });
      textLayer.zoom = state.pdfZoom;
    }
  });
}

function pdfOutputScale(cssWidth, cssHeight) {
  const preferred = Math.min(2, Math.max(1.5, window.devicePixelRatio || 1));
  const maxPixels = 12_000_000;
  const pixels = cssWidth * cssHeight * preferred * preferred;
  return pixels > maxPixels ? preferred * Math.sqrt(maxPixels / pixels) : preferred;
}

async function renderPdfCanvas(canvas) {
  const pdf = state.pdfDocument;
  const documentToken = state.pdfRenderToken;
  if (!pdf || !canvas.isConnected) return;
  const zoom = state.pdfZoom;
  const canvasReady = canvas.dataset.rendered === "true" && Number(canvas.dataset.renderZoom) === zoom;
  const existingTextLayer = state.pdfTextLayers.get(canvas);
  if (canvasReady && existingTextLayer?.ready && existingTextLayer.zoom === zoom) return;
  const version = String(Number(canvas.dataset.renderVersion || 0) + 1);
  canvas.dataset.renderVersion = version;
  if (!canvasReady) {
    const previousTask = state.pdfPageRenderTasks.get(canvas);
    if (previousTask) {
      previousTask.cancel();
      await previousTask.promise.catch(() => {});
    }
  }
  if (documentToken !== state.pdfRenderToken || canvas.dataset.renderVersion !== version) return;
  const page = await pdf.getPage(Number(canvas.dataset.page));
  if (documentToken !== state.pdfRenderToken || canvas.dataset.renderVersion !== version) return;
  canvas._pdfPage = page;
  const baseViewport = page.getViewport({ scale: 1 });
  const cssWidth = Number(canvas.dataset.baseWidth) * zoom / 100;
  const cssHeight = Number(canvas.dataset.baseHeight) * zoom / 100;
  const textLayerPromise = renderPdfTextLayer(canvas, page, baseViewport, cssWidth, documentToken, version);
  if (canvasReady) {
    await textLayerPromise;
    return;
  }
  const outputScale = pdfOutputScale(cssWidth, cssHeight);
  const viewport = page.getViewport({ scale: (cssWidth / baseViewport.width) * outputScale });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  const task = page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport });
  state.pdfPageRenderTasks.set(canvas, task);
  try {
    await Promise.all([task.promise, textLayerPromise]);
    if (documentToken === state.pdfRenderToken && canvas.dataset.renderVersion === version) {
      canvas.dataset.rendered = "true";
      canvas.dataset.renderZoom = String(zoom);
      canvas.dataset.outputScale = outputScale.toFixed(2);
    }
  } catch (error) {
    if (error?.name !== "RenderingCancelledException") throw error;
  } finally {
    if (state.pdfPageRenderTasks.get(canvas) === task) state.pdfPageRenderTasks.delete(canvas);
  }
}

async function renderPdfTextLayer(canvas, page, baseViewport, cssWidth, documentToken, version) {
  const viewport = page.getViewport({ scale: cssWidth / baseViewport.width });
  const existing = state.pdfTextLayers.get(canvas);
  if (existing) {
    existing.task.update({ viewport });
    existing.zoom = state.pdfZoom;
    return existing.renderPromise;
  }
  const textContent = await page.getTextContent();
  if (documentToken !== state.pdfRenderToken || canvas.dataset.renderVersion !== version || !canvas.isConnected) return;
  const container = canvas.closest(".pdf-page-shell")?.querySelector(".pdf-text-layer");
  if (!container) return;
  const task = new pdfjsLib.TextLayer({ textContentSource: textContent, container, viewport });
  const entry = { task, ready: false, zoom: state.pdfZoom, renderPromise: null };
  state.pdfTextLayers.set(canvas, entry);
  entry.renderPromise = task.render().then(() => {
    task.textDivs.forEach((textDiv, index) => {
      textDiv.dataset.pdfTextIndex = String(index);
    });
    entry.ready = true;
    container.dataset.ready = "true";
  }).catch((error) => {
    if (error?.name !== "AbortException") throw error;
  });
  return entry.renderPromise;
}

function renderVisiblePdfPages() {
  const scrollRect = elements.pdfScroll.getBoundingClientRect();
  const margin = 700;
  elements.pdfScroll.querySelectorAll(".pdf-page").forEach((canvas) => {
    const rect = canvas.getBoundingClientRect();
    if (rect.bottom >= scrollRect.top - margin && rect.top <= scrollRect.bottom + margin) {
      void renderPdfCanvas(canvas).catch((error) => toast(`PDF 页面渲染失败：${error.message}`, "error"));
    }
  });
}

function capturePdfViewportAnchor(clientX = null, clientY = null) {
  const scroll = elements.pdfScroll;
  const scrollRect = scroll.getBoundingClientRect();
  const fixedPoint = Number.isFinite(clientX) && Number.isFinite(clientY);
  const targetX = fixedPoint ? clientX : scrollRect.left + scroll.clientWidth / 2;
  const targetY = fixedPoint ? clientY : scrollRect.top + scroll.clientHeight / 2;
  const pages = [...scroll.querySelectorAll(".pdf-page")];
  let page = pages.find((canvas) => {
    const rect = canvas.getBoundingClientRect();
    return targetX >= rect.left && targetX <= rect.right && targetY >= rect.top && targetY <= rect.bottom;
  });
  if (!page && pages.length) {
    page = pages.reduce((closest, canvas) => {
      const rect = canvas.getBoundingClientRect();
      const distance = Math.abs(targetY - Math.min(Math.max(targetY, rect.top), rect.bottom));
      return !closest || distance < closest.distance ? { canvas, distance } : closest;
    }, null)?.canvas;
  }
  if (page) {
    const rect = page.getBoundingClientRect();
    return {
      page,
      ratioX: Math.min(1, Math.max(0, (targetX - rect.left) / Math.max(rect.width, 1))),
      ratioY: Math.min(1, Math.max(0, (targetY - rect.top) / Math.max(rect.height, 1))),
      clientX: targetX,
      clientY: targetY,
      fixedPoint
    };
  }
  return {
    centerX: (scroll.scrollLeft + scroll.clientWidth / 2) / Math.max(scroll.scrollWidth, 1),
    centerY: (scroll.scrollTop + scroll.clientHeight / 2) / Math.max(scroll.scrollHeight, 1),
    clientX: targetX,
    clientY: targetY,
    fixedPoint
  };
}

function restorePdfViewportAnchor(anchor) {
  if (!anchor) return;
  const scroll = elements.pdfScroll;
  const scrollRect = scroll.getBoundingClientRect();
  const targetX = anchor.fixedPoint ? anchor.clientX : scrollRect.left + scroll.clientWidth / 2;
  const targetY = anchor.fixedPoint ? anchor.clientY : scrollRect.top + scroll.clientHeight / 2;
  if (anchor.page?.isConnected) {
    const rect = anchor.page.getBoundingClientRect();
    const contentX = rect.left + anchor.ratioX * rect.width;
    const contentY = rect.top + anchor.ratioY * rect.height;
    scroll.scrollLeft += contentX - targetX;
    scroll.scrollTop += contentY - targetY;
    return;
  }
  scroll.scrollLeft = anchor.centerX * scroll.scrollWidth - scroll.clientWidth / 2;
  scroll.scrollTop = anchor.centerY * scroll.scrollHeight - scroll.clientHeight / 2;
}

function schedulePdfRerender(delay = 160) {
  window.clearTimeout(state.pdfRenderTimer);
  state.pdfRenderTimer = window.setTimeout(() => {
    state.pdfRenderTimer = 0;
    renderVisiblePdfPages();
  }, delay);
}

function fitPdfPagesToPanel(anchor = capturePdfViewportAnchor()) {
  const availableWidth = Math.max(280, elements.pdfScroll.clientWidth - 26);
  let changed = false;
  elements.pdfScroll.querySelectorAll(".pdf-page").forEach((canvas) => {
    const currentWidth = Number(canvas.dataset.baseWidth);
    if (Math.abs(currentWidth - availableWidth) < 1) return;
    const aspectRatio = Number(canvas.dataset.pageAspect) || Number(canvas.dataset.baseHeight) / Math.max(currentWidth, 1);
    canvas.dataset.baseWidth = String(Math.floor(availableWidth));
    canvas.dataset.baseHeight = String(Math.floor(availableWidth * aspectRatio));
    canvas.dataset.rendered = "false";
    changed = true;
  });
  if (!changed) return;
  resizePdfPages();
  restorePdfViewportAnchor(anchor);
  schedulePdfRerender();
}

function schedulePdfPanelResize(anchor = capturePdfViewportAnchor()) {
  state.pendingPdfResizeAnchor = anchor;
  window.cancelAnimationFrame(state.pdfResizeFrame);
  state.pdfResizeFrame = window.requestAnimationFrame(() => {
    state.pdfResizeFrame = 0;
    const pendingAnchor = state.pendingPdfResizeAnchor;
    state.pendingPdfResizeAnchor = null;
    fitPdfPagesToPanel(pendingAnchor);
  });
}

function setPdfZoom(nextZoom, { persist = true, preserveViewport = true, anchor = null } = {}) {
  const viewportAnchor = preserveViewport
    ? capturePdfViewportAnchor(anchor?.clientX ?? null, anchor?.clientY ?? null)
    : null;
  state.pdfZoom = Math.min(300, Math.max(50, Math.round(nextZoom)));
  elements.pdfZoomValue.textContent = `${state.pdfZoom}%`;
  elements.zoomOutButton.disabled = state.pdfZoom <= 50;
  elements.zoomInButton.disabled = state.pdfZoom >= 300;
  resizePdfPages();
  if (persist) localStorage.setItem("paperBridge.pdfZoom", String(state.pdfZoom));
  restorePdfViewportAnchor(viewportAnchor);
  schedulePdfRerender();
}

function zoomPdfWithWheel(event) {
  if (!event.ctrlKey) return;
  event.preventDefault();
  if (!state.pdfDocument) return;
  const deltaPixels = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? elements.pdfScroll.clientHeight : 1);
  if (!deltaPixels) return;
  const step = Math.max(1, Math.min(12, Math.abs(deltaPixels) / 20));
  const direction = deltaPixels < 0 ? 1 : -1;
  setPdfZoom(state.pdfZoom + direction * step, {
    anchor: { clientX: event.clientX, clientY: event.clientY }
  });
}

function beginPdfPan(event) {
  if (event.button !== 0 || !event.target.closest(".pdf-page-shell")) return;
  if (event.target.closest(".pdf-text-layer span")) return;
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

function invalidatePdfNavigationIndex() {
  state.pdfNavigationToken += 1;
  state.pdfParagraphIndex = null;
  state.pdfParagraphIndexPromise = null;
  state.pdfSourceIndex = null;
  state.pdfSourceIndexPromise = null;
}

function normalizePdfNavigationText(value, { latex = false } = {}) {
  let text = String(value || "")
    .normalize("NFKC")
    .replace(/[ﬁﬂﬀﬃﬄ]/g, (ligature) => ({ ﬁ: "fi", ﬂ: "fl", ﬀ: "ff", ﬃ: "ffi", ﬄ: "ffl" })[ligature])
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"');
  if (latex) {
    text = text
      .replace(/(^|[^\\])%.*$/gm, "$1 ")
      .replace(/\$\$[\s\S]*?\$\$/g, " MATH ")
      .replace(/\$[^$]*\$/g, " MATH ")
      .replace(/\\(?:begin|end)\s*\{[^{}]+\}/g, " ")
      .replace(/\\(?:cite\w*|ref|eqref|autoref|cref|Cref|pageref|label|url)\s*(?:\[[^\]]*\]\s*)*\{[^{}]*\}/g, " ")
      .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/g, " ")
      .replace(/\\([%&#_$])/g, "$1")
      .replace(/[{}~]/g, " ");
  }
  return text
    .replace(/([A-Za-z])-\s+([a-z])/g, "$1$2")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function navigationTokens(value, options) {
  const normalized = normalizePdfNavigationText(value, options);
  return { normalized, tokens: normalized ? normalized.split(" ") : [] };
}

function longestCommonTokenRun(left, right) {
  if (!left.length || !right.length) return 0;
  let previous = new Uint16Array(right.length + 1);
  let longest = 0;
  for (const token of left) {
    const current = new Uint16Array(right.length + 1);
    for (let index = 0; index < right.length; index += 1) {
      if (token === right[index]) {
        current[index + 1] = previous[index] + 1;
        longest = Math.max(longest, current[index + 1]);
      }
    }
    previous = current;
  }
  return longest;
}

function scoreNavigationText(query, candidate, selectedNormalized = "") {
  const run = longestCommonTokenRun(query.tokens, candidate.tokens);
  const querySet = new Set(query.tokens);
  const candidateSet = new Set(candidate.tokens);
  let overlap = 0;
  for (const token of querySet) if (candidateSet.has(token)) overlap += 1;
  const selectedExact = selectedNormalized.length >= 4 && candidate.normalized.includes(selectedNormalized);
  return {
    run,
    overlap,
    selectedExact,
    score: run * 4 + overlap + (selectedExact ? 5 : 0)
  };
}

function findBestNavigationMatch(queryText, selectedText, candidates, { source = false } = {}) {
  const query = navigationTokens(queryText);
  const selectedNormalized = normalizePdfNavigationText(selectedText);
  if (query.tokens.length < 2) return null;
  let best = null;
  let runnerUp = null;
  for (const candidate of candidates) {
    const metrics = scoreNavigationText(query, candidate, selectedNormalized);
    const result = { ...candidate, ...metrics };
    if (!best || result.score > best.score) {
      runnerUp = best;
      best = result;
    } else if (!runnerUp || result.score > runnerUp.score) {
      runnerUp = result;
    }
  }
  if (!best) return null;
  const overlapRatio = best.overlap / Math.max(1, Math.min(new Set(query.tokens).size, 12));
  const reliable = best.run >= (source ? 4 : 5)
    || (best.run >= 3 && best.overlap >= 5 && overlapRatio >= 0.45)
    || (best.selectedExact && best.run >= 3);
  if (!reliable) return null;
  const competingLocation = !source
    || (runnerUp && (runnerUp.file !== best.file || Math.abs((runnerUp.line || 0) - (best.line || 0)) > 10));
  if (best.run < 6 && runnerUp && competingLocation && best.score - runnerUp.score < 2) return null;
  return best;
}

async function getPdfParagraphIndex() {
  if (state.pdfParagraphIndex) return state.pdfParagraphIndex;
  if (state.pdfParagraphIndexPromise) return state.pdfParagraphIndexPromise;
  const token = state.pdfNavigationToken;
  const files = (state.project?.documents || []).map((item) => item.file);
  const promise = Promise.all(files.map((file) => api(`/api/document?file=${encodeURIComponent(file)}`)))
    .then((documents) => {
      if (token !== state.pdfNavigationToken) return [];
      state.pdfParagraphIndex = documents.flatMap((documentPayload) => documentPayload.segments.map((segment) => ({
        file: documentPayload.file,
        index: segment.index,
        id: segment.id,
        ...navigationTokens(segment.plainText || segment.english, { latex: !segment.plainText })
      }))).filter((entry) => entry.tokens.length);
      return state.pdfParagraphIndex;
    })
    .finally(() => {
      if (state.pdfParagraphIndexPromise === promise) state.pdfParagraphIndexPromise = null;
    });
  state.pdfParagraphIndexPromise = promise;
  return promise;
}

async function getPdfSourceIndex() {
  if (state.pdfSourceIndex) return state.pdfSourceIndex;
  if (state.pdfSourceIndexPromise) return state.pdfSourceIndexPromise;
  const token = state.pdfNavigationToken;
  const files = (state.project?.texFiles || []).filter((file) => file.toLowerCase().endsWith(".tex"));
  const promise = Promise.all(files.map((file) => api(`/api/source?file=${encodeURIComponent(file)}`)))
    .then((sources) => {
      if (token !== state.pdfNavigationToken) return [];
      state.pdfSourceIndex = sources.flatMap((source) => {
        const lines = source.content.split(/\r?\n/);
        return lines.map((_line, index) => {
          const start = Math.max(0, index - 3);
          const end = Math.min(lines.length, index + 6);
          return {
            file: source.file,
            line: index + 1,
            sourceLines: lines.slice(start, end).map((text, offset) => ({ line: start + offset + 1, text })),
            ...navigationTokens(lines.slice(start, end).join("\n"), { latex: true })
          };
        });
      }).filter((entry) => entry.tokens.length);
      return state.pdfSourceIndex;
    })
    .finally(() => {
      if (state.pdfSourceIndexPromise === promise) state.pdfSourceIndexPromise = null;
    });
  state.pdfSourceIndexPromise = promise;
  return promise;
}

function extractPdfNavigationQuery(event) {
  const shell = event.target.closest(".pdf-page-shell");
  const canvas = shell?.querySelector(".pdf-page");
  const textLayer = canvas ? state.pdfTextLayers.get(canvas) : null;
  if (!shell || !textLayer?.ready) return null;
  const target = event.target.closest(".pdf-text-layer span");
  const selection = window.getSelection();
  const selectedText = selection?.toString().trim() || target?.textContent?.trim() || "";
  const indexedTarget = target?.matches("[data-pdf-text-index]")
    ? target
    : target?.querySelector("[data-pdf-text-index]");
  let index = indexedTarget ? Number(indexedTarget.dataset.pdfTextIndex) : -1;
  if (!Number.isInteger(index) || index < 0) index = target ? textLayer.task.textDivs.indexOf(target) : -1;
  if (index < 0 && selection?.anchorNode) {
    const anchorElement = selection.anchorNode.nodeType === Node.ELEMENT_NODE
      ? selection.anchorNode
      : selection.anchorNode.parentElement;
    const anchorSpan = anchorElement?.closest?.(".pdf-text-layer [data-pdf-text-index]");
    index = anchorSpan ? Number(anchorSpan.dataset.pdfTextIndex) : -1;
  }
  if (index < 0) return null;
  const items = textLayer.task.textContentItemsStr;
  const divs = textLayer.task.textDivs;
  let start = index;
  let end = index + 1;
  const sameTextBlock = (before, after) => {
    if (!before || !after) return false;
    const beforeRect = before.getBoundingClientRect();
    const afterRect = after.getBoundingClientRect();
    const gap = afterRect.top - beforeRect.bottom;
    const lineJump = afterRect.top < beforeRect.top - Math.max(beforeRect.height, afterRect.height) * 1.5;
    return !lineJump && gap <= Math.max(12, Math.max(beforeRect.height, afterRect.height) * 0.95);
  };
  while (start > 0 && index - start < 8 && sameTextBlock(divs[start - 1], divs[start])) start -= 1;
  while (end < items.length && end - index < 9 && sameTextBlock(divs[end - 1], divs[end])) end += 1;
  const context = items.slice(start, end).filter(Boolean).join(" ");
  return { selectedText, context: context || selectedText };
}

function highlightLocatedSegment(file, index) {
  const row = [...elements.segmentList.querySelectorAll(".segment-row")]
    .find((candidate) => candidate.dataset.file === file && Number(candidate.dataset.segmentIndex) === index);
  if (!row) return false;
  row.classList.remove("pdf-located");
  void row.offsetWidth;
  row.classList.add("pdf-located");
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  window.setTimeout(() => row.classList.remove("pdf-located"), 2200);
  return true;
}

async function locatePdfSelection(event) {
  if (state.pdfNavigationBusy) {
    elements.pdfScroll.dataset.navigationState = "busy";
    return;
  }
  const query = extractPdfNavigationQuery(event);
  if (!query?.context) {
    elements.pdfScroll.dataset.navigationState = "no-query";
    return;
  }
  elements.pdfScroll.dataset.navigationState = "matching";
  state.pdfNavigationBusy = true;
  elements.pdfScroll.classList.add("locating");
  try {
    const paragraph = findBestNavigationMatch(query.context, query.selectedText, await getPdfParagraphIndex());
    if (paragraph) {
      if (state.mode !== "edit" && !setMode("edit", { loadCurrent: false })) return;
      if (state.currentDocument?.file !== paragraph.file) await loadDocument(paragraph.file);
      if (highlightLocatedSegment(paragraph.file, paragraph.index)) {
        elements.pdfScroll.dataset.navigationState = "paragraph";
        toast("已定位到对应的中英文段落。", "success", 2600);
        return;
      }
    }

    const source = findBestNavigationMatch(query.context, query.selectedText, await getPdfSourceIndex(), { source: true });
    if (source) {
      const queryTokens = navigationTokens(query.context);
      const selectedNormalized = normalizePdfNavigationText(query.selectedText);
      let targetLine = source.line;
      let bestLineScore = -1;
      for (const item of source.sourceLines) {
        const lineCandidate = navigationTokens(item.text, { latex: true });
        const metrics = scoreNavigationText(queryTokens, lineCandidate, selectedNormalized);
        if (metrics.score > bestLineScore) {
          bestLineScore = metrics.score;
          targetLine = item.line;
        }
      }
      if (await openSourceLocation(source.file, targetLine)) {
        elements.pdfScroll.dataset.navigationState = "source";
        toast("未找到对应翻译段落，已定位到 TeX 源码。", "success", 3600);
        return;
      }
    }
    elements.pdfScroll.dataset.navigationState = "not-found";
    toast("没有找到可靠的对应段落或 TeX 位置。", "error", 4200);
  } catch (error) {
    elements.pdfScroll.dataset.navigationState = "error";
    toast(`PDF 定位失败：${error.message}`, "error", 5200);
  } finally {
    state.pdfNavigationBusy = false;
    elements.pdfScroll.classList.remove("locating");
  }
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

function setFileTranslationProgress(completed, total, label, status = "") {
  const percent = total ? Math.round((completed / total) * 100) : 0;
  elements.fileTranslationProgress.classList.remove("hidden", "warning", "error");
  if (status) elements.fileTranslationProgress.classList.add(status);
  elements.fileTranslationProgressLabel.textContent = label;
  elements.fileTranslationProgressCount.textContent = `${completed} / ${total}`;
  elements.fileTranslationProgressBar.style.width = `${percent}%`;
  elements.fileTranslationProgressTrack.setAttribute("aria-valuenow", String(percent));
}

function hideFileTranslationProgress() {
  elements.fileTranslationProgress.classList.add("hidden");
  elements.fileTranslationProgress.classList.remove("warning", "error");
  elements.fileTranslationProgressBar.style.width = "0%";
  elements.fileTranslationProgressTrack.setAttribute("aria-valuenow", "0");
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
  window.clearTimeout(state.pdfRenderTimer);
  state.pdfRenderTimer = 0;
  state.pdfObserver?.disconnect();
  state.pdfObserver = null;
  for (const task of state.pdfPageRenderTasks.values()) task.cancel();
  state.pdfPageRenderTasks.clear();
  for (const entry of state.pdfTextLayers.values()) if (!entry.ready) entry.task.cancel();
  state.pdfTextLayers.clear();
  state.pdfDocument = null;
  elements.pdfScroll.innerHTML = '<div class="pdf-loading">正在渲染 PDF...</div>';
  try {
    const pdf = await pdfjsLib.getDocument({ url: `/api/pdf?t=${Date.now()}` }).promise;
    if (token !== state.pdfRenderToken) return;
    state.pdfDocument = pdf;
    elements.pdfScroll.replaceChildren();
    const availableWidth = Math.max(280, elements.pdfScroll.clientWidth - 26);
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (token !== state.pdfRenderToken) return;
      const page = await pdf.getPage(pageNumber);
      const baseViewport = page.getViewport({ scale: 1 });
      const cssScale = availableWidth / baseViewport.width;
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-page";
      canvas.dataset.page = String(pageNumber);
      canvas.dataset.baseWidth = String(Math.floor(baseViewport.width * cssScale));
      canvas.dataset.baseHeight = String(Math.floor(baseViewport.height * cssScale));
      canvas.dataset.pageAspect = String(baseViewport.height / baseViewport.width);
      const zoomScale = state.pdfZoom / 100;
      canvas.style.width = `${Number(canvas.dataset.baseWidth) * zoomScale}px`;
      canvas.style.height = `${Number(canvas.dataset.baseHeight) * zoomScale}px`;
      const shell = document.createElement("div");
      shell.className = "pdf-page-shell";
      shell.dataset.page = String(pageNumber);
      shell.style.width = canvas.style.width;
      shell.style.height = canvas.style.height;
      const textLayer = document.createElement("div");
      textLayer.className = "pdf-text-layer textLayer";
      textLayer.setAttribute("aria-label", `PDF 第 ${pageNumber} 页文本`);
      shell.append(canvas, textLayer);
      elements.pdfScroll.append(shell);
    }
    state.pdfObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) void renderPdfCanvas(entry.target).catch((error) => toast(`PDF 页面渲染失败：${error.message}`, "error"));
      }
    }, { root: elements.pdfScroll, rootMargin: "700px 0px" });
    elements.pdfScroll.querySelectorAll(".pdf-page").forEach((canvas) => state.pdfObserver.observe(canvas));
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
  if (state.buildPreviewAvailable === false || !pdf?.exists) {
    state.pdfRenderToken += 1;
    state.pdfObserver?.disconnect();
    state.pdfObserver = null;
    for (const task of state.pdfPageRenderTasks.values()) task.cancel();
    state.pdfPageRenderTasks.clear();
    for (const entry of state.pdfTextLayers.values()) if (!entry.ready) entry.task.cancel();
    state.pdfTextLayers.clear();
    state.pdfDocument = null;
    elements.pageStatus.textContent = state.buildPreviewAvailable === false ? "编译错误" : "PDF 未生成";
    elements.pdfScroll.replaceChildren();
    return;
  }
  elements.pageStatus.textContent = `${pdf.pages} 页`;
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

function updateWarnings(warnings = [], layoutChanges = [], errors = []) {
  const layoutWarnings = layoutChanges.map((change) => {
    const kind = change.type === "figure" ? "图" : "表";
    if (change.kind === "moved") return `${kind} ${change.label}：第 ${change.from} 页 → 第 ${change.to} 页`;
    if (change.kind === "added") return `${kind} ${change.label}：新增在第 ${change.to} 页`;
    return `${kind} ${change.label}：从第 ${change.from} 页消失`;
  });
  const combined = [
    ...errors.map((text) => ({ text, level: "error" })),
    ...layoutWarnings.map((text) => ({ text, level: "warning" })),
    ...warnings.map((text) => ({ text, level: "warning" }))
  ];
  state.warnings = combined.map((item) => item.text);
  elements.warningCount.textContent = String(combined.length);
  elements.warningCount.classList.toggle("hidden", combined.length === 0);
  elements.warningList.replaceChildren();
  if (!combined.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "没有编译错误或警告";
    elements.warningList.append(empty);
    return;
  }
  for (const item of combined) {
    const row = document.createElement("div");
    row.className = `warning-item ${item.level}`;
    row.textContent = item.text;
    elements.warningList.append(row);
  }
}

function clearCompileDiagnosis() {
  state.compileDiagnosisToken += 1;
  state.compileDiagnosisFingerprint = "";
  elements.compileDiagnosis.classList.add("hidden");
  elements.compileDiagnosisStatus.textContent = "";
  elements.compileDiagnosisSummary.textContent = "";
  elements.compileDiagnosisList.replaceChildren();
}

async function openSourceLocation(file, line) {
  const alreadyLoaded = state.mode === "source" && state.sourceFile === file;
  if (!alreadyLoaded && state.mode === "source" && state.sourceDirty && !confirmDiscardSourceChanges()) return false;
  if (!alreadyLoaded) {
    state.sourceFile = file;
    if (!setMode("source", { loadCurrent: false })) return false;
    if (!await loadSourceFile(file, { force: true })) return false;
  }
  const lines = elements.sourceEditor.value.split("\n");
  const targetLine = Math.min(lines.length, Math.max(1, Number(line) || 1));
  const start = lines.slice(0, targetLine - 1).reduce((total, value) => total + value.length + 1, 0);
  const end = start + (lines[targetLine - 1]?.length || 0);
  elements.sourceEditor.focus();
  elements.sourceEditor.setSelectionRange(start, end);
  const lineHeight = Number.parseFloat(getComputedStyle(elements.sourceEditor).lineHeight) || 20;
  elements.sourceEditor.scrollTop = Math.max(0, (targetLine - 5) * lineHeight);
  elements.sourceLineNumbers.scrollTop = elements.sourceEditor.scrollTop;
  return true;
}

function renderCompileDiagnosis(diagnosis) {
  elements.compileDiagnosisSummary.textContent = diagnosis.summary || "AI 已完成编译错误分析。";
  elements.compileDiagnosisStatus.textContent = diagnosis.cached ? "已完成 · 缓存" : "已完成";
  elements.compileDiagnosisList.replaceChildren();
  for (const issue of diagnosis.issues || []) {
    const row = document.createElement("div");
    row.className = "diagnosis-issue";
    const meta = document.createElement("div");
    meta.className = "diagnosis-issue-meta";
    const location = document.createElement("button");
    location.className = "source-location-button";
    location.type = "button";
    location.innerHTML = '<i data-lucide="code-2"></i><span></span>';
    location.querySelector("span").textContent = `${issue.file}:${issue.line}`;
    location.title = "在 TeX 源码中打开";
    location.addEventListener("click", () => openSourceLocation(issue.file, issue.line));
    meta.append(location);
    const explanation = document.createElement("div");
    explanation.className = "diagnosis-explanation";
    explanation.textContent = issue.explanation;
    const suggestion = document.createElement("div");
    suggestion.className = "diagnosis-suggestion";
    suggestion.textContent = `建议：${issue.suggestion}`;
    row.append(meta, explanation, suggestion);
    if (issue.replacement) {
      const replacement = document.createElement("pre");
      replacement.className = "diagnosis-replacement";
      replacement.textContent = issue.replacement;
      row.append(replacement);
    }
    elements.compileDiagnosisList.append(row);
  }
  refreshIcons();
}

async function diagnoseBuild(build) {
  const errors = build.errors || [];
  const fingerprint = JSON.stringify([state.project?.config?.projectRoot, state.project?.config?.mainTex, errors, build.log || ""]);
  if (state.compileDiagnosisFingerprint === fingerprint && elements.compileDiagnosisStatus.textContent === "分析中") return;
  const token = ++state.compileDiagnosisToken;
  state.compileDiagnosisFingerprint = fingerprint;
  elements.compileDiagnosis.classList.remove("hidden");
  elements.buildDrawer.classList.remove("hidden");
  elements.compileDiagnosisStatus.textContent = "分析中";
  elements.compileDiagnosisSummary.textContent = "AI 正在定位错误...";
  elements.compileDiagnosisList.replaceChildren();
  try {
    const diagnosis = await api("/api/compile/diagnose", {
      method: "POST",
      body: JSON.stringify({ errors, log: build.log || "" })
    });
    if (token !== state.compileDiagnosisToken) return;
    renderCompileDiagnosis(diagnosis);
  } catch (error) {
    if (token !== state.compileDiagnosisToken) return;
    elements.compileDiagnosisStatus.textContent = "诊断失败";
    elements.compileDiagnosisSummary.textContent = error.message;
  }
}

function updateBuild(build) {
  if (!build) return;
  if (typeof build.previewAvailable === "boolean") state.buildPreviewAvailable = build.previewAvailable;
  if (build.pdf) {
    state.project.pdf = build.pdf;
    updatePdf(build.pdf);
  }
  updateWarnings(build.warnings || [], build.layoutChanges || [], build.errors || []);
  if (!build.success && !build.skipped) {
    toast("编译失败，AI 正在定位错误。", "error", 5200);
    void diagnoseBuild(build);
  } else if (build.success && !build.skipped) {
    clearCompileDiagnosis();
  }
}

async function refreshProject({ preserveDocument = true } = {}) {
  const previousRoot = state.project?.config?.projectRoot;
  const previousMainTex = state.project?.config?.mainTex;
  state.project = await api("/api/bootstrap");
  invalidatePdfNavigationIndex();
  const projectChanged = previousRoot && (
    state.project.config?.projectRoot !== previousRoot
    || state.project.config?.mainTex !== previousMainTex
  );
  if (projectChanged) {
    state.buildPreviewAvailable = null;
    state.sourceFile = null;
    state.sourceHash = "";
    state.sourceEol = "\n";
    state.sourceSavedContent = "";
    state.sourceDirty = false;
    clearCompileDiagnosis();
  }
  if (state.project.setupRequired) {
    openSetup(state.project);
    return false;
  }
  updateProjectHeader();
  renderDocumentList();
  renderSourceFileOptions();
  updatePdf();
  if (state.mode === "source" && !state.sourceFile && elements.sourceFileSelect.value) {
    await loadSourceFile(elements.sourceFileSelect.value, { force: true });
  }
  if (!preserveDocument && state.project.documents.length) {
    await loadDocument(state.project.documents[0].file);
  }
  return true;
}

function createSegmentRow(segment) {
  const row = document.createElement("article");
  row.className = "segment-row";
  row.dataset.segmentId = segment.id;
  row.dataset.file = segment.file;
  row.dataset.segmentIndex = String(segment.index);
  row.innerHTML = `
    <div class="segment-header">
      <div class="segment-identity">
        <span class="segment-index"></span>
        <span class="line-range"></span>
        <span class="segment-status"></span>
      </div>
      <div class="segment-actions">
        <button class="mini-button add-paragraph-button" type="button" title="在本段前后新增段落"><i data-lucide="plus"></i></button>
        <button class="mini-button translate-chinese-button" type="button" title="仅翻译本段到中文"><i data-lucide="languages"></i></button>
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
  const translateChineseButton = row.querySelector(".translate-chinese-button");
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
  if (segment.chinese) translateChineseButton.title = "本段中文已生成";

  translateChineseButton.addEventListener("click", async () => {
    if (segment.chinese) {
      toast("本段已经有中文工作稿，不会重复调用翻译接口。", "success");
      return;
    }
    setBusy(translateChineseButton, true);
    setFileTranslationProgress(0, 1, `P${String(segment.index + 1).padStart(2, "0")} · 正在翻译本段...`);
    try {
      const result = await api("/api/file/translate-to-chinese", {
        method: "POST",
        body: JSON.stringify({
          file: segment.file,
          sectionId: segment.sectionId,
          segmentIds: [segment.id]
        })
      });
      state.currentDocument = result.document;
      renderSegments();
      await refreshProject();
      const translated = result.progress?.translated || 0;
      setFileTranslationProgress(1, 1, translated ? "本段中文已生成" : "模型未返回本段翻译", translated ? "" : "warning");
      toast(translated ? "已仅翻译当前段落。" : "模型没有返回当前段落的有效中文翻译。", translated ? "success" : "error", 5200);
    } catch (error) {
      setFileTranslationProgress(0, 1, `本段翻译失败：${error.message}`, "error");
      toast(error.message, "error", 5600);
    } finally {
      setBusy(translateChineseButton, false);
    }
  });

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

function renderTranslationSections(documentPayload) {
  const sections = [];
  const seen = new Set();
  for (const segment of documentPayload.segments) {
    const id = segment.sectionId || `${documentPayload.file}:section:0`;
    if (seen.has(id)) continue;
    seen.add(id);
    sections.push({ id, index: segment.sectionIndex || 0, title: segment.sectionTitle || "" });
  }
  elements.translationSectionSelect.replaceChildren();
  if (!sections.length) {
    const option = document.createElement("option");
    option.textContent = "无可翻译段落";
    elements.translationSectionSelect.append(option);
    elements.translationSectionSelect.disabled = true;
    state.currentSectionId = null;
    return sections;
  }
  const selected = sections.some((section) => section.id === state.currentSectionId)
    ? state.currentSectionId
    : sections[0].id;
  for (const section of sections) {
    const option = document.createElement("option");
    option.value = section.id;
    option.textContent = section.title
      ? `第 ${section.index} 节 · ${section.title}`
      : sections.length > 1 ? "前置内容" : "当前文件";
    elements.translationSectionSelect.append(option);
  }
  state.currentSectionId = selected;
  elements.translationSectionSelect.value = selected;
  elements.translationSectionSelect.disabled = sections.length === 1;
  return sections;
}

function renderSegments() {
  const documentPayload = state.currentDocument;
  const sections = renderTranslationSections(documentPayload);
  elements.currentFile.textContent = fileLabel(documentPayload.file);
  elements.fileMeta.textContent = `${documentPayload.segments.length} 段 · ${sections.length} 节`;
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
  state.currentSectionId = null;
  hideFileTranslationProgress();
  elements.segmentList.innerHTML = '<div class="empty-state">正在读取段落...</div>';
  try {
    state.currentDocument = await api(`/api/document?file=${encodeURIComponent(file)}`);
    renderSegments();
  } catch (error) {
    toast(error.message, "error");
  }
}

function sourceLineCount() {
  return elements.sourceEditor.value.split(/\r?\n/).length;
}

function updateSourceLineNumbers() {
  const count = sourceLineCount();
  elements.sourceLineNumbers.textContent = Array.from({ length: count }, (_value, index) => index + 1).join("\n");
}

function setSourceDirty(dirty) {
  state.sourceDirty = dirty;
  const lines = sourceLineCount();
  elements.sourceStatus.classList.toggle("dirty", dirty);
  elements.sourceStatus.classList.remove("error");
  elements.sourceStatus.textContent = dirty ? `${lines} 行 · 有未保存修改` : `${lines} 行 · 已保存`;
  elements.saveSourceButton.disabled = !dirty;
}

function confirmDiscardSourceChanges() {
  return !state.sourceDirty || window.confirm("当前源码有未保存修改。放弃这些修改吗？");
}

function renderSourceFileOptions() {
  const files = state.project?.sourceFiles || state.project?.texFiles || [];
  const preferred = files.includes(state.sourceFile)
    ? state.sourceFile
    : files.includes(state.project?.config?.mainTex) ? state.project.config.mainTex : files[0];
  elements.sourceFileSelect.replaceChildren();
  for (const file of files) {
    const option = document.createElement("option");
    option.value = file;
    option.textContent = file === state.project.config.mainTex
      ? `${file}（主文件）`
      : file.toLowerCase().endsWith(".bib") ? `${file}（参考文献）` : file;
    elements.sourceFileSelect.append(option);
  }
  elements.sourceFileSelect.disabled = files.length === 0;
  elements.sourceEditor.disabled = files.length === 0;
  elements.sourceFileSelect.value = preferred || "";
  if (!files.length) {
    elements.sourceEditor.value = "";
    elements.sourceLineNumbers.textContent = "1";
    elements.sourceStatus.textContent = "没有可编辑的源码文件";
    elements.saveSourceButton.disabled = true;
  }
  const structure = state.project?.structure;
  elements.modularizeButton.title = structure?.eligible
    ? `预览将 ${structure.sections.length} 个章节拆分为独立文件`
    : structure?.reason || "检查论文是否适合按章节拆分";
}

async function loadSourceFile(file, { force = false } = {}) {
  if (!file) return false;
  if (!force && file !== state.sourceFile && !confirmDiscardSourceChanges()) return false;
  elements.sourceStatus.classList.remove("dirty", "error");
  elements.sourceStatus.textContent = "正在读取源码...";
  elements.sourceEditor.disabled = true;
  try {
    const source = await api(`/api/source?file=${encodeURIComponent(file)}`);
    state.sourceFile = source.file;
    state.sourceHash = source.sourceHash;
    state.sourceEol = source.eol || "\n";
    state.sourceDirty = false;
    elements.sourceFileSelect.value = source.file;
    elements.sourceEditor.value = source.content;
    state.sourceSavedContent = elements.sourceEditor.value;
    elements.sourceEditor.disabled = false;
    updateSourceLineNumbers();
    setSourceDirty(false);
    return true;
  } catch (error) {
    elements.sourceStatus.classList.add("error");
    elements.sourceStatus.textContent = "源码读取失败";
    toast(error.message, "error", 5200);
    return false;
  }
}

async function saveSourceFile() {
  if (!state.sourceFile || !state.sourceDirty) return;
  const button = elements.saveSourceButton;
  setBusy(button, true);
  try {
    const result = await api("/api/source", {
      method: "POST",
      body: JSON.stringify({
        file: state.sourceFile,
        content: state.sourceEol === "\r\n"
          ? elements.sourceEditor.value.replace(/\n/g, "\r\n")
          : elements.sourceEditor.value,
        sourceHash: state.sourceHash
      })
    });
    state.sourceHash = result.source.sourceHash;
    state.sourceEol = result.source.eol || state.sourceEol;
    state.sourceSavedContent = elements.sourceEditor.value;
    state.sourceDirty = false;
    updateBuild(result.build);
    await refreshProject();
    toast(
      result.build.skipped
        ? "源码已保存。"
        : result.build.success ? "源码已保存，PDF 已更新。" : "源码已保存，但编译仍有错误。",
      result.build.success || result.build.skipped ? "success" : "error",
      5200
    );
  } catch (error) {
    if (error.status === 409 && error.payload?.code === "SOURCE_CHANGED") {
      const reload = window.confirm("该源码文件已在其他位置发生变化。是否放弃当前修改并重新载入？");
      if (reload) await loadSourceFile(state.sourceFile, { force: true });
    } else {
      elements.sourceStatus.classList.add("error");
      elements.sourceStatus.textContent = "保存失败 · 修改仍保留在编辑器中";
      toast(error.message, "error", 6200);
    }
  } finally {
    setBusy(button, false);
    setSourceDirty(elements.sourceEditor.value !== state.sourceSavedContent);
  }
}

function structureStage(scope, title, files, detail) {
  const row = document.createElement("div");
  row.className = `structure-stage ${scope}`;
  const marker = document.createElement("span");
  marker.className = "structure-stage-marker";
  marker.textContent = scope === "global" ? "1" : scope === "local" ? "2" : "3";
  const body = document.createElement("div");
  const heading = document.createElement("strong");
  heading.textContent = title;
  const fileText = document.createElement("span");
  fileText.textContent = files.length ? files.join("、") : "当前未引用文件";
  const description = document.createElement("small");
  description.textContent = detail;
  body.append(heading, fileText, description);
  row.append(marker, body);
  return row;
}

function renderStructurePreview(preview) {
  const migration = preview.bibliographyMigration;
  const canMigrateBibliography = preview.mode === "bibliography-required" && migration?.eligible;
  const bibliographyFiles = canMigrateBibliography
    ? migration.files.map((file) => file.file)
    : preview.workflow.references.files;
  state.structurePreview = preview;
  elements.structureSummary.textContent = canMigrateBibliography
    ? `检测到 ${migration.entries.length} 条内嵌参考文献。先迁移到 ${bibliographyFiles.join("、")}，即可继续拆分章节。`
    : preview.eligible
      ? `将 ${preview.mainTex} 中的 ${preview.sections.length} 个章节拆成独立 TeX 文件，并在写入后重新编译。`
      : preview.reason;
  elements.structureFlow.replaceChildren(
    structureStage("global", "整体格式", [preview.workflow.global.file], preview.workflow.global.responsibilities.join("、")),
    structureStage("local", "章节局部格式", preview.workflow.local.files, preview.workflow.local.responsibilities.join("、")),
    structureStage("references", "参考文献库", bibliographyFiles, preview.workflow.references.responsibilities.join("、"))
  );
  elements.structureFileList.replaceChildren();
  const files = [
    { kind: "GLOBAL", file: preview.mainTex, detail: "保留全局排版、宏包和 Bib 调用" },
    ...preview.sections.map((section) => ({
      kind: "LOCAL",
      file: section.file,
      detail: `${section.title} · 原第 ${section.startLine}-${section.endLine} 行`
    })),
    ...bibliographyFiles.map((file) => ({
      kind: "BIB",
      file,
      detail: canMigrateBibliography ? "将从内嵌参考文献创建" : "保持独立，不由格式模型重写"
    }))
  ];
  for (const item of files) {
    const row = document.createElement("div");
    row.className = "structure-file-row";
    const kind = document.createElement("span");
    kind.className = `structure-file-kind ${item.kind.toLowerCase()}`;
    kind.textContent = item.kind;
    const file = document.createElement("strong");
    file.textContent = item.file;
    const detail = document.createElement("span");
    detail.textContent = item.detail;
    row.append(kind, file, detail);
    elements.structureFileList.append(row);
  }
  elements.structureWarning.textContent = canMigrateBibliography
    ? "迁移会保留全部引用键和原始文献文本；迁移或编译失败时自动恢复，不会留下不完整的 Bib 文件。"
    : preview.eligible
      ? "拆分不会改写正文、公式、图片、表格或 Bib 条目；编译失败时自动恢复。"
      : preview.reason;
  elements.structureWarning.classList.toggle("hidden", !elements.structureWarning.textContent);
  elements.structureWarning.classList.toggle("error", !preview.eligible && !canMigrateBibliography);
  elements.migrateBibliographyButton.classList.toggle("hidden", !canMigrateBibliography);
  elements.migrateBibliographyButton.disabled = !canMigrateBibliography;
  elements.applyStructureButton.disabled = !preview.eligible;
  refreshIcons();
}

async function migrateInlineBibliography(preview) {
  const migration = preview?.bibliographyMigration;
  if (!migration?.eligible) throw new Error(migration?.reason || "当前参考文献不能自动迁移。");
  const result = await api("/api/project/bibliography/migrate", {
    method: "POST",
    body: JSON.stringify({ confirmed: true, fingerprint: migration.fingerprint })
  });
  updateBuild(result.build);
  await refreshProject({ preserveDocument: false });
  return result;
}

async function migrateBibliographyForStructure() {
  const preview = state.structurePreview;
  if (!preview?.bibliographyMigration?.eligible) return;
  setBusy(elements.migrateBibliographyButton, true);
  elements.applyStructureButton.disabled = true;
  try {
    const result = await migrateInlineBibliography(preview);
    if (state.mode === "source" && state.sourceFile) await loadSourceFile(state.sourceFile, { force: true });
    const nextPreview = await api("/api/project/modularize/preview", { method: "POST", body: "{}" });
    renderStructurePreview(nextPreview);
    toast(`参考文献迁移完成：${result.entries.length} 条文献已写入 ${result.files.map((file) => file.file).join("、")}。`, "success", 6800);
  } catch (error) {
    if (error.payload?.details?.errors) updateBuild(error.payload.details);
    toast(error.message, "error", 7600);
  } finally {
    setBusy(elements.migrateBibliographyButton, false);
    elements.applyStructureButton.disabled = !state.structurePreview?.eligible;
  }
}

async function previewPaperStructure() {
  if (state.sourceDirty) {
    toast("请先保存或放弃当前源码修改，再预览章节拆分。", "error", 5200);
    return;
  }
  setBusy(elements.modularizeButton, true);
  try {
    const preview = await api("/api/project/modularize/preview", { method: "POST", body: "{}" });
    renderStructurePreview(preview);
    elements.structureDialog.showModal();
  } catch (error) {
    toast(error.message, "error", 6200);
  } finally {
    setBusy(elements.modularizeButton, false);
  }
}

async function applyPaperStructure(event) {
  event.preventDefault();
  const preview = state.structurePreview;
  if (!preview?.eligible) return;
  setBusy(elements.applyStructureButton, true);
  try {
    const result = await api("/api/project/modularize/apply", {
      method: "POST",
      body: JSON.stringify({ confirmed: true, fingerprint: preview.fingerprint })
    });
    elements.structureDialog.close();
    state.structurePreview = null;
    updateBuild(result.build);
    await refreshProject({ preserveDocument: false });
    setMode("source");
    await loadSourceFile(state.project.config.mainTex, { force: true });
    toast(`章节拆分完成：${result.sections.length} 个章节文件，Bib 文件保持独立。`, "success", 6200);
  } catch (error) {
    if (error.payload?.details?.errors) updateBuild(error.payload.details);
    toast(error.message, "error", 7600);
  } finally {
    setBusy(elements.applyStructureButton, false);
  }
}

async function compilePaper() {
  if (state.sourceDirty) {
    await saveSourceFile();
    return;
  }
  const button = document.querySelector("#compileButton");
  setBusy(button, true);
  try {
    const build = await api("/api/compile", { method: "POST", body: "{}" });
    updateBuild(build);
    await refreshProject();
    const warningCount = build.warnings?.length || 0;
    toast(
      build.success
        ? warningCount ? `英文 PDF 已生成，包含 ${warningCount} 条编译警告。` : "英文 PDF 已重新编译。"
        : "编译失败。",
      build.success ? "success" : "error"
    );
  } catch (error) {
    toast(error.message, "error");
  } finally {
    setBusy(button, false);
  }
}

async function pullPaper() {
  if (state.sourceDirty) {
    toast("请先保存或放弃源码修改，再拉取远端版本。", "error", 5200);
    return;
  }
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
  if (state.sourceDirty) {
    toast("请先保存源码修改，再推送论文。", "error", 5200);
    return;
  }
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
  if (!state.currentFile || !state.currentDocument) return;
  const sectionId = state.currentSectionId || elements.translationSectionSelect.value;
  const sectionLabel = elements.translationSectionSelect.selectedOptions[0]?.textContent || "当前节";
  const pendingIds = state.currentDocument.segments
    .filter((segment) => (segment.sectionId || `${state.currentFile}:section:0`) === sectionId)
    .filter((segment) => !segment.chinese || segment.translationStatus !== "synced")
    .map((segment) => segment.id);
  if (!pendingIds.length) {
    toast("当前节没有需要生成或更新的中文段落。", "success");
    return;
  }
  const total = pendingIds.length;
  let completed = 0;
  let translated = 0;
  let skipped = 0;
  setBusy(button, true);
  setFileTranslationProgress(0, total, `${sectionLabel} · 正在准备翻译...`);
  try {
    for (let offset = 0; offset < pendingIds.length; offset += 8) {
      const segmentIds = pendingIds.slice(offset, offset + 8);
      const end = Math.min(offset + segmentIds.length, total);
      setFileTranslationProgress(completed, total, `${sectionLabel} · 正在翻译第 ${offset + 1}-${end} 段...`);
      const result = await api("/api/file/translate-to-chinese", {
        method: "POST",
        body: JSON.stringify({ file: state.currentFile, sectionId, segmentIds })
      });
      state.currentDocument = result.document;
      completed += result.progress?.attempted ?? segmentIds.length;
      translated += result.progress?.translated ?? 0;
      skipped += result.progress?.skipped ?? 0;
      setFileTranslationProgress(completed, total, `${sectionLabel} · 已处理 ${completed} 个段落`);
    }
    renderSegments();
    await refreshProject();
    if (skipped) {
      setFileTranslationProgress(completed, total, `翻译完成，${skipped} 段未收到有效结果`, "warning");
      toast(`中文工作稿已更新，模型没有返回其中 ${skipped} 个段落的有效翻译。`, "error", 5600);
    } else {
      setFileTranslationProgress(completed, total, `翻译完成，共更新 ${translated} 个段落`);
      toast("当前文件的中文工作稿已更新。", "success");
    }
  } catch (error) {
    if (state.currentDocument) renderSegments();
    setFileTranslationProgress(completed, total, `翻译中断：${error.message}`, "error");
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

function renderFormatWorkflow(workflow, execution = null) {
  elements.formatWorkflow.replaceChildren();
  if (!workflow) return;
  if (workflow.mode === "monolithic") {
    const warning = document.createElement("div");
    warning.className = "format-workflow-warning";
    warning.textContent = "当前正文仍集中在主文件中。建议先进入 TeX 页面按章节拆分，以降低格式迁移所需上下文。";
    elements.formatWorkflow.append(warning);
  }
  const stages = document.createElement("div");
  stages.className = "format-workflow-stages";
  for (const stage of workflow.stages || []) {
    const row = document.createElement("div");
    row.className = `format-workflow-stage ${stage.scope}`;
    const label = document.createElement("strong");
    label.textContent = stage.label;
    const files = document.createElement("span");
    files.textContent = stage.files.length ? stage.files.join("、") : "未引用文件";
    const completed = execution?.stages?.find((item) => item.id === stage.id);
    const meta = document.createElement("small");
    meta.textContent = stage.readOnly
      ? "独立保留，不重写 Bib 条目"
      : completed ? `${completed.operations} 个精确操作` : stage.responsibilities.join("、");
    row.append(label, files, meta);
    stages.append(row);
  }
  elements.formatWorkflow.append(stages);
}

function renderFormatJob(job) {
  state.formatJob = job;
  if (!job) {
    elements.formatAnalysisSection.classList.add("hidden");
    elements.formatMeta.textContent = "尚未分析目标格式";
    elements.formatWorkflow.replaceChildren();
    return;
  }
  if (!state.formatFiles.length && job.sourceFiles?.length) renderFormatFiles(job.sourceFiles);
  if (job.requirements && !elements.formatRequirements.value) elements.formatRequirements.value = job.requirements;
  if (!job.analysis) {
    elements.formatAnalysisSection.classList.add("hidden");
    elements.formatMeta.textContent = "格式分析未完成";
    elements.formatWorkflow.replaceChildren();
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
  const executionParts = [];
  if (job.execution?.operations) executionParts.push(`${job.execution.operations} 个精确操作`);
  if (job.execution?.modelAttempts > 1) executionParts.push(`${job.execution.modelAttempts} 次模型响应`);
  if (job.execution?.compileRepairAttempts) executionParts.push(`${job.execution.compileRepairAttempts} 次编译修复`);
  if (!job.execution && job.analysis.modelAttempts > 1) executionParts.push(`${job.analysis.modelAttempts} 次模型响应`);
  elements.formatMeta.textContent = [
    `${job.analysis.differences.length} 项格式差异`,
    ...executionParts
  ].join(" · ");
  renderFormatWorkflow(job.workflow, job.execution);
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
    const categoryText = document.createElement("span");
    categoryText.textContent = difference.category;
    const scope = document.createElement("small");
    scope.className = `format-scope ${difference.scope || "global"}`;
    scope.textContent = difference.scope === "local"
      ? "局部"
      : difference.scope === "references" ? "Bib" : difference.scope === "both" ? "整体+局部" : "整体";
    category.append(categoryText, scope);
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

function resolveFormatPreflight(proceed) {
  const resolver = state.formatPreflightResolver;
  state.formatPreflightResolver = null;
  if (elements.formatPreflightDialog.open) elements.formatPreflightDialog.close();
  resolver?.(proceed);
}

function renderFormatPreflight(preview) {
  const alreadySplit = preview.mode === "modular";
  const migration = preview.bibliographyMigration;
  const canMigrateBibliography = preview.mode === "bibliography-required" && migration?.eligible;
  const bibliographyFiles = canMigrateBibliography
    ? migration.files.map((file) => file.file)
    : preview.workflow.references.files;
  state.formatPreflightPreview = preview;
  elements.formatPreflightSummary.textContent = alreadySplit
    ? "当前论文已经按章节组织，可以直接进入格式分析与迁移。"
    : canMigrateBibliography
      ? `检测到 ${migration.entries.length} 条内嵌参考文献。PaperBridge 可以先迁移到独立 Bib，再拆分章节并继续格式迁移。`
    : preview.eligible
      ? `检测到 ${preview.sections.length} 个章节。推荐先拆分，main.tex 仅保留整体格式，各章节文件分别迁移。`
      : `当前项目暂时不能安全自动拆分：${preview.reason}`;
  elements.formatPreflightFlow.replaceChildren(
    structureStage("global", "检查项目结构", [preview.mainTex], "识别主文件、章节和参考文献"),
    structureStage("local", "准备章节文件（推荐）", preview.workflow.local.files, "必要时先迁移 Bib，再按章节拆分"),
    structureStage("references", "分析并迁移格式", bibliographyFiles, "先整体格式，再逐章处理；Bib 独立保留")
  );
  elements.formatPreflightWarning.textContent = alreadySplit
    ? "章节结构已经准备好，格式迁移将按整体格式和局部章节分阶段执行。"
    : canMigrateBibliography
      ? "一键准备会保留引用键与原始文献文本，并在每一步编译验证。也可以不拆分继续，但论文较长时可能超过模型上下文限制，导致格式迁移失败。"
    : "如果选择不拆分，AI 需要一次读取更长的上下文；论文较长时可能超过模型的上下文限制，导致分析不完整或格式迁移失败。";
  elements.formatPreflightWarning.classList.toggle("ready", alreadySplit);
  elements.splitForFormatButton.disabled = alreadySplit || (!preview.eligible && !canMigrateBibliography);
  elements.splitForFormatButton.title = alreadySplit
    ? "当前项目已经按章节组织"
    : canMigrateBibliography
      ? "迁移参考文献、拆分章节、重新编译，然后继续格式分析"
      : preview.eligible ? "拆分、重新编译，然后继续格式分析" : preview.reason;
  elements.splitForFormatButton.querySelector("span").textContent = alreadySplit
    ? "已完成章节拆分"
    : canMigrateBibliography ? "迁移 Bib、拆分并继续" : "一键拆分并继续";
  elements.continueWithoutSplitButton.querySelector("span").textContent = alreadySplit ? "继续分析格式" : "不拆分，继续";
  refreshIcons();
}

async function openFormatPreflight() {
  const preview = await api("/api/project/modularize/preview", { method: "POST", body: "{}" });
  renderFormatPreflight(preview);
  return new Promise((resolve) => {
    state.formatPreflightResolver = resolve;
    elements.formatPreflightDialog.showModal();
  });
}

async function splitForFormatMigration() {
  let preview = state.formatPreflightPreview;
  const canMigrateBibliography = preview?.mode === "bibliography-required" && preview.bibliographyMigration?.eligible;
  if (!preview?.eligible && !canMigrateBibliography) return;
  setBusy(elements.splitForFormatButton, true);
  elements.continueWithoutSplitButton.disabled = true;
  let bibliographyMigrated = false;
  try {
    if (canMigrateBibliography) {
      const migration = await migrateInlineBibliography(preview);
      bibliographyMigrated = true;
      toast(`已迁移 ${migration.entries.length} 条参考文献，正在拆分章节。`, "success", 5200);
      preview = await api("/api/project/modularize/preview", { method: "POST", body: "{}" });
      if (!preview.eligible) throw new Error(preview.reason || "参考文献已迁移，但当前项目仍不能自动拆分。可选择不拆分继续格式迁移。");
    }
    const result = await api("/api/project/modularize/apply", {
      method: "POST",
      body: JSON.stringify({ confirmed: true, fingerprint: preview.fingerprint })
    });
    updateBuild(result.build);
    await refreshProject({ preserveDocument: false });
    toast(`${bibliographyMigrated ? "参考文献迁移和" : ""}章节拆分完成：${result.sections.length} 个章节文件。正在继续分析格式。`, "success", 6200);
    resolveFormatPreflight(true);
  } catch (error) {
    if (error.payload?.details?.errors) updateBuild(error.payload.details);
    if (bibliographyMigrated) {
      const latest = await api("/api/project/modularize/preview", { method: "POST", body: "{}" }).catch(() => null);
      if (latest) renderFormatPreflight(latest);
      toast(`参考文献已经迁移，但章节拆分未完成：${error.message}。你仍可选择不拆分继续格式迁移。`, "error", 9000);
    } else {
      toast(error.message, "error", 7600);
    }
  } finally {
    setBusy(elements.splitForFormatButton, false);
    elements.continueWithoutSplitButton.disabled = false;
  }
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
  try {
    const proceed = await openFormatPreflight();
    if (!proceed) return;
    elements.formatMeta.textContent = "正在解析并比较格式...";
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
  const confirmed = window.confirm("将先修改 main.tex 的整体格式，再逐个处理章节文件；Bib 条目保持独立。编译失败时会自动恢复原文件。继续吗？");
  if (!confirmed) return;
  const button = document.querySelector("#applyFormatButton");
  setBusy(button, true);
  elements.formatStatus.textContent = "整体格式 → 局部章节";
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
    if (error.payload?.details?.pdf || error.payload?.details?.warnings || error.payload?.details?.errors) updateBuild(error.payload.details);
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

function setMode(mode, { loadCurrent = true } = {}) {
  if (state.mode === "source" && mode !== "source" && state.sourceDirty) {
    if (!confirmDiscardSourceChanges()) return false;
    elements.sourceEditor.value = state.sourceSavedContent;
    updateSourceLineNumbers();
    setSourceDirty(false);
  }
  state.mode = mode;
  document.querySelectorAll(".mode-button").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  elements.editView.classList.toggle("hidden", mode !== "edit");
  elements.sourceView.classList.toggle("hidden", mode !== "source");
  elements.reviewView.classList.toggle("hidden", mode !== "review");
  elements.formatView.classList.toggle("hidden", mode !== "format");
  if (mode === "source") {
    renderSourceFileOptions();
    if (loadCurrent) void loadSourceFile(elements.sourceFileSelect.value, { force: true });
  }
  if (mode === "edit" && state.currentFile && loadCurrent) void loadDocument(state.currentFile);
  if (mode === "review") loadReview();
  if (mode === "format") loadLatestFormatJob();
  return true;
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
      <small class="field-note provider-key-status" id="${prefix}ApiKeyStatus"></small>
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
  const keyStatus = document.querySelector(`#${prefix}ApiKeyStatus`);
  keyStatus.textContent = profile.hasApiKey ? "已保存 API Key" : "尚未配置 API Key";
  keyStatus.classList.toggle("missing", !profile.hasApiKey);
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
  state.storageRootSelected = false;
  document.querySelector("#storageRootInput").value = config.storageRoot || config.suggestedStorageRoot || "";
  document.querySelector("#chooseStorageFolderButton").disabled = config.canChangeStorage === false;
  document.querySelector("#projectRootInput").value = config.projectRoot;
  const overleafToken = document.querySelector("#overleafTokenInput");
  overleafToken.value = "";
  overleafToken.placeholder = config.hasOverleafToken ? "已保存，留空保持不变" : "用于自动拉取和推送";
  document.querySelector("#gitUsernameInput").value = config.gitUsername || "";
  const gitToken = document.querySelector("#gitTokenInput");
  gitToken.value = "";
  gitToken.placeholder = config.hasGitToken ? "已保存，留空保持不变" : "私有仓库使用 Personal Access Token";
  document.querySelector("#mainTexInput").value = config.mainTex;
  const mainTexCandidates = document.querySelector("#mainTexCandidates");
  mainTexCandidates.replaceChildren();
  for (const file of state.project.mainTexCandidates || []) {
    const option = document.createElement("option");
    option.value = file;
    mainTexCandidates.append(option);
  }
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
  let previous = state.project.config;
  let projectRoot = document.querySelector("#projectRootInput").value.trim();
  const mainTex = document.querySelector("#mainTexInput").value.trim();
  const storageRoot = document.querySelector("#storageRootInput").value.trim();
  const storageChanged = state.storageRootSelected && storageRoot && storageRoot !== previous.storageRoot;
  if ((projectRoot !== previous.projectRoot || mainTex !== previous.mainTex || storageChanged) && state.sourceDirty) {
    if (!confirmDiscardSourceChanges()) return false;
    state.sourceDirty = false;
  }
  if (storageChanged) {
    const confirmed = window.confirm([
      "PaperBridge 将把配置、中文工作稿、备份和已导入的项目迁移到新位置。",
      "外部打开的本地论文文件夹不会移动。迁移完成前请勿关闭程序。",
      "",
      `新位置：${storageRoot}`
    ].join("\n"));
    if (!confirmed) return false;
    const oldProjectRoot = previous.projectRoot;
    const result = await api("/api/storage/migrate", {
      method: "POST",
      body: JSON.stringify({ storageRoot })
    });
    state.project = result.project;
    previous = state.project.config;
    if (projectRoot === oldProjectRoot) projectRoot = previous.projectRoot;
    document.querySelector("#storageRootInput").value = previous.storageRoot;
    state.storageRootSelected = false;
    document.querySelector("#projectRootInput").value = projectRoot;
    if (result.migration.cleanupWarning) toast(result.migration.cleanupWarning, "error", 7000);
  }
  const next = await api("/api/config", {
    method: "POST",
    body: JSON.stringify({
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
  elements.workspaceSplitHandle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    elements.workspaceSplitHandle.setPointerCapture(event.pointerId);
    document.body.classList.add("workspace-split-dragging");
    setWorkspaceSplit(event.clientX);
    event.preventDefault();
  });
  elements.workspaceSplitHandle.addEventListener("pointermove", (event) => {
    if (!elements.workspaceSplitHandle.hasPointerCapture(event.pointerId)) return;
    setWorkspaceSplit(event.clientX);
  });
  const finishWorkspaceSplit = (event) => {
    if (elements.workspaceSplitHandle.hasPointerCapture(event.pointerId)) {
      elements.workspaceSplitHandle.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("workspace-split-dragging");
    applyWorkspaceSplit();
  };
  elements.workspaceSplitHandle.addEventListener("pointerup", finishWorkspaceSplit);
  elements.workspaceSplitHandle.addEventListener("pointercancel", finishWorkspaceSplit);
  elements.workspaceSplitHandle.addEventListener("lostpointercapture", () => {
    document.body.classList.remove("workspace-split-dragging");
    applyWorkspaceSplit();
  });
  elements.workspaceSplitHandle.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    state.workspaceSplit = Math.min(72, Math.max(32, state.workspaceSplit + (event.key === "ArrowRight" ? 2 : -2)));
    applyWorkspaceSplit();
  });
  elements.workspaceSplitHandle.addEventListener("dblclick", () => {
    state.workspaceSplit = 54;
    applyWorkspaceSplit();
  });
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
  document.querySelector("#chooseSetupStorageButton").addEventListener("click", () => chooseStoragePath(document.querySelector("#setupStorageRoot")));
  document.querySelector("#chooseStorageFolderButton").addEventListener("click", async () => {
    if (await chooseStoragePath(document.querySelector("#storageRootInput"))) state.storageRootSelected = true;
  });
  document.querySelector("#storageRootInput").addEventListener("input", () => {
    state.storageRootSelected = true;
  });
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
  elements.mainTexForm.addEventListener("submit", (event) => {
    event.preventDefault();
    finishMainTexSelection();
  });
  elements.mainTexDialog.addEventListener("cancel", (event) => event.preventDefault());
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
  elements.translationSectionSelect.addEventListener("change", (event) => {
    state.currentSectionId = event.currentTarget.value;
    hideFileTranslationProgress();
  });
  elements.sourceFileSelect.addEventListener("change", async (event) => {
    const previous = state.sourceFile;
    const loaded = await loadSourceFile(event.currentTarget.value);
    if (!loaded) event.currentTarget.value = previous || "";
  });
  elements.sourceEditor.addEventListener("input", () => {
    updateSourceLineNumbers();
    setSourceDirty(elements.sourceEditor.value !== state.sourceSavedContent);
  });
  elements.sourceEditor.addEventListener("scroll", () => {
    elements.sourceLineNumbers.scrollTop = elements.sourceEditor.scrollTop;
  }, { passive: true });
  elements.sourceEditor.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      event.preventDefault();
      elements.sourceEditor.setRangeText("  ", elements.sourceEditor.selectionStart, elements.sourceEditor.selectionEnd, "end");
      elements.sourceEditor.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (event.key.toLowerCase() === "s" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void saveSourceFile();
    }
  });
  elements.saveSourceButton.addEventListener("click", saveSourceFile);
  elements.modularizeButton.addEventListener("click", previewPaperStructure);
  elements.structureForm.addEventListener("submit", applyPaperStructure);
  elements.migrateBibliographyButton.addEventListener("click", migrateBibliographyForStructure);
  document.querySelector("#closeStructureButton").addEventListener("click", () => elements.structureDialog.close());
  document.querySelector("#cancelStructureButton").addEventListener("click", () => elements.structureDialog.close());
  elements.splitForFormatButton.addEventListener("click", splitForFormatMigration);
  elements.continueWithoutSplitButton.addEventListener("click", () => resolveFormatPreflight(true));
  document.querySelector("#cancelFormatPreflightButton").addEventListener("click", () => resolveFormatPreflight(false));
  document.querySelector("#closeFormatPreflightButton").addEventListener("click", () => resolveFormatPreflight(false));
  elements.formatPreflightDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    resolveFormatPreflight(false);
  });
  elements.pdfScroll.addEventListener("pointerdown", beginPdfPan);
  elements.pdfScroll.addEventListener("pointermove", movePdfPan);
  elements.pdfScroll.addEventListener("pointerup", endPdfPan);
  elements.pdfScroll.addEventListener("pointercancel", endPdfPan);
  elements.pdfScroll.addEventListener("lostpointercapture", endPdfPan);
  elements.pdfScroll.addEventListener("wheel", zoomPdfWithWheel, { passive: false });
  elements.pdfScroll.addEventListener("dblclick", (event) => void locatePdfSelection(event));
  elements.pdfScroll.addEventListener("scroll", updateVisiblePdfPage, { passive: true });
  window.addEventListener("resize", () => schedulePdfPanelResize());
  document.querySelector("#warningsButton").addEventListener("click", () => elements.buildDrawer.classList.toggle("hidden"));
  document.querySelector("#closeWarningsButton").addEventListener("click", () => elements.buildDrawer.classList.add("hidden"));
  document.querySelectorAll(".mode-button").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
  window.addEventListener("beforeunload", (event) => {
    if (!state.sourceDirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
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
  applyWorkspaceSplit(false);
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
