import * as pdfjsLib from "/vendor/pdfjs/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";

const MAX_TERMINOLOGY_ENTRIES = 48;
const MAX_PARALLEL_SEGMENT_TRANSLATIONS = 6;
const CITATION_DRAG_TYPE = "application/x-paperbridge-citation";
const UNDO_TRACKED_URLS = new Set([
  "/api/format/apply",
  "/api/project/bibliography/migrate",
  "/api/references/add",
  "/api/project/modularize/apply",
  "/api/source/create",
  "/api/source",
  "/api/math-block",
  "/api/math-block/move",
  "/api/table-block",
  "/api/figure/insert",
  "/api/segment/chinese",
  "/api/segment/translate",
  "/api/segment/add",
  "/api/segment/delete",
  "/api/segment/comment",
  "/api/segment/english",
  "/api/file/terminology",
  "/api/file/translate-to-chinese",
  "/api/file/terminology/apply"
]);
const FAST_PREVIEW_SECTION_PATTERN = /^\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)\b/;
const FAST_PREVIEW_BEGIN_END_PATTERN = /^\\(begin|end)\{/;
const FAST_PREVIEW_GROUPED_ENVS = new Set([
  "equation", "equation*", "align", "align*", "gather", "gather*",
  "multline", "multline*", "alignat", "alignat*", "flalign", "flalign*",
  "figure", "figure*", "table", "table*", "tabular", "tabular*",
  "tikzpicture", "pgfpicture", "verbatim", "lstlisting", "minted",
  "theorem", "lemma", "proposition", "corollary", "definition",
  "example", "remark", "proof", "abstract",
  "itemize", "enumerate", "description",
  "minipage", "center", "flushleft", "flushright",
  "thebibliography"
]);
const FAST_PREVIEW_PROSE_ENVS = new Set([
  "proof", "theorem", "lemma", "proposition", "corollary", "definition", "example", "remark", "abstract"
]);

const state = {
  project: null,
  currentFile: null,
  currentDocument: null,
  warnings: [],
  mode: "edit",
  saveTimers: new Map(),
  pendingWrites: 0,
  undoCount: 0,
  undoLabel: "",
  previewMode: "fast",
  fastPreviewFile: "",
  fastPreviewCache: [],
  fastPreviewTimer: 0,
  fastPreviewToken: 0,
  fastPreviewMathObserver: null,
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
  pdfCaptionIndex: null,
  pdfCaptionIndexPromise: null,
  pdfSourceIndex: null,
  pdfSourceIndexPromise: null,
  pdfNavigationToken: 0,
  pdfNavigationBusy: false,
  pdfExportToken: 0,
  buildPreviewAvailable: null,
  formatFiles: [],
  formatJob: null,
  editorFontSize: Math.min(20, Math.max(14, Number(localStorage.getItem("paperBridge.editorFontSize") || 16))),
  bilingualSplit: Math.min(70, Math.max(30, Number(localStorage.getItem("paperBridge.bilingualSplit") || 50))),
  workspaceSplit: Math.min(72, Math.max(32, Number(localStorage.getItem("paperBridge.workspaceSplit") || 54))),
  resizeFrame: 0,
  projectRefreshTimer: 0,
  setupMode: "initial",
  storageRootSelected: false,
  paragraphAnchor: null,
  figureAnchor: null,
  gitPushResolver: null,
  gitConflictResolver: null,
  gitManagement: null,
  gitManagementProject: null,
  gitManagementToken: 0,
  gitRemoteName: "",
  currentSectionId: null,
  fileTranslationJobs: new Map(),
  segmentTranslationJobs: new Map(),
  segmentTranslationQueue: [],
  activeSegmentTranslations: 0,
  lastFileTranslationProgress: null,
  visibleTranslationJobFile: "",
  mainTexResolver: null,
  sourceFile: null,
  sourceHash: "",
  sourceEol: "\n",
  sourceSavedContent: "",
  sourceDirty: false,
  sourceSearchQuery: "",
  sourceSearchMatches: [],
  sourceSearchIndex: -1,
  sourceHighlightTimer: 0,
  references: null,
  selectedReferenceKey: "",
  citationTarget: null,
  structurePreview: null,
  formatPreflightPreview: null,
  formatPreflightResolver: null,
  compileDiagnosisToken: 0,
  compileDiagnosisFingerprint: "",
  dismissedBuildDrawerFingerprint: "",
  terminologyFile: null,
  terminologyEntries: [],
  terminologyDirty: false,
  draggingMathBlock: null
};

const elements = {
  workspace: document.querySelector(".workspace"),
  sidebar: document.querySelector(".sidebar"),
  projectName: document.querySelector("#projectName"),
  syncState: document.querySelector("#syncState"),
  undoButton: document.querySelector("#undoButton"),
  undoCount: document.querySelector("#undoCount"),
  gitRemoteTarget: document.querySelector("#gitRemoteTarget"),
  gitRemoteSelect: document.querySelector("#gitRemoteSelect"),
  sidebarProjectList: document.querySelector("#sidebarProjectList"),
  documentCount: document.querySelector("#documentCount"),
  documentList: document.querySelector("#documentList"),
  translationProgress: document.querySelector("#translationProgress"),
  translationProgressBar: document.querySelector("#translationProgressBar"),
  terminologyButton: document.querySelector("#terminologyButton"),
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
  previewModeLabel: document.querySelector("#previewModeLabel"),
  previewCompileButton: document.querySelector("#previewCompileButton"),
  exportPdfButton: document.querySelector("#exportPdfButton"),
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
  createTexFileButton: document.querySelector("#createTexFileButton"),
  insertFigureSourceButton: document.querySelector("#insertFigureSourceButton"),
  modularizeButton: document.querySelector("#modularizeButton"),
  sourceSearchInput: null,
  sourceSearchCount: null,
  sourceSearchPreviousButton: null,
  sourceSearchNextButton: null,
  referencesView: document.querySelector("#referencesView"),
  referencesMeta: document.querySelector("#referencesMeta"),
  referencesSearch: document.querySelector("#referencesSearch"),
  referencesAlerts: document.querySelector("#referencesAlerts"),
  referencesList: document.querySelector("#referencesList"),
  referenceDetail: document.querySelector("#referenceDetail"),
  refreshReferencesButton: document.querySelector("#refreshReferencesButton"),
  insertSelectedReferenceButton: document.querySelector("#insertSelectedReferenceButton"),
  closeReferencesButton: document.querySelector("#closeReferencesButton"),
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
  recentProjectList: document.querySelector("#recentProjectList"),
  dependencyStatus: document.querySelector("#dependencyStatus"),
  settingsDialog: document.querySelector("#settingsDialog"),
  settingsForm: document.querySelector("#settingsForm"),
  mainTexDialog: document.querySelector("#mainTexDialog"),
  mainTexForm: document.querySelector("#mainTexForm"),
  mainTexSelect: document.querySelector("#mainTexSelect"),
  paragraphDialog: document.querySelector("#paragraphDialog"),
  paragraphForm: document.querySelector("#paragraphForm"),
  newParagraphChinese: document.querySelector("#newParagraphChinese"),
  figureDialog: document.querySelector("#figureDialog"),
  figureForm: document.querySelector("#figureForm"),
  figureAnchorMeta: document.querySelector("#figureAnchorMeta"),
  figureImagesInput: document.querySelector("#figureImagesInput"),
  figurePlacementInput: document.querySelector("#figurePlacementInput"),
  figureCaptionInput: document.querySelector("#figureCaptionInput"),
  figureLabelInput: document.querySelector("#figureLabelInput"),
  insertFigureSubmitButton: document.querySelector("#insertFigureSubmitButton"),
  gitManagerDialog: document.querySelector("#gitManagerDialog"),
  gitManagerProjectMeta: document.querySelector("#gitManagerProjectMeta"),
  gitRemoteList: document.querySelector("#gitRemoteList"),
  gitRemoteForm: document.querySelector("#gitRemoteForm"),
  gitRemoteOriginalName: document.querySelector("#gitRemoteOriginalName"),
  gitRemoteProvider: document.querySelector("#gitRemoteProvider"),
  gitRemoteName: document.querySelector("#gitRemoteName"),
  gitRemoteUrl: document.querySelector("#gitRemoteUrl"),
  gitRemoteCredential: document.querySelector("#gitRemoteCredential"),
  gitRemoteDefault: document.querySelector("#gitRemoteDefault"),
  gitCredentialList: document.querySelector("#gitCredentialList"),
  gitCredentialForm: document.querySelector("#gitCredentialForm"),
  gitCredentialId: document.querySelector("#gitCredentialId"),
  gitCredentialName: document.querySelector("#gitCredentialName"),
  gitCredentialProvider: document.querySelector("#gitCredentialProvider"),
  gitCredentialUsernameField: document.querySelector("#gitCredentialUsernameField"),
  gitCredentialUsername: document.querySelector("#gitCredentialUsername"),
  gitCredentialToken: document.querySelector("#gitCredentialToken"),
  gitCredentialScope: document.querySelector("#gitCredentialScope"),
  gitManagerStatus: document.querySelector("#gitManagerStatus"),
  gitPushDialog: document.querySelector("#gitPushDialog"),
  gitPushForm: document.querySelector("#gitPushForm"),
  gitPushList: document.querySelector("#gitPushList"),
  gitConflictDialog: document.querySelector("#gitConflictDialog"),
  gitConflictForm: document.querySelector("#gitConflictForm"),
  gitConflictMeta: document.querySelector("#gitConflictMeta"),
  gitConflictList: document.querySelector("#gitConflictList"),
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
  terminologyDialog: document.querySelector("#terminologyDialog"),
  terminologyMeta: document.querySelector("#terminologyMeta"),
  terminologySearch: document.querySelector("#terminologySearch"),
  terminologyList: document.querySelector("#terminologyList"),
  terminologyEmpty: document.querySelector("#terminologyEmpty"),
  terminologyStatus: document.querySelector("#terminologyStatus"),
  regenerateTerminologyButton: document.querySelector("#regenerateTerminologyButton"),
  applyTerminologyDefinitionsButton: document.querySelector("#applyTerminologyDefinitionsButton"),
  addTerminologyButton: document.querySelector("#addTerminologyButton"),
  saveTerminologyButton: document.querySelector("#saveTerminologyButton"),
  referenceInsertDialog: document.querySelector("#referenceInsertDialog"),
  referenceInsertForm: document.querySelector("#referenceInsertForm"),
  referenceInsertMeta: document.querySelector("#referenceInsertMeta"),
  referenceInsertSearch: document.querySelector("#referenceInsertSearch"),
  referenceInsertList: document.querySelector("#referenceInsertList"),
  referenceAddDialog: document.querySelector("#referenceAddDialog"),
  referenceAddForm: document.querySelector("#referenceAddForm"),
  referenceAddUrl: document.querySelector("#referenceAddUrl"),
  referenceAddBibFile: document.querySelector("#referenceAddBibFile"),
  referenceAddKey: document.querySelector("#referenceAddKey"),
  referenceAddBib: document.querySelector("#referenceAddBib"),
  referenceAddStatus: document.querySelector("#referenceAddStatus"),
  referenceLookupButton: document.querySelector("#referenceLookupButton"),
  referenceAddSubmitButton: document.querySelector("#addReferenceButtonSubmit"),
  closeReferenceAddButton: document.querySelector("#closeReferenceAddButton"),
  cancelReferenceAddButton: document.querySelector("#cancelReferenceAddButton"),
  addReferenceButton: document.querySelector("#addReferenceButton"),
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

function recentProjectTimeLabel(value) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return "";
  const days = Math.max(0, Math.floor((Date.now() - time) / 86_400_000));
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 30) return `${days} 天前`;
  return new Date(time).toLocaleDateString();
}

function projectGitServices(project) {
  return [...new Set((project?.git?.remotes || [])
    .map((remote) => String(remote.label || "").trim())
    .filter(Boolean))];
}

function projectGitServiceText(project) {
  const services = projectGitServices(project);
  return services.length ? services.join(" + ") : "未连接 Git";
}

function renderRecentProjects(project) {
  const section = document.querySelector("#recentProjectsSection");
  const list = elements.recentProjectList;
  const projects = project.config?.recentProjects || [];
  section.classList.toggle("hidden", projects.length === 0);
  list.replaceChildren();
  const currentRoot = String(project.config?.projectRoot || "").toLowerCase();
  const currentMainTex = String(project.config?.mainTex || "").toLowerCase();
  for (const item of projects) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "recent-project-button";
    button.innerHTML = `
      <i data-lucide="folder"></i>
      <div>
        <div class="recent-project-main"></div>
        <div class="recent-project-path"></div>
      </div>
      <div class="recent-project-meta"></div>
    `;
    const isCurrent = currentRoot === String(item.projectRoot || "").toLowerCase()
      && currentMainTex === String(item.mainTex || "").toLowerCase();
    button.querySelector(".recent-project-main").textContent = `${item.name || "论文项目"} · ${item.mainTex}`;
    button.querySelector(".recent-project-path").textContent = item.projectRoot;
    button.querySelector(".recent-project-meta").textContent = [
      isCurrent ? "当前项目" : recentProjectTimeLabel(item.updatedAt),
      projectGitServiceText(item)
    ].filter(Boolean).join(" · ");
    button.addEventListener("click", () => openRecentProject(item, button));
    list.append(button);
  }
}

function renderSidebarProjectList(project = state.project) {
  const list = elements.sidebarProjectList;
  if (!list) return;
  const projects = project?.config?.recentProjects || [];
  list.replaceChildren();
  if (!projects.length) {
    const empty = document.createElement("div");
    empty.className = "project-switch-empty";
    empty.textContent = "当前项目";
    list.append(empty);
    return;
  }
  const currentRoot = String(project.config?.projectRoot || "").toLowerCase();
  const currentMainTex = String(project.config?.mainTex || "").toLowerCase();
  for (const item of projects) {
    const row = document.createElement("div");
    const button = document.createElement("button");
    const manageButton = document.createElement("button");
    const isCurrent = currentRoot === String(item.projectRoot || "").toLowerCase()
      && currentMainTex === String(item.mainTex || "").toLowerCase();
    row.className = "project-switch-row";
    button.type = "button";
    button.className = `project-switch-button ${isCurrent ? "active" : ""}`;
    button.title = item.projectRoot || "";
    button.innerHTML = `
      <i data-lucide="${isCurrent ? "folder-open" : "folder"}"></i>
      <span class="project-switch-copy">
        <span class="project-switch-name"></span>
        <span class="project-git-services"></span>
      </span>
    `;
    button.querySelector(".project-switch-name").textContent = item.name || fileLabel(item.projectRoot || "论文项目");
    button.querySelector(".project-git-services").textContent = projectGitServiceText(item);
    button.addEventListener("click", () => {
      if (!isCurrent) void openRecentProject(item, button);
    });
    manageButton.type = "button";
    manageButton.className = "project-git-manage-button";
    manageButton.title = projectGitServices(item).length ? "管理 Git 远端" : "连接远端";
    manageButton.setAttribute("aria-label", `${item.name || "论文项目"}：${manageButton.title}`);
    manageButton.innerHTML = `
      <i data-lucide="${projectGitServices(item).length ? "git-branch" : "link-2"}"></i>
      <span>${projectGitServices(item).length ? "管理" : "连接远端"}</span>
    `;
    manageButton.addEventListener("click", () => void openGitManager(item));
    row.append(button, manageButton);
    list.append(row);
  }
  refreshIcons();
}

async function openRecentProject(project, button) {
  if (state.sourceDirty) {
    if (!confirmDiscardSourceChanges()) return;
    state.sourceDirty = false;
  }
  setBusy(button, true);
  if (elements.setupDialog.open) setSetupMessage("正在打开历史项目...");
  try {
    await api("/api/project/open", {
      method: "POST",
      body: JSON.stringify({ projectRoot: project.projectRoot, mainTex: project.mainTex })
    });
    if (elements.setupDialog.open) elements.setupDialog.close();
    const ready = await refreshProject({ preserveDocument: false });
    if (ready) toast("已切换到历史项目。", "success");
  } catch (error) {
    if (elements.setupDialog.open) setSetupMessage(`无法打开历史项目：${error.message}`, "error");
    toast(`无法打开历史项目：${error.message}`, "error", 6200);
  } finally {
    setBusy(button, false);
  }
}

function setGitManagerStatus(message = "", type = "") {
  elements.gitManagerStatus.textContent = message;
  elements.gitManagerStatus.className = `setup-message ${type}`.trim();
}

function gitManagerActionButton(icon, title, handler, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-button small ${className}`.trim();
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = `<i data-lucide="${icon}"></i>`;
  button.addEventListener("click", handler);
  return button;
}

function gitServiceClass(label = "") {
  const normalized = String(label).toLowerCase();
  if (normalized.includes("overleaf")) return "overleaf";
  if (normalized.includes("github")) return "github";
  if (normalized.includes("gitlab")) return "gitlab";
  return "git";
}

function renderGitCredentialOptions(provider = elements.gitRemoteProvider.value, selectedId = "") {
  const profiles = (state.gitManagement?.credentialProfiles || [])
    .filter((profile) => profile.provider === provider);
  const options = [new Option("自动选择兼容凭据", "")];
  for (const profile of profiles) {
    const scope = profile.scope === "project" ? "当前项目" : "共享";
    const token = profile.hasToken ? "已保存 Token" : "未保存 Token";
    options.push(new Option(`${profile.name} · ${scope} · ${token}`, profile.id));
  }
  elements.gitRemoteCredential.replaceChildren(...options);
  elements.gitRemoteCredential.value = profiles.some((profile) => profile.id === selectedId) ? selectedId : "";
}

function updateGitRemoteProviderForm({ preserveCredential = true } = {}) {
  const provider = elements.gitRemoteProvider.value;
  const currentCredential = preserveCredential ? elements.gitRemoteCredential.value : "";
  if (provider === "overleaf") {
    elements.gitRemoteName.value = "overleaf";
    elements.gitRemoteName.readOnly = true;
    elements.gitRemoteUrl.placeholder = "https://cn.overleaf.com/project/...";
  } else {
    if (!elements.gitRemoteName.value || elements.gitRemoteName.value === "overleaf") {
      elements.gitRemoteName.value = "paperbridge";
    }
    elements.gitRemoteName.readOnly = false;
    elements.gitRemoteUrl.placeholder = "https://github.com/owner/repository.git";
  }
  renderGitCredentialOptions(provider, currentCredential);
}

function updateGitCredentialProviderForm() {
  const overleaf = elements.gitCredentialProvider.value === "overleaf";
  elements.gitCredentialUsernameField.classList.toggle("hidden", overleaf);
  elements.gitCredentialUsername.disabled = overleaf;
  if (overleaf) elements.gitCredentialUsername.value = "git";
}

function hideGitRemoteForm() {
  elements.gitRemoteForm.classList.add("hidden");
  elements.gitRemoteForm.reset();
  elements.gitRemoteOriginalName.value = "";
}

function showGitRemoteForm(remote = null) {
  hideGitCredentialForm();
  const provider = remote?.provider === "overleaf" ? "overleaf" : "git";
  elements.gitRemoteForm.reset();
  elements.gitRemoteOriginalName.value = remote?.name || "";
  elements.gitRemoteProvider.value = provider;
  elements.gitRemoteName.value = remote?.name || (provider === "overleaf" ? "overleaf" : "paperbridge");
  elements.gitRemoteUrl.value = remote?.url || "";
  elements.gitRemoteDefault.checked = remote ? remote.default === true : !(state.gitManagement?.remotes || []).length;
  elements.gitRemoteForm.classList.remove("hidden");
  updateGitRemoteProviderForm({ preserveCredential: false });
  elements.gitRemoteCredential.value = remote?.credentialProfileId || "";
  elements.gitRemoteUrl.focus();
  elements.gitRemoteForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideGitCredentialForm() {
  elements.gitCredentialForm.classList.add("hidden");
  elements.gitCredentialForm.reset();
  elements.gitCredentialId.value = "";
  elements.gitCredentialProvider.disabled = false;
  elements.gitCredentialScope.disabled = false;
}

function showGitCredentialForm(profile = null) {
  hideGitRemoteForm();
  elements.gitCredentialForm.reset();
  elements.gitCredentialId.value = profile?.id || "";
  elements.gitCredentialName.value = profile?.name || "";
  elements.gitCredentialProvider.value = profile?.provider === "overleaf" ? "overleaf" : "git";
  elements.gitCredentialUsername.value = profile?.username || "";
  elements.gitCredentialScope.value = profile?.scope === "project" ? "project" : "shared";
  elements.gitCredentialToken.value = "";
  elements.gitCredentialToken.placeholder = profile?.hasToken ? "已保存，留空保持不变" : "输入访问 Token";
  const legacy = ["saved-overleaf", "saved-git"].includes(profile?.id);
  elements.gitCredentialProvider.disabled = legacy;
  elements.gitCredentialScope.disabled = legacy;
  elements.gitCredentialForm.classList.remove("hidden");
  updateGitCredentialProviderForm();
  elements.gitCredentialName.focus();
  elements.gitCredentialForm.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderGitManager() {
  const management = state.gitManagement;
  elements.gitRemoteList.replaceChildren();
  elements.gitCredentialList.replaceChildren();
  if (!management) {
    const loading = document.createElement("div");
    loading.className = "git-manager-empty";
    loading.textContent = "正在读取项目 Git 配置...";
    elements.gitRemoteList.append(loading);
    return;
  }

  if (!management.remotes.length) {
    const empty = document.createElement("div");
    empty.className = "git-manager-empty";
    empty.textContent = "该项目尚未连接远端。点击“连接远端”即可为现有项目添加 GitHub、GitLab 或 Overleaf。";
    elements.gitRemoteList.append(empty);
  }
  for (const remote of management.remotes) {
    const row = document.createElement("div");
    row.className = "git-manager-row git-remote-row";
    const badge = document.createElement("span");
    badge.className = `git-service-badge ${gitServiceClass(remote.label)}`;
    badge.textContent = remote.label || "Git 远端";
    const copy = document.createElement("div");
    copy.className = "git-manager-row-copy";
    const title = document.createElement("div");
    title.className = "git-manager-row-title";
    title.textContent = `${remote.repository || remote.name} · ${remote.name}`;
    const meta = document.createElement("div");
    meta.className = "git-manager-row-meta";
    meta.textContent = `${remote.url} · 凭据：${remote.credentialName || "自动选择"}`;
    copy.append(title, meta);
    const stateNode = document.createElement("span");
    stateNode.className = `git-default-state ${remote.default ? "active" : ""}`;
    stateNode.textContent = remote.default ? "默认同步" : "非默认";
    const actions = document.createElement("div");
    actions.className = "git-manager-row-actions";
    if (!remote.default) {
      actions.append(gitManagerActionButton("star", "设为默认同步目标", (event) => void setDefaultGitRemote(remote, event.currentTarget)));
    }
    actions.append(
      gitManagerActionButton("plug-zap", "测试连接", (event) => void testSavedGitRemote(remote, event.currentTarget)),
      gitManagerActionButton("pencil", "修改远端", () => showGitRemoteForm(remote)),
      gitManagerActionButton("trash-2", "删除远端", (event) => void deleteGitRemote(remote, event.currentTarget), "danger")
    );
    row.append(badge, copy, stateNode, actions);
    elements.gitRemoteList.append(row);
  }

  if (!management.credentialProfiles.length) {
    const empty = document.createElement("div");
    empty.className = "git-manager-empty";
    empty.textContent = "尚未保存凭据配置。公开仓库可不使用 Token；私有仓库和 Overleaf 需要凭据。";
    elements.gitCredentialList.append(empty);
  }
  for (const profile of management.credentialProfiles) {
    const row = document.createElement("div");
    row.className = "git-manager-row git-credential-row";
    const badge = document.createElement("span");
    badge.className = `git-service-badge ${profile.provider === "overleaf" ? "overleaf" : "git"}`;
    badge.textContent = profile.provider === "overleaf" ? "Overleaf" : "Git";
    const copy = document.createElement("div");
    copy.className = "git-manager-row-copy";
    const title = document.createElement("div");
    title.className = "git-manager-row-title";
    title.textContent = profile.name;
    const meta = document.createElement("div");
    meta.className = "git-manager-row-meta";
    const scope = profile.scope === "project" ? "仅当前项目" : "多个项目共用";
    const token = profile.hasToken ? "Token 已保存" : "未保存 Token";
    meta.textContent = [scope, profile.username ? `用户：${profile.username}` : "", token].filter(Boolean).join(" · ");
    copy.append(title, meta);
    const actions = document.createElement("div");
    actions.className = "git-manager-row-actions";
    actions.append(
      gitManagerActionButton("pencil", "修改凭据", () => showGitCredentialForm(profile)),
      gitManagerActionButton("trash-2", "删除凭据", (event) => void deleteGitCredential(profile, event.currentTarget), "danger")
    );
    row.append(badge, copy, actions);
    elements.gitCredentialList.append(row);
  }
  refreshIcons();
}

async function openGitManager(project) {
  const addRemoteButton = document.querySelector("#addGitRemoteButton");
  const addCredentialButton = document.querySelector("#addGitCredentialButton");
  const token = ++state.gitManagementToken;
  state.gitManagementProject = project;
  state.gitManagement = null;
  elements.gitManagerProjectMeta.textContent = `${project.name || fileLabel(project.projectRoot || "论文项目")} · ${project.projectRoot}`;
  hideGitRemoteForm();
  hideGitCredentialForm();
  setGitManagerStatus();
  renderGitManager();
  setBusy(addRemoteButton, true);
  setBusy(addCredentialButton, true);
  if (!elements.gitManagerDialog.open) elements.gitManagerDialog.showModal();
  try {
    const management = await api(`/api/projects/git?projectRoot=${encodeURIComponent(project.projectRoot)}`);
    if (token !== state.gitManagementToken || !elements.gitManagerDialog.open) return;
    state.gitManagement = management;
    renderGitManager();
    setBusy(addRemoteButton, false);
    setBusy(addCredentialButton, false);
  } catch (error) {
    if (token !== state.gitManagementToken || !elements.gitManagerDialog.open) return;
    setGitManagerStatus(`读取 Git 配置失败：${error.message}`, "error");
  }
}

function closeGitManager() {
  state.gitManagementToken += 1;
  hideGitRemoteForm();
  hideGitCredentialForm();
  state.gitManagement = null;
  state.gitManagementProject = null;
  if (elements.gitManagerDialog.open) elements.gitManagerDialog.close();
}

function gitRemoteFormPayload() {
  return {
    projectRoot: state.gitManagement?.project?.projectRoot || state.gitManagementProject?.projectRoot || "",
    originalName: elements.gitRemoteOriginalName.value,
    provider: elements.gitRemoteProvider.value,
    name: elements.gitRemoteName.value.trim(),
    url: elements.gitRemoteUrl.value.trim(),
    credentialProfileId: elements.gitRemoteCredential.value,
    makeDefault: elements.gitRemoteDefault.checked
  };
}

async function refreshAfterGitManagement(management, message) {
  state.gitManagement = management;
  hideGitRemoteForm();
  hideGitCredentialForm();
  renderGitManager();
  setGitManagerStatus(message, "success");
  try {
    await refreshProject({ preserveDocument: true });
  } catch (error) {
    toast(`Git 配置已保存，但项目状态刷新失败：${error.message}`, "error", 5600);
  }
}

async function testGitRemotePayload(payload, button) {
  setBusy(button, true);
  setGitManagerStatus("正在测试远端连接...");
  try {
    const result = await api("/api/projects/git/test", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    setGitManagerStatus(result.message || "远端连接成功。", "success");
  } catch (error) {
    setGitManagerStatus(`连接失败：${error.message}`, "error");
  } finally {
    setBusy(button, false);
  }
}

async function testGitRemoteForm(event) {
  if (!elements.gitRemoteForm.reportValidity()) return;
  await testGitRemotePayload(gitRemoteFormPayload(), event.currentTarget);
}

async function testSavedGitRemote(remote, button) {
  await testGitRemotePayload({
    projectRoot: state.gitManagement.project.projectRoot,
    provider: remote.provider,
    name: remote.name,
    url: remote.url,
    credentialProfileId: remote.credentialProfileId || ""
  }, button);
}

async function saveGitRemote(event) {
  event.preventDefault();
  if (!elements.gitRemoteForm.reportValidity()) return;
  const button = document.querySelector("#saveGitRemoteButton");
  setBusy(button, true);
  setGitManagerStatus("正在测试并保存远端...");
  try {
    const management = await api("/api/projects/git/remote", {
      method: "POST",
      body: JSON.stringify(gitRemoteFormPayload())
    });
    await refreshAfterGitManagement(management, "远端已保存并通过连接测试。");
  } catch (error) {
    setGitManagerStatus(`远端保存失败：${error.message}`, "error");
  } finally {
    setBusy(button, false);
  }
}

async function setDefaultGitRemote(remote, button) {
  setBusy(button, true);
  try {
    const management = await api("/api/projects/git/default", {
      method: "POST",
      body: JSON.stringify({ projectRoot: state.gitManagement.project.projectRoot, remoteName: remote.name })
    });
    await refreshAfterGitManagement(management, `${remote.label} 已设为默认同步目标。`);
  } catch (error) {
    setGitManagerStatus(`设置默认远端失败：${error.message}`, "error");
  } finally {
    setBusy(button, false);
  }
}

async function deleteGitRemote(remote, button) {
  if (!window.confirm(`确定从该项目删除远端“${remote.name}”吗？\n\n不会删除远端仓库中的文件。`)) return;
  setBusy(button, true);
  try {
    const management = await api("/api/projects/git/remote", {
      method: "DELETE",
      body: JSON.stringify({ projectRoot: state.gitManagement.project.projectRoot, remoteName: remote.name })
    });
    await refreshAfterGitManagement(management, `远端“${remote.name}”已删除。`);
  } catch (error) {
    setGitManagerStatus(`删除远端失败：${error.message}`, "error");
  } finally {
    setBusy(button, false);
  }
}

async function saveGitCredential(event) {
  event.preventDefault();
  if (!elements.gitCredentialForm.reportValidity()) return;
  const button = document.querySelector("#saveGitCredentialButton");
  setBusy(button, true);
  try {
    const management = await api("/api/git/credentials", {
      method: "POST",
      body: JSON.stringify({
        projectRoot: state.gitManagement.project.projectRoot,
        id: elements.gitCredentialId.value,
        name: elements.gitCredentialName.value.trim(),
        provider: elements.gitCredentialProvider.value,
        username: elements.gitCredentialUsername.value.trim(),
        token: elements.gitCredentialToken.value.trim(),
        scope: elements.gitCredentialScope.value
      })
    });
    await refreshAfterGitManagement(management, "凭据配置已保存。Token 不会显示在页面中。");
  } catch (error) {
    setGitManagerStatus(`凭据保存失败：${error.message}`, "error");
  } finally {
    setBusy(button, false);
  }
}

async function deleteGitCredential(profile, button) {
  if (!window.confirm(`确定删除凭据“${profile.name}”吗？\n\n使用它的项目远端会改为自动选择其他可用凭据。`)) return;
  setBusy(button, true);
  try {
    const management = await api("/api/git/credentials", {
      method: "DELETE",
      body: JSON.stringify({ projectRoot: state.gitManagement.project.projectRoot, id: profile.id })
    });
    await refreshAfterGitManagement(management, `凭据“${profile.name}”已删除。`);
  } catch (error) {
    setGitManagerStatus(`删除凭据失败：${error.message}`, "error");
  } finally {
    setBusy(button, false);
  }
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
  document.querySelector("#setupProjectName").value = switching ? (project.config?.projectName || "") : "";
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
  const setupAutoCompile = document.querySelector("#setupAutoCompile");
  setupAutoCompile.checked = project.config?.autoCompile === true;
  setupAutoCompile.closest("label")?.classList.add("hidden");
  renderRecentProjects(project);
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
    name: document.querySelector("#setupProjectName").value.trim(),
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
        translation,
        format: { ...translation }
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
    setPreviewMode("fast");
    scheduleFastPreview(state.project.documents[0]?.file || state.project.config?.mainTex || "", 0);
    updateWarnings([]);
    if (state.project.documents.length) await loadDocument(state.project.documents[0].file);
    toast(state.setupMode === "switch" ? "已打开新的论文项目，右侧显示快速预览。" : "论文已经连接，右侧显示快速预览。", "success");
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
  if (state.previewMode !== "pdf" || !event.ctrlKey) return;
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
  state.pdfCaptionIndex = null;
  state.pdfCaptionIndexPromise = null;
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
  const tokens = normalized ? normalized.split(" ") : [];
  return { normalized, tokens, tokenSet: new Set(tokens) };
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
  const querySet = query.tokenSet || new Set(query.tokens);
  const candidateSet = candidate.tokenSet || new Set(candidate.tokens);
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

function shortTokenRunInText(tokens, normalizedText) {
  if (!tokens?.length || !normalizedText) return 0;
  const maxRun = Math.min(8, tokens.length);
  for (let size = maxRun; size >= 3; size -= 1) {
    for (let index = 0; index + size <= tokens.length; index += 1) {
      if (normalizedText.includes(tokens.slice(index, index + size).join(" "))) return size;
    }
  }
  return 0;
}

function pdfPageRatio(page, pageCount) {
  const normalizedPage = Number(page);
  const normalizedPageCount = Number(pageCount);
  if (!Number.isFinite(normalizedPage) || !Number.isFinite(normalizedPageCount) || normalizedPageCount <= 1) return null;
  return Math.min(1, Math.max(0, (normalizedPage - 1) / (normalizedPageCount - 1)));
}

function candidatePositionRatio(candidate) {
  const explicit = Number(candidate.positionRatio);
  if (Number.isFinite(explicit)) return Math.min(1, Math.max(0, explicit));
  return null;
}

function scoreNavigationPageEvidence(candidate, pageTokens) {
  if (!pageTokens?.tokens?.length) {
    return { pageRun: 0, pageOverlap: 0, pageOverlapRatio: 0, pageBoost: 0, pagePenalty: 0 };
  }
  const pageSet = pageTokens.tokenSet || new Set(pageTokens.tokens);
  const candidateSet = candidate.tokenSet || new Set(candidate.tokens);
  let pageOverlap = 0;
  for (const token of candidateSet) if (pageSet.has(token)) pageOverlap += 1;
  const denominator = Math.max(1, Math.min(candidateSet.size, 24));
  const pageRun = pageOverlap >= 3 ? shortTokenRunInText(candidate.tokens, pageTokens.normalized) : 0;
  const pageOverlapRatio = pageOverlap / denominator;
  const pageBoost = Math.min(24, pageRun * 2 + Math.min(10, pageOverlap) + (pageOverlapRatio >= 0.42 ? 8 : 0));
  const pagePenalty = pageTokens.tokens.length >= 24 && pageRun < 3 && pageOverlap < 4 ? 16 : 0;
  return {
    pageRun,
    pageOverlap,
    pageOverlapRatio,
    pageBoost,
    pagePenalty
  };
}

function scoreNavigationPosition(candidate, { page = 0, pageCount = 0 } = {}) {
  const pagePosition = pdfPageRatio(page, pageCount);
  const sourcePosition = candidatePositionRatio(candidate);
  if (pagePosition === null || sourcePosition === null) return { positionDistance: null, positionBoost: 0, positionPenalty: 0 };
  const distance = Math.abs(pagePosition - sourcePosition);
  let positionBoost = distance <= 0.16 ? 8 : 0;
  let positionPenalty = distance <= 0.22 ? 0 : Math.round((distance - 0.22) * 46);
  if (Number(page) <= 2 && sourcePosition >= 0.58) positionPenalty += 18;
  if (Number(page) >= Number(pageCount) - 1 && sourcePosition <= 0.42) positionPenalty += 18;
  return { positionDistance: distance, positionBoost, positionPenalty };
}

function findBestNavigationMatch(queryText, selectedText, candidates, { source = false, caption = false, page = 0, pageCount = 0, pageText = "" } = {}) {
  const query = navigationTokens(queryText);
  const selectedNormalized = normalizePdfNavigationText(selectedText);
  const pageTokens = navigationTokens(pageText);
  if (query.tokens.length < 2) return null;
  let best = null;
  let runnerUp = null;
  for (const candidate of candidates) {
    const metrics = scoreNavigationText(query, candidate, selectedNormalized);
    const pageEvidence = scoreNavigationPageEvidence(candidate, pageTokens);
    const position = scoreNavigationPosition(candidate, { page, pageCount });
    const result = {
      ...candidate,
      ...metrics,
      ...pageEvidence,
      ...position,
      baseScore: metrics.score,
      score: metrics.score + pageEvidence.pageBoost + position.positionBoost - pageEvidence.pagePenalty - position.positionPenalty
    };
    if (!best || result.score > best.score) {
      runnerUp = best;
      best = result;
    } else if (!runnerUp || result.score > runnerUp.score) {
      runnerUp = result;
    }
  }
  if (!best) return null;
  const querySize = new Set(query.tokens).size;
  const overlapRatio = best.overlap / Math.max(1, Math.min(querySize, 12));
  const captionReliable = caption && (
    (best.selectedExact && best.overlap >= Math.min(3, querySize))
    || best.run >= 3
    || (best.run >= 2 && best.overlap >= 4)
  );
  const reliable = captionReliable
    || best.run >= (source ? 4 : 5)
    || (best.run >= 3 && best.overlap >= 5 && overlapRatio >= 0.45)
    || (best.pageRun >= 5 && best.pageOverlap >= 6 && best.run >= 2)
    || (best.selectedExact && best.run >= 3);
  if (!reliable) return null;
  const competingLocation = !source
    || (runnerUp && (runnerUp.file !== best.file || Math.abs((runnerUp.line || 0) - (best.line || 0)) > 10));
  if (!caption && best.run < 6 && runnerUp && competingLocation && best.score - runnerUp.score < 2) return null;
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
      const entries = documents.flatMap((documentPayload) => documentPayload.segments.map((segment) => ({
        file: documentPayload.file,
        index: segment.index,
        id: segment.id,
        startLine: segment.startLine,
        endLine: segment.endLine,
        sectionIndex: segment.sectionIndex,
        ...navigationTokens(segment.plainText || segment.english, { latex: !segment.plainText })
      }))).filter((entry) => entry.tokens.length);
      const denominator = Math.max(1, entries.length - 1);
      state.pdfParagraphIndex = entries.map((entry, index) => ({
        ...entry,
        positionRatio: entries.length <= 1 ? 0 : index / denominator
      }));
      return state.pdfParagraphIndex;
    })
    .finally(() => {
      if (state.pdfParagraphIndexPromise === promise) state.pdfParagraphIndexPromise = null;
    });
  state.pdfParagraphIndexPromise = promise;
  return promise;
}

function skipLatexBalancedArgument(text, cursor, open, close) {
  if (text[cursor] !== open) return null;
  let depth = 0;
  for (let index = cursor; index < text.length; index += 1) {
    const char = text[index];
    const escaped = index > 0 && text[index - 1] === "\\";
    if (char === open && !escaped) depth += 1;
    else if (char === close && !escaped) {
      depth -= 1;
      if (depth === 0) return { start: cursor, end: index + 1 };
    }
  }
  return null;
}

function latexLineAtOffset(lineStarts, offset) {
  let left = 0;
  let right = lineStarts.length - 1;
  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    if (lineStarts[middle] <= offset) left = middle + 1;
    else right = middle - 1;
  }
  return Math.max(1, right + 1);
}

function latexLineStarts(content) {
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function extractLatexCaptions(source) {
  const content = String(source.content || "");
  const lines = content.split(/\r?\n/);
  const lineStarts = latexLineStarts(content);
  const captions = [];
  const commandPattern = /\\caption(?![A-Za-z@])/g;
  for (const match of content.matchAll(commandPattern)) {
    let cursor = match.index + match[0].length;
    while (/\s/.test(content[cursor] || "")) cursor += 1;
    if (content[cursor] === "[") {
      const optional = skipLatexBalancedArgument(content, cursor, "[", "]");
      if (!optional) continue;
      cursor = optional.end;
      while (/\s/.test(content[cursor] || "")) cursor += 1;
    }
    const required = skipLatexBalancedArgument(content, cursor, "{", "}");
    if (!required) continue;
    const caption = content.slice(required.start + 1, required.end - 1);
    const line = latexLineAtOffset(lineStarts, match.index);
    const sourceStart = Math.max(0, line - 4);
    const sourceEnd = Math.min(lines.length, line + 5);
    const before = content.slice(Math.max(0, match.index - 1000), match.index);
    const beginMatches = [...before.matchAll(/\\begin\s*\{(figure\*?|table\*?)\}/g)];
    const env = beginMatches.at(-1)?.[1] || "figure";
    const after = content.slice(required.end, required.end + 700);
    const label = after.match(/\\label\s*\{([^{}]+)\}/)?.[1] || "";
    const tokens = navigationTokens(caption, { latex: true });
    if (tokens.tokens.length < 2) continue;
    captions.push({
      file: source.file,
      line,
      env,
      label,
      caption,
      sourceLines: lines.slice(sourceStart, sourceEnd).map((text, offset) => ({ line: sourceStart + offset + 1, text })),
      ...tokens
    });
  }
  return captions;
}

async function getPdfCaptionIndex() {
  if (state.pdfCaptionIndex) return state.pdfCaptionIndex;
  if (state.pdfCaptionIndexPromise) return state.pdfCaptionIndexPromise;
  const token = state.pdfNavigationToken;
  const files = (state.project?.texFiles || []).filter((file) => file.toLowerCase().endsWith(".tex"));
  const promise = Promise.all(files.map((file) => api(`/api/source?file=${encodeURIComponent(file)}`)))
    .then((sources) => {
      if (token !== state.pdfNavigationToken) return [];
      state.pdfCaptionIndex = sources.flatMap(extractLatexCaptions);
      return state.pdfCaptionIndex;
    })
    .finally(() => {
      if (state.pdfCaptionIndexPromise === promise) state.pdfCaptionIndexPromise = null;
    });
  state.pdfCaptionIndexPromise = promise;
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
      const entries = sources.flatMap((source) => {
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
      const denominator = Math.max(1, entries.length - 1);
      state.pdfSourceIndex = entries.map((entry, index) => ({
        ...entry,
        positionRatio: entries.length <= 1 ? 0 : index / denominator
      }));
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
  const page = Number(shell.dataset.page || canvas.dataset.page || 0);
  const pageCount = Number(state.pdfDocument?.numPages || state.project?.pdf?.pages || 0);
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
  return {
    selectedText,
    context: context || selectedText,
    page,
    pageCount,
    pageText: items.filter(Boolean).join(" ")
  };
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

function highlightLocatedMathBlock(file, id) {
  const row = [...elements.segmentList.querySelectorAll(".math-row")]
    .find((candidate) => candidate.dataset.file === file && candidate.dataset.mathId === id);
  if (!row) return false;
  row.classList.remove("pdf-located");
  void row.offsetWidth;
  row.classList.add("pdf-located");
  row.scrollIntoView({ behavior: "smooth", block: "center" });
  row.querySelector(".math-source-editor")?.focus();
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
    const navigationScope = {
      page: query.page,
      pageCount: query.pageCount,
      pageText: query.pageText
    };
    const caption = findBestNavigationMatch(query.context, query.selectedText, await getPdfCaptionIndex(), {
      ...navigationScope,
      source: true,
      caption: true
    });
    if (caption && await openSourceLocation(caption.file, caption.line)) {
      elements.pdfScroll.dataset.navigationState = "caption";
      toast(`已定位到${caption.env?.startsWith("table") ? "表格" : "图片"} caption 源码。`, "success", 3200);
      return;
    }

    const paragraph = findBestNavigationMatch(query.context, query.selectedText, await getPdfParagraphIndex(), navigationScope);
    if (paragraph) {
      if (state.mode !== "edit" && !setMode("edit", { loadCurrent: false })) return;
      if (state.currentDocument?.file !== paragraph.file) await loadDocument(paragraph.file);
      if (highlightLocatedSegment(paragraph.file, paragraph.index)) {
        elements.pdfScroll.dataset.navigationState = "paragraph";
        toast("已定位到对应的中英文段落。", "success", 2600);
        return;
      }
    }

    const source = findBestNavigationMatch(query.context, query.selectedText, await getPdfSourceIndex(), { ...navigationScope, source: true });
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

async function locateFastPreviewSelection(event) {
  const block = event.target.closest(".fast-preview-block");
  if (!block) return;
  const file = state.fastPreviewFile || state.currentDocument?.file || state.project?.config?.mainTex || "";
  const line = Number(block.dataset.sourceLine || 0);
  if (!file || !line) return;
  block.classList.remove("source-highlight");
  void block.offsetWidth;
  block.classList.add("source-highlight");
  window.setTimeout(() => block.classList.remove("source-highlight"), 1800);
  try {
    let documentPayload = state.currentDocument?.file === file ? state.currentDocument : null;
    if (!documentPayload && state.project?.documents?.some((item) => item.file === file)) {
      documentPayload = await api(`/api/document?file=${encodeURIComponent(file)}`);
    }
    const segment = documentPayload?.segments?.find((candidate) => (
      line >= Number(candidate.startLine || 0) && line <= Number(candidate.endLine || 0)
    ));
    if (segment) {
      if (state.mode !== "edit" && !setMode("edit", { loadCurrent: false })) return;
      if (state.currentDocument?.file !== file) await loadDocument(file);
      if (highlightLocatedSegment(file, segment.index)) {
        toast("已定位到对应的中英文段落。", "success", 2600);
        return;
      }
    }
    const mathBlock = documentPayload?.mathBlocks?.find((candidate) => (
      line >= Number(candidate.startLine || 0) && line <= Number(candidate.endLine || 0)
    ));
    if (mathBlock) {
      if (state.mode !== "edit" && !setMode("edit", { loadCurrent: false })) return;
      if (state.currentDocument?.file !== file) await loadDocument(file);
      if (highlightLocatedMathBlock(file, mathBlock.id)) {
        toast("已定位到对应公式 TeX。", "success", 2600);
        return;
      }
    }
    if (await openSourceLocation(file, line)) {
      toast("未找到对应翻译段落，已定位到 TeX 源码。", "success", 3200);
    }
  } catch (error) {
    toast(`快速预览定位失败：${error.message}`, "error", 5200);
  }
}

async function api(url, options = {}) {
  const trackedWrite = UNDO_TRACKED_URLS.has(url) && !["GET", "HEAD"].includes(String(options.method || "GET").toUpperCase());
  if (trackedWrite) state.pendingWrites += 1;
  try {
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
  } finally {
    if (trackedWrite) {
      state.pendingWrites = Math.max(0, state.pendingWrites - 1);
      void refreshUndoStatus();
    }
  }
}

function applyUndoStatus(status = {}) {
  state.undoCount = Math.max(0, Number(status.count || 0));
  state.undoLabel = String(status.nextLabel || "");
  if (state.project) state.project.undo = { ...status, count: state.undoCount, nextLabel: state.undoLabel };
  elements.undoButton.disabled = state.undoCount === 0;
  elements.undoButton.title = state.undoCount
    ? `撤销：${state.undoLabel || "上一步操作"}（${state.undoCount}/10）`
    : "没有可撤销的操作";
  elements.undoCount.textContent = String(state.undoCount);
  elements.undoCount.classList.toggle("hidden", state.undoCount === 0);
}

async function refreshUndoStatus() {
  try {
    const response = await fetch("/api/undo/status");
    if (!response.ok) return null;
    const status = await response.json();
    applyUndoStatus(status);
    return status;
  } catch {
    // The next project refresh will restore the status if the local server is restarting.
    return null;
  }
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

function translationFailureMessage(error) {
  const details = error.payload?.details || {};
  if (Array.isArray(details.issues) && details.issues.length) {
    return `${error.message}\n${details.issues.slice(0, 4).join("\n")}`;
  }
  const missing = details.missingTokens;
  if (missing?.length) return `模型丢失 LaTeX 标记：${missing.join(", ")}`;
  if (error.payload?.code === "DANGEROUS_LATEX_COMMANDS") return dangerousLatexMessage(error);
  return error.message;
}

function fileLabel(file) {
  return file
    .replace(/\.tex$/i, "")
    .replace(/^\d+_/, "")
    .replaceAll("_", " ");
}

function statusLabel(status) {
  if (status === "synced") return "有中文";
  if (status === "pending") return "待更新";
  if (status === "english-changed") return "需重译";
  return "无中文";
}

function updateProjectHeader() {
  const config = state.project.config;
  applyUndoStatus(state.project.undo || {});
  elements.projectName.textContent = `${config.projectName || fileLabel(config.projectRoot || "论文项目")} · ${config.mainTex} · ${config.projectRoot}`;
  const git = state.project.git;
  const remotes = Array.isArray(git.remotes) ? git.remotes : [];
  state.gitRemoteName = git.remoteName || "";
  const hasRemote = Boolean(git.remoteName);
  const remoteLabel = git.remoteLabel || (git.overleaf ? "Overleaf" : "Git 远端");
  const remoteTargetLabel = git.remoteRepository ? `${remoteLabel} · ${git.remoteRepository}` : remoteLabel;
  elements.gitRemoteSelect.replaceChildren(...remotes.map((remote) => {
    const option = document.createElement("option");
    option.value = remote.name;
    option.textContent = remote.repository ? `${remote.label} · ${remote.repository}` : remote.label;
    option.selected = remote.name === git.remoteName;
    return option;
  }));
  elements.gitRemoteTarget.classList.toggle("hidden", !hasRemote);
  elements.gitRemoteSelect.disabled = remotes.length < 2;
  elements.gitRemoteTarget.title = remotes.length > 1
    ? "选择本次拉取和推送的目标仓库"
    : `当前同步目标：${remoteTargetLabel}`;
  const pullButton = document.querySelector("#pullButton");
  const pushButton = document.querySelector("#pushButton");
  pullButton.disabled = !hasRemote;
  pushButton.disabled = !hasRemote;
  pullButton.querySelector("span").textContent = hasRemote ? `拉取 ${remoteLabel}` : "拉取";
  pushButton.querySelector("span").textContent = hasRemote ? `推送 ${remoteLabel}` : "推送";
  pullButton.title = hasRemote ? `从 ${remoteTargetLabel} 拉取最新版本` : "当前项目没有连接 Git 远端仓库";
  pushButton.title = hasRemote ? `提交并推送至 ${remoteTargetLabel}` : "当前项目没有连接 Git 远端仓库";
  elements.syncState.className = `sync-state ${git.available ? (git.dirty ? "dirty" : "clean") : "error"}`;
  let syncText = "未连接 Git";
  if (git.available && !hasRemote) syncText = "本地 Git，未连接远端";
  else if (git.dirty) syncText = `${git.changedFiles.length} 个文件待提交`;
  else if (git.behind) syncText = `${remoteLabel} 有 ${git.behind} 次更新`;
  else if (git.ahead) syncText = `${git.ahead} 次提交待推送`;
  else if (hasRemote) syncText = `已与 ${remoteLabel} 对齐`;
  elements.syncState.querySelector("span:last-child").textContent = syncText;
  renderSidebarProjectList(state.project);
}

async function undoLastChange() {
  if (state.sourceDirty) {
    toast("TeX 源码还有未保存修改，请先按 Ctrl+S 保存或在编辑器内撤销。", "warning", 5200);
    return false;
  }
  setBusy(elements.undoButton, true);
  try {
    const currentFile = state.currentFile;
    const result = await api("/api/undo", { method: "POST", body: "{}" });
    applyUndoStatus(result.history || {});
    if (!result.changed) {
      toast("没有可撤销的操作。", "warning", 2800);
      return false;
    }
    state.currentDocument = null;
    await applyProjectPayload(result.project, { preserveDocument: true });
    const nextFile = result.project.documents?.some((item) => item.file === currentFile)
      ? currentFile
      : result.project.documents?.[0]?.file;
    if (nextFile) await loadDocument(nextFile);
    if (state.mode === "source") {
      renderSourceFileOptions(state.sourceFile || nextFile);
      if (elements.sourceFileSelect.value) await loadSourceFile(elements.sourceFileSelect.value, { force: true });
    }
    invalidateReferences();
    scheduleFastPreview(nextFile || result.project.config?.mainTex || "", 0);
    toast(`已撤销：${result.label || "上一步操作"}。`, "success", 3600);
    return true;
  } catch (error) {
    toast(`撤销失败：${error.message}`, "error", 5600);
    return false;
  } finally {
    setBusy(elements.undoButton, false);
    applyUndoStatus(state.project?.undo || { count: state.undoCount, nextLabel: state.undoLabel });
  }
}

async function waitForPendingSaves(timeoutMs = 70_000) {
  const started = Date.now();
  while (
    state.saveTimers.size
    || state.pendingWrites
    || state.fileTranslationJobs.size
    || state.segmentTranslationQueue.length
    || state.activeSegmentTranslations
  ) {
    if (Date.now() - started >= timeoutMs) return false;
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  return true;
}

async function handleDesktopCloseRequest(save) {
  if (!await refreshUndoStatus()) {
    return { ok: false, message: "无法确认论文的保存状态，请稍后再退出。" };
  }
  const backgroundJobs = state.fileTranslationJobs.size > 0
    || state.segmentTranslationQueue.length > 0
    || state.activeSegmentTranslations > 0;
  const dirty = state.sourceDirty
    || state.terminologyDirty
    || state.saveTimers.size > 0
    || state.pendingWrites > 0
    || backgroundJobs
    || state.undoCount > 0;
  if (!save) return { ok: true, dirty, undoCount: state.undoCount };
  if (state.sourceDirty && !await saveSourceFile({ quiet: true, refreshPreview: false })) {
    return { ok: false, message: "TeX 源码保存失败，窗口没有关闭。" };
  }
  if (state.terminologyDirty && !await saveTerminology({ quiet: true })) {
    return { ok: false, message: "术语表保存失败，窗口没有关闭。" };
  }
  if (!await waitForPendingSaves()) {
    return { ok: false, message: "仍有翻译或保存任务未完成，请稍后再退出。" };
  }
  try {
    const status = await api("/api/undo/commit", { method: "POST", body: "{}" });
    applyUndoStatus(status);
    return { ok: true, dirty: false, undoCount: 0 };
  } catch (error) {
    return { ok: false, message: `无法确认保存状态：${error.message}` };
  }
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

function updateTranslateFileButton() {
  const button = document.querySelector("#translateFileButton");
  if (!button) return;
  const job = state.currentFile ? state.fileTranslationJobs.get(state.currentFile) : null;
  const label = button.querySelector("span");
  button.disabled = !state.currentFile || !state.currentDocument;
  button.classList.toggle("busy", Boolean(job));
  if (label) label.textContent = job ? "当前 TeX 翻译中" : "翻译当前 TeX";
}

function renderFileTranslationProgress(preferredFile = state.visibleTranslationJobFile || state.currentFile) {
  let job = preferredFile ? state.fileTranslationJobs.get(preferredFile) : null;
  if (!job && state.currentFile) job = state.fileTranslationJobs.get(state.currentFile);
  if (!job) job = [...state.fileTranslationJobs.values()][0] || null;
  if (!job && state.lastFileTranslationProgress?.file === preferredFile) job = state.lastFileTranslationProgress;
  if (!job) {
    hideFileTranslationProgress();
    updateTranslateFileButton();
    return;
  }
  state.visibleTranslationJobFile = job.file;
  setFileTranslationProgress(job.completed, job.total, job.label, job.statusClass || "");
  updateTranslateFileButton();
}

function finishFileTranslationJob(file, updates = {}) {
  const job = state.fileTranslationJobs.get(file);
  if (!job) return;
  Object.assign(job, updates);
  state.lastFileTranslationProgress = { ...job };
  state.fileTranslationJobs.delete(file);
  renderFileTranslationProgress(file);
  window.setTimeout(() => {
    if (
      state.lastFileTranslationProgress?.file === file
      && !state.fileTranslationJobs.has(file)
      && state.visibleTranslationJobFile === file
    ) {
      state.lastFileTranslationProgress = null;
      renderFileTranslationProgress();
    }
  }, 7000);
}

function normalizeTerminologyEntry(entry = {}) {
  return {
    chinese: String(entry.chinese || "").trim(),
    english: String(entry.english || entry.en || entry.term || "").trim(),
    fullName: String(entry.fullName || entry.full || entry.definition || "").trim(),
    keepEnglish: entry.keepEnglish === true,
    note: String(entry.note || "").trim(),
    frequency: Math.max(0, Number(entry.frequency || 0) || 0),
    firstOccurrence: Math.max(0, Number(entry.firstOccurrence || 0) || 0),
    needsFullName: entry.needsFullName === true
  };
}

function terminologyMatchesSearch(entry, query) {
  if (!query) return true;
  return [entry.chinese, entry.english, entry.fullName, entry.note]
    .some((value) => String(value || "").toLowerCase().includes(query));
}

function setTerminologyStatus(message = "", tone = "") {
  elements.terminologyStatus.textContent = message;
  elements.terminologyStatus.className = `terminology-status ${tone}`.trim();
}

function setTerminologyDirty(dirty = true) {
  state.terminologyDirty = dirty;
  setTerminologyStatus(dirty ? "有未保存的术语修改" : "术语表已保存", dirty ? "dirty" : "saved");
}

function updateTerminologyMeta(payload = null) {
  const count = state.terminologyEntries.length;
  const file = state.terminologyFile || state.currentFile;
  const scope = payload?.scope === "project" ? "全文术语表" : file ? fileLabel(file) : "全文术语表";
  const source = payload?.manual ? "手动维护" : payload?.ruleBased ? "规则提取" : payload?.cached ? "已缓存" : "全文";
  elements.terminologyMeta.textContent = `${scope} · ${count} 条 · ${source}`;
}

function renderTerminologyEntries() {
  const query = elements.terminologySearch.value.trim().toLowerCase();
  elements.terminologyList.replaceChildren();
  let visible = 0;
  state.terminologyEntries.forEach((entry, index) => {
    if (!terminologyMatchesSearch(entry, query)) return;
    visible += 1;
    const row = document.createElement("div");
    row.className = "terminology-row";
    if (entry.needsFullName && !entry.fullName) row.classList.add("needs-full-name");
    row.dataset.index = String(index);

    const makeTextField = (field, labelText, placeholder = "") => {
      const label = document.createElement("label");
      const span = document.createElement("span");
      const input = document.createElement("input");
      span.textContent = labelText;
      input.type = "text";
      input.value = entry[field] || "";
      input.placeholder = placeholder;
      input.addEventListener("input", () => {
        state.terminologyEntries[index][field] = input.value;
        if (field === "fullName" && input.value.trim()) state.terminologyEntries[index].needsFullName = false;
        setTerminologyDirty(true);
        updateTerminologyMeta();
      });
      label.append(span, input);
      return label;
    };

    const keepLabel = document.createElement("label");
    keepLabel.className = "terminology-keep";
    const keepInput = document.createElement("input");
    keepInput.type = "checkbox";
    keepInput.checked = entry.keepEnglish === true;
    keepInput.addEventListener("change", () => {
      state.terminologyEntries[index].keepEnglish = keepInput.checked;
      setTerminologyDirty(true);
    });
    const keepText = document.createElement("span");
    keepText.textContent = "中文稿保留英文";
    keepLabel.append(keepInput, keepText);

    const deleteButton = document.createElement("button");
    deleteButton.className = "icon-button small";
    deleteButton.type = "button";
    deleteButton.title = "删除术语";
    deleteButton.innerHTML = '<i data-lucide="trash-2"></i>';
    deleteButton.addEventListener("click", () => {
      state.terminologyEntries.splice(index, 1);
      setTerminologyDirty(true);
      updateTerminologyMeta();
      renderTerminologyEntries();
    });

    row.append(
      makeTextField("chinese", "中文", "信标"),
      makeTextField("english", "缩写/英文", "ADR"),
      makeTextField("fullName", "全称", entry.needsFullName ? "请补全缩写全称" : "Adaptive Data Rate"),
      makeTextField("note", "备注", entry.frequency ? `出现 ${entry.frequency} 次` : "可选"),
      keepLabel,
      deleteButton
    );
    elements.terminologyList.append(row);
  });

  elements.terminologyEmpty.textContent = state.terminologyEntries.length
    ? "没有匹配的术语。"
    : "暂无术语。可以手动新增，或从论文中的缩写定义和术语表格提取。";
  elements.terminologyEmpty.classList.toggle("hidden", visible > 0);
  refreshIcons();
}

async function openTerminologyDialog() {
  const terminologyFile = state.currentFile || state.project?.config?.mainTex || "";
  if (!terminologyFile) {
    toast("请先打开论文项目。", "error");
    return;
  }
  state.terminologyFile = terminologyFile;
  state.terminologyEntries = [];
  state.terminologyDirty = false;
  elements.terminologySearch.value = "";
  updateTerminologyMeta();
  renderTerminologyEntries();
  setTerminologyStatus("正在读取全文术语表...");
  elements.terminologyDialog.showModal();
  try {
    const payload = await api(`/api/file/terminology?file=${encodeURIComponent(state.terminologyFile)}`);
    state.terminologyEntries = (payload.entries || []).map(normalizeTerminologyEntry);
    state.terminologyDirty = false;
    updateTerminologyMeta(payload);
    renderTerminologyEntries();
    setTerminologyStatus(payload.cached ? "已读取全文术语表" : "全文还没有术语表", payload.cached ? "saved" : "");
  } catch (error) {
    setTerminologyStatus("术语表读取失败", "dirty");
    toast(error.message, "error", 5200);
  }
}

function closeTerminologyDialog() {
  if (state.terminologyDirty && !window.confirm("术语表有未保存修改，确定关闭吗？")) return;
  elements.terminologyDialog.close();
}

function addTerminologyEntry() {
  if (state.terminologyEntries.length >= MAX_TERMINOLOGY_ENTRIES) {
    toast(`术语表最多保存 ${MAX_TERMINOLOGY_ENTRIES} 条。`, "error");
    return;
  }
  state.terminologyEntries.push({ chinese: "", english: "", fullName: "", keepEnglish: false, note: "" });
  elements.terminologySearch.value = "";
  setTerminologyDirty(true);
  updateTerminologyMeta();
  renderTerminologyEntries();
  elements.terminologyList.querySelector(".terminology-row:last-child input")?.focus();
}

function collectTerminologyEntries() {
  const entries = state.terminologyEntries
    .map(normalizeTerminologyEntry)
    .filter((entry) => entry.chinese || entry.english || entry.note);
  if (entries.length > MAX_TERMINOLOGY_ENTRIES) {
    throw new Error(`术语表最多保存 ${MAX_TERMINOLOGY_ENTRIES} 条，请先删除一些术语。`);
  }
  if (entries.some((entry) => !entry.english)) {
    throw new Error("每条术语都需要填写英文写法。");
  }
  return entries;
}

async function saveTerminology(options = {}) {
  if (!state.terminologyFile) return true;
  const quiet = options.quiet === true;
  let entries;
  try {
    entries = collectTerminologyEntries();
  } catch (error) {
    if (!quiet) toast(error.message, "error", 5200);
    return false;
  }
  setBusy(elements.saveTerminologyButton, true);
  setTerminologyStatus("正在保存术语表...");
  try {
    const payload = await api("/api/file/terminology", {
      method: "PUT",
      body: JSON.stringify({ file: state.terminologyFile, entries })
    });
    state.terminologyEntries = (payload.entries || []).map(normalizeTerminologyEntry);
    state.terminologyDirty = false;
    updateTerminologyMeta(payload);
    renderTerminologyEntries();
    setTerminologyStatus("术语表已保存，后续翻译会优先使用它", "saved");
    if (!quiet) toast("术语表已保存。", "success");
    return true;
  } catch (error) {
    setTerminologyStatus("术语表保存失败", "dirty");
    if (!quiet) toast(error.message, "error", 5200);
    return false;
  } finally {
    setBusy(elements.saveTerminologyButton, false);
  }
}

async function regenerateTerminology() {
  if (!state.terminologyFile) return;
  if (state.terminologyDirty && !window.confirm("重新提取会覆盖当前未保存的术语修改，继续吗？")) return;
  if (!state.terminologyDirty && state.terminologyEntries.length && !window.confirm("重新提取会覆盖当前术语表，继续吗？")) return;
  setBusy(elements.regenerateTerminologyButton, true);
  setTerminologyStatus("正在从全文提取术语表...");
  try {
    const payload = await api("/api/file/terminology", {
      method: "POST",
      body: JSON.stringify({ file: state.terminologyFile, force: true })
    });
    state.terminologyEntries = (payload.entries || []).map(normalizeTerminologyEntry);
    state.terminologyDirty = false;
    updateTerminologyMeta(payload);
    renderTerminologyEntries();
    setTerminologyStatus(`已提取 ${state.terminologyEntries.length} 条术语`, "saved");
    toast(`已从全文提取 ${state.terminologyEntries.length} 条术语。`, "success");
  } catch (error) {
    setTerminologyStatus("术语表提取失败", "dirty");
    toast(error.message, "error", 6200);
  } finally {
    setBusy(elements.regenerateTerminologyButton, false);
  }
}

async function applyTerminologyDefinitions() {
  if (!state.terminologyFile) return;
  if (state.sourceDirty) {
    const saved = await saveSourceFile({ deferCompile: true, quiet: true, refreshPreview: false });
    if (!saved) return;
  }
  let entries;
  try {
    entries = collectTerminologyEntries();
  } catch (error) {
    toast(error.message, "error", 5200);
    return;
  }
  const expandable = entries.filter((entry) => entry.english && entry.fullName);
  if (!expandable.length) {
    toast("请先为至少一个缩写填写全称。", "error", 4200);
    return;
  }
  if (!window.confirm("将按全文顺序，把已填写全称的缩写写入第一次出现的位置，格式为“全称（缩写）”。继续吗？")) return;
  setBusy(elements.applyTerminologyDefinitionsButton, true);
  setTerminologyStatus("正在写入全文首次出现位置...");
  try {
    const result = await api("/api/file/terminology/apply", {
      method: "POST",
      body: JSON.stringify({ file: state.terminologyFile, entries })
    });
    state.terminologyEntries = (result.terminology?.entries || entries).map(normalizeTerminologyEntry);
    state.terminologyDirty = false;
    updateTerminologyMeta(result.terminology);
    renderTerminologyEntries();
    if (result.source?.file && state.sourceFile === result.source.file) {
      state.sourceHash = result.source.sourceHash;
      state.sourceEol = result.source.eol || state.sourceEol;
      elements.sourceEditor.value = result.source.content;
      state.sourceSavedContent = elements.sourceEditor.value;
      setSourceDirty(false);
      updateSourceLineNumbers();
      refreshSourceSearch();
    }
    if (result.document && result.document.file === state.currentFile) {
      state.currentDocument = result.document;
      renderSegments();
    }
    if (result.document?.file) scheduleFastPreview(result.document.file, 0);
    const applied = result.applied?.length || 0;
    const skipped = result.skipped?.length || 0;
    setTerminologyStatus(`已写入 ${applied} 个缩写${skipped ? `，跳过 ${skipped} 个` : ""}`, "saved");
    toast(applied ? `已把 ${applied} 个缩写写入首次出现位置。` : "没有需要写入的缩写。", applied ? "success" : "error", 5200);
  } catch (error) {
    setTerminologyStatus("写入首次出现位置失败", "dirty");
    toast(error.message, "error", 6200);
  } finally {
    setBusy(elements.applyTerminologyDefinitionsButton, false);
  }
}

function invalidateReferences() {
  state.references = null;
  state.selectedReferenceKey = "";
}

function normalizeReferenceEntry(entry = {}) {
  return {
    ...entry,
    key: String(entry.key || ""),
    type: String(entry.type || ""),
    file: String(entry.file || ""),
    title: String(entry.title || ""),
    author: String(entry.author || ""),
    year: String(entry.year || ""),
    venue: String(entry.venue || ""),
    methodKeyword: String(entry.methodKeyword || ""),
    raw: String(entry.raw || ""),
    fields: entry.fields && typeof entry.fields === "object" ? entry.fields : {},
    citationOrder: Number(entry.citationOrder || 0),
    firstCitation: entry.firstCitation || null
  };
}

function referenceVenue(entry) {
  return entry.venue || entry.fields?.booktitle || entry.fields?.journal || entry.fields?.publisher || "";
}

function referenceTitle(entry) {
  return entry.title || entry.key || "Untitled reference";
}

function referenceSearchText(entry) {
  return [
    entry.key,
    entry.methodKeyword,
    entry.year,
    referenceTitle(entry),
    entry.author,
    referenceVenue(entry),
    ...Object.values(entry.fields || {})
  ].join("\n").toLowerCase();
}

function referenceMatchesSearch(entry, query) {
  const terms = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = referenceSearchText(entry);
  return terms.every((term) => haystack.includes(term));
}

function getVisibleReferences(query = elements.referencesSearch?.value || "") {
  return (state.references?.entries || [])
    .map(normalizeReferenceEntry)
    .filter((entry) => referenceMatchesSearch(entry, query));
}

function selectedReference() {
  const key = state.selectedReferenceKey;
  return (state.references?.entries || []).map(normalizeReferenceEntry).find((entry) => entry.key === key) || null;
}

function referenceFieldLabel(name) {
  const labels = state.references?.fieldLabels || {};
  return labels[name] || name;
}

function referenceMetaText(entry) {
  const parts = [];
  if (entry.methodKeyword) parts.push(entry.methodKeyword);
  if (entry.year) parts.push(entry.year);
  if (referenceVenue(entry)) parts.push(referenceVenue(entry));
  return parts.join(" · ") || "未识别方法关键词 / 年份 / venue";
}

function renderReferencesAlerts() {
  if (!elements.referencesAlerts) return;
  elements.referencesAlerts.replaceChildren();
  const payload = state.references;
  if (!payload) return;
  const alerts = [];
  if (!payload.bibliographyFiles?.length) {
    alerts.push({ tone: "warning", text: "当前项目还没有检测到 .bib 文件。可以先用“参考文献转 Bib”功能生成独立 Bib 文件。" });
  }
  if (payload.missing?.length) {
    const sample = payload.missing.slice(0, 5).map((item) => `${item.key}（${item.file}:${item.line}）`).join("，");
    alerts.push({ tone: "error", text: `正文中有 ${payload.missing.length} 个 citation key 找不到 BibTeX：${sample}${payload.missing.length > 5 ? "…" : ""}` });
  }
  if (payload.unused?.length) {
    const sample = payload.unused.slice(0, 5).join("，");
    alerts.push({ tone: "muted", text: `Bib 文件中有 ${payload.unused.length} 篇暂未被正文引用：${sample}${payload.unused.length > 5 ? "…" : ""}` });
  }
  if (payload.duplicates?.length) {
    const sample = payload.duplicates.slice(0, 3).map((group) => group.join(" / ")).join("；");
    alerts.push({ tone: "warning", text: `检测到 ${payload.duplicates.length} 组疑似重复文献：${sample}${payload.duplicates.length > 3 ? "…" : ""}` });
  }
  for (const alert of alerts) {
    const node = document.createElement("div");
    node.className = `references-alert ${alert.tone}`;
    node.textContent = alert.text;
    elements.referencesAlerts.append(node);
  }
}

function renderReferenceRow(entry, { compact = false } = {}) {
  const row = document.createElement(compact ? "button" : "article");
  row.className = `reference-row${compact ? " compact" : ""}`;
  row.dataset.referenceKey = entry.key;
  if (compact) row.type = "button";
  else {
    row.tabIndex = 0;
    row.draggable = true;
  }
  row.classList.toggle("active", entry.key === state.selectedReferenceKey);

  const order = document.createElement("span");
  order.className = `reference-order${entry.citationOrder ? "" : " uncited"}`;
  order.textContent = entry.citationOrder ? `#${entry.citationOrder}` : "未引";

  const body = document.createElement("div");
  body.className = "reference-row-body";

  const title = document.createElement("div");
  title.className = "reference-row-title";
  title.textContent = referenceTitle(entry);

  const meta = document.createElement("div");
  meta.className = "reference-row-meta";
  meta.textContent = `${referenceMetaText(entry)} · ${entry.key}`;

  body.append(title, meta);
  row.append(order, body);

  if (!compact) {
    const insert = document.createElement("button");
    insert.className = "mini-button reference-insert-button";
    insert.type = "button";
    insert.title = "点击插入；也可以拖到中英文中的指定位置";
    insert.innerHTML = '<i data-lucide="quote"></i>';
    insert.addEventListener("click", (event) => {
      event.stopPropagation();
      insertCitationAtCurrentTarget(entry);
    });
    row.append(insert);
  }

  const activate = () => {
    state.selectedReferenceKey = entry.key;
    renderReferenceList();
    renderReferenceDetail(entry);
  };
  row.addEventListener("click", () => {
    if (compact) {
      state.selectedReferenceKey = entry.key;
      insertCitationAtCurrentTarget(entry);
      closeReferenceInsertDialog();
      return;
    }
    activate();
  });
  if (!compact) row.addEventListener("dblclick", () => insertCitationAtCurrentTarget(entry));
  if (!compact) {
    row.addEventListener("dragstart", (event) => {
      state.selectedReferenceKey = entry.key;
      elements.referencesList.querySelectorAll(".reference-row").forEach((item) => {
        item.classList.toggle("active", item.dataset.referenceKey === entry.key);
      });
      renderReferenceDetail(entry);
      row.classList.add("dragging");
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData(CITATION_DRAG_TYPE, entry.key);
      event.dataTransfer.setData("text/plain", `\\cite{${entry.key}}`);

      const dragPreview = document.createElement("div");
      dragPreview.className = "citation-drag-preview";
      dragPreview.textContent = `“  \\cite{${entry.key}}`;
      document.body.append(dragPreview);
      event.dataTransfer.setDragImage(dragPreview, 18, 18);
      window.setTimeout(() => dragPreview.remove(), 0);
    });
    row.addEventListener("dragend", () => {
      row.classList.remove("dragging");
      document.querySelectorAll(".citation-drop-target").forEach((item) => item.classList.remove("citation-drop-target"));
    });
    row.addEventListener("keydown", (event) => {
      if (!["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      activate();
    });
  }
  return row;
}

function renderReferenceList() {
  if (!elements.referencesList) return;
  const entries = getVisibleReferences();
  elements.referencesList.replaceChildren();
  if (!state.references) {
    elements.referencesList.innerHTML = '<div class="empty-state">正在读取参考文献...</div>';
    return;
  }
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.references.entries?.length ? "没有匹配的文献。" : "当前 Bib 文件里还没有可识别的文献。";
    elements.referencesList.append(empty);
    return;
  }
  if (!state.selectedReferenceKey || !entries.some((entry) => entry.key === state.selectedReferenceKey)) {
    state.selectedReferenceKey = entries[0].key;
  }
  for (const entry of entries) elements.referencesList.append(renderReferenceRow(entry));
  refreshIcons();
}

function renderReferenceInsertList() {
  if (!elements.referenceInsertList) return;
  const entries = getVisibleReferences(elements.referenceInsertSearch.value);
  elements.referenceInsertList.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.references?.entries?.length ? "没有匹配的文献。" : "当前 Bib 文件里还没有可插入的文献。";
    elements.referenceInsertList.append(empty);
    return;
  }
  for (const entry of entries) elements.referenceInsertList.append(renderReferenceRow(entry, { compact: true }));
  refreshIcons();
}

function renderReferenceDetail(entry = selectedReference()) {
  if (!elements.referenceDetail) return;
  elements.referenceDetail.replaceChildren();
  if (!entry) {
    elements.referenceDetail.innerHTML = '<div class="empty-state">选择一篇文献后查看 BibTeX 源码和字段解释。</div>';
    return;
  }

  const header = document.createElement("div");
  header.className = "reference-detail-header";
  const title = document.createElement("h2");
  title.textContent = referenceTitle(entry);
  const meta = document.createElement("div");
  meta.className = "reference-detail-meta";
  meta.textContent = `${entry.file}${entry.startLine ? `:${entry.startLine}` : ""} · ${entry.key}`;
  header.append(title, meta);

  const summary = document.createElement("div");
  summary.className = "reference-summary-grid";
  for (const [label, value] of [
    ["方法关键词", entry.methodKeyword || "未识别"],
    ["年份", entry.year || "未填写"],
    ["Venue", referenceVenue(entry) || "未填写"],
    ["正文首次引用", entry.firstCitation ? `${entry.firstCitation.file}:${entry.firstCitation.line}` : "尚未引用"]
  ]) {
    const item = document.createElement("div");
    const name = document.createElement("span");
    name.textContent = label;
    const text = document.createElement("strong");
    text.textContent = value;
    item.append(name, text);
    summary.append(item);
  }

  const fields = document.createElement("dl");
  fields.className = "reference-field-list";
  for (const [name, value] of Object.entries(entry.fields || {})) {
    if (!value) continue;
    const dt = document.createElement("dt");
    dt.textContent = `${name}：${referenceFieldLabel(name)}`;
    const dd = document.createElement("dd");
    dd.textContent = value;
    fields.append(dt, dd);
  }

  const sourceLabel = document.createElement("h3");
  sourceLabel.textContent = "原始 BibTeX 源码";
  const source = document.createElement("pre");
  source.className = "reference-bib-source";
  source.textContent = entry.raw;

  elements.referenceDetail.append(header, summary, fields, sourceLabel, source);
}

function renderReferences() {
  const payload = state.references;
  const total = payload?.entries?.length || 0;
  const files = payload?.bibliographyFiles?.length ? payload.bibliographyFiles.map(fileLabel).join("，") : "未检测到 Bib 文件";
  elements.referencesMeta.textContent = `${files} · ${total} 篇文献 · 按正文第一次引用排序`;
  renderReferencesAlerts();
  renderReferenceList();
  renderReferenceDetail();
  if (elements.referenceInsertDialog?.open) renderReferenceInsertList();
}

function renderReferenceAddBibFiles(files = [], selected = "") {
  if (!elements.referenceAddBibFile) return;
  elements.referenceAddBibFile.replaceChildren();
  const options = files.length ? files : ["references.bib"];
  for (const file of options) {
    const option = document.createElement("option");
    option.value = file;
    option.textContent = file;
    option.selected = file === selected || (!selected && file === options[0]);
    elements.referenceAddBibFile.append(option);
  }
}

function openReferenceAddDialog() {
  if (!elements.referenceAddDialog) return;
  elements.referenceAddForm?.reset();
  elements.referenceAddBib.value = "";
  elements.referenceAddKey.value = "";
  elements.referenceAddStatus.textContent = "粘贴 DOI、doi.org 链接或论文网页链接，然后获取元数据。";
  renderReferenceAddBibFiles(state.references?.bibliographyFiles || []);
  elements.referenceAddDialog.showModal();
  window.setTimeout(() => elements.referenceAddUrl?.focus(), 0);
}

function closeReferenceAddDialog() {
  if (elements.referenceAddDialog?.open) elements.referenceAddDialog.close();
}

async function lookupNewReference() {
  const url = elements.referenceAddUrl.value.trim();
  if (!url) {
    toast("请先输入论文链接或 DOI。", "error");
    elements.referenceAddUrl.focus();
    return;
  }
  setBusy(elements.referenceLookupButton, true);
  elements.referenceAddStatus.textContent = "正在读取论文元数据……";
  try {
    const result = await api("/api/references/lookup", {
      method: "POST",
      body: JSON.stringify({ url })
    });
    elements.referenceAddKey.value = result.entry.key;
    elements.referenceAddBib.value = result.entry.raw;
    renderReferenceAddBibFiles(result.bibFiles, result.defaultBibFile);
    if (result.duplicate?.length) {
      elements.referenceAddStatus.textContent = `发现可能重复文献：${result.duplicate.map((item) => item.key).join("、")}。请确认是否仍要加入。`;
      elements.referenceAddStatus.className = "reference-add-status warning";
    } else {
      elements.referenceAddStatus.textContent = `已识别：${result.entry.fields?.title || result.entry.key}。可以修改 citation key 或 BibTeX 后加入。`;
      elements.referenceAddStatus.className = "reference-add-status";
    }
  } catch (error) {
    elements.referenceAddStatus.textContent = error.message;
    elements.referenceAddStatus.className = "reference-add-status error";
    toast(error.message, "error", 6200);
  } finally {
    setBusy(elements.referenceLookupButton, false);
  }
}

async function addNewReference() {
  const raw = elements.referenceAddBib.value.trim();
  if (!raw) {
    toast("请先获取并确认 BibTeX。", "error");
    return;
  }
  setBusy(elements.referenceAddSubmitButton, true);
  elements.referenceAddStatus.textContent = "正在写入 Bib 文件……";
  try {
    const result = await api("/api/references/add", {
      method: "POST",
      body: JSON.stringify({
        bibFile: elements.referenceAddBibFile.value,
        raw,
        key: elements.referenceAddKey.value.trim()
      })
    });
    state.references = {
      ...result.references,
      entries: (result.references.entries || []).map(normalizeReferenceEntry)
    };
    state.selectedReferenceKey = result.entry.key;
    renderReferences();
    closeReferenceAddDialog();
    toast(`已新增文献 ${result.entry.key}，写入 ${result.file}。`, "success", 5200);
  } catch (error) {
    elements.referenceAddStatus.textContent = error.message;
    elements.referenceAddStatus.className = "reference-add-status error";
    toast(error.message, "error", 6200);
  } finally {
    setBusy(elements.referenceAddSubmitButton, false);
  }
}

async function loadReferences({ force = false } = {}) {
  if (state.references && !force) {
    renderReferences();
    return;
  }
  elements.referencesMeta.textContent = "正在读取 Bib 文件和正文引用...";
  try {
    const payload = await api("/api/references");
    state.references = {
      ...payload,
      entries: (payload.entries || []).map(normalizeReferenceEntry)
    };
    if (!state.selectedReferenceKey && state.references.entries.length) {
      state.selectedReferenceKey = state.references.entries[0].key;
    }
    renderReferences();
  } catch (error) {
    elements.referencesMeta.textContent = "参考文献读取失败";
    elements.referencesList.innerHTML = '<div class="empty-state">无法读取参考文献。</div>';
    elements.referenceDetail.innerHTML = '<div class="empty-state">请先确认项目里有 Bib 文件，或者先完成参考文献转 Bib。</div>';
    toast(error.message, "error", 5200);
  }
}

function rememberCitationTarget(textarea) {
  if (!textarea || typeof textarea.selectionStart !== "number") return;
  state.citationTarget = {
    element: textarea,
    start: textarea.selectionStart,
    end: textarea.selectionEnd
  };
}

function citationTargetElement() {
  const active = document.activeElement;
  if (active?.matches?.("textarea.segment-textarea, textarea.source-editor")) {
    rememberCitationTarget(active);
    return active;
  }
  if (state.citationTarget?.element?.isConnected) return state.citationTarget.element;
  return null;
}

function textareaCaretOffsetFromPoint(textarea, clientX, clientY) {
  const value = textarea.value;
  if (!value) return 0;
  const style = window.getComputedStyle(textarea);
  const bounds = textarea.getBoundingClientRect();
  const mirror = document.createElement("div");
  const copiedProperties = [
    "font-family", "font-size", "font-style", "font-weight", "font-variant",
    "letter-spacing", "line-height", "text-align", "text-indent", "text-transform",
    "direction", "tab-size", "padding", "border", "box-sizing", "overflow-wrap", "word-break"
  ];
  for (const property of copiedProperties) mirror.style.setProperty(property, style.getPropertyValue(property));
  const horizontalBorder = Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.borderRightWidth);
  mirror.style.position = "fixed";
  mirror.style.left = "0";
  mirror.style.top = "0";
  mirror.style.width = `${textarea.clientWidth + horizontalBorder}px`;
  mirror.style.height = "auto";
  mirror.style.minHeight = "0";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflow = "visible";
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.textContent = `${value}\u200b`;
  document.body.append(mirror);

  try {
    const textNode = mirror.firstChild;
    const range = document.createRange();
    const caretRect = (offset) => {
      range.setStart(textNode, Math.min(offset, value.length));
      range.collapse(true);
      return range.getBoundingClientRect();
    };
    const mirrorBounds = mirror.getBoundingClientRect();
    const targetX = mirrorBounds.left + clientX - bounds.left + textarea.scrollLeft;
    const targetY = mirrorBounds.top + clientY - bounds.top + textarea.scrollTop;

    let low = 0;
    let high = value.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (caretRect(middle).top <= targetY) low = middle;
      else high = middle - 1;
    }
    const lineTop = caretRect(low).top;
    let lineStart = 0;
    let lineEnd = low;
    high = low;
    while (lineStart < high) {
      const middle = Math.floor((lineStart + high) / 2);
      if (caretRect(middle).top < lineTop - 0.5) lineStart = middle + 1;
      else high = middle;
    }
    high = value.length;
    while (lineEnd < high) {
      const middle = Math.ceil((lineEnd + high) / 2);
      if (caretRect(middle).top <= lineTop + 0.5) lineEnd = middle;
      else high = middle - 1;
    }

    let closest = lineStart;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let offset = lineStart; offset <= lineEnd; offset += 1) {
      const distance = Math.abs(caretRect(offset).left - targetX);
      if (distance >= closestDistance) continue;
      closest = offset;
      closestDistance = distance;
    }
    return closest;
  } finally {
    mirror.remove();
  }
}

function insertCitationIntoTarget(target, key, start, end = start) {
  const insertionPoint = Math.max(start, end);
  const before = target.value.slice(0, insertionPoint);
  const glue = before && !/[\s~([{]$/.test(before) ? "~" : "";
  const citation = `${glue}\\cite{${key}}`;
  target.setRangeText(citation, insertionPoint, insertionPoint, "end");
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.focus();
  rememberCitationTarget(target);
  toast(`已插入 \\cite{${key}}。`, "success");
}

function insertCitationAtCurrentTarget(entry) {
  const target = citationTargetElement();
  if (!target) {
    toast("请先在中文、英文段落或 TeX 源码里点一下要插入引用的位置。", "error", 5600);
    return false;
  }
  const start = Number.isFinite(state.citationTarget?.start) ? state.citationTarget.start : target.selectionStart || 0;
  const end = Number.isFinite(state.citationTarget?.end) ? state.citationTarget.end : target.selectionEnd || start;
  insertCitationIntoTarget(target, entry.key, start, end);
  return true;
}

function closeReferenceInsertDialog() {
  if (elements.referenceInsertDialog?.open) elements.referenceInsertDialog.close();
}

async function openReferenceInsertDialog() {
  closeCitationContextMenu();
  if (!state.references) await loadReferences();
  if (!state.references) return;
  elements.referenceInsertSearch.value = elements.referencesSearch?.value || "";
  elements.referenceInsertMeta.textContent = state.citationTarget?.element?.classList.contains("source-editor")
    ? "将插入到 TeX 源码当前光标处"
    : "将插入到当前段落光标处；如果选中了一个词，会插在这个词后面";
  renderReferenceInsertList();
  if (!elements.referenceInsertDialog.open) elements.referenceInsertDialog.showModal();
  window.requestAnimationFrame(() => elements.referenceInsertSearch.focus());
}

function closeCitationContextMenu() {
  document.querySelector(".citation-context-menu")?.remove();
}

function openCitationContextMenu(event, textarea) {
  rememberCitationTarget(textarea);
  event.preventDefault();
  closeCitationContextMenu();
  const menu = document.createElement("div");
  menu.className = "citation-context-menu";
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 190)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - 54)}px`;
  const button = document.createElement("button");
  button.type = "button";
  button.innerHTML = '<i data-lucide="quote"></i><span>插入文献</span>';
  button.addEventListener("click", () => openReferenceInsertDialog());
  menu.append(button);
  menu.addEventListener("pointerdown", (innerEvent) => innerEvent.stopPropagation());
  document.body.append(menu);
  refreshIcons();
  window.setTimeout(() => {
    document.addEventListener("pointerdown", closeCitationContextMenu, { once: true });
    document.addEventListener("keydown", (keyEvent) => {
      if (keyEvent.key === "Escape") closeCitationContextMenu();
    }, { once: true });
  }, 0);
}

function attachCitationTarget(textarea) {
  if (!textarea) return;
  for (const eventName of ["focus", "click", "keyup", "select"]) {
    textarea.addEventListener(eventName, () => rememberCitationTarget(textarea));
  }
  textarea.addEventListener("contextmenu", (event) => openCitationContextMenu(event, textarea));
  textarea.addEventListener("dragover", (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes(CITATION_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    textarea.classList.add("citation-drop-target");
  });
  textarea.addEventListener("dragleave", () => textarea.classList.remove("citation-drop-target"));
  textarea.addEventListener("drop", (event) => {
    const key = event.dataTransfer?.getData(CITATION_DRAG_TYPE);
    if (!key) return;
    event.preventDefault();
    textarea.classList.remove("citation-drop-target");
    const offset = textareaCaretOffsetFromPoint(textarea, event.clientX, event.clientY);
    insertCitationIntoTarget(textarea, key, offset);
  });
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

function fastPreviewHash(value) {
  let hash = 5381;
  const source = String(value || "");
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(index)) | 0;
  }
  return hash >>> 0;
}

function fastPreviewEscape(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fastPreviewVisibleLine(line) {
  const source = String(line || "");
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "%" && !fastPreviewIsEscaped(source, index)) {
      return source.slice(0, index).trimEnd();
    }
  }
  return source;
}

function fastPreviewSplitProseEnv({ envName, envArgs, bodyLines, bodyStartLine, beginLine }) {
  const paragraphs = [];
  let current = [];
  let currentStart = bodyStartLine;
  bodyLines.forEach((line, index) => {
    if (line.trim() === "") {
      if (current.length) paragraphs.push({ lines: current, startLine: currentStart });
      current = [];
      currentStart = bodyStartLine + index + 1;
      return;
    }
    if (!current.length) currentStart = bodyStartLine + index;
    current.push(line);
  });
  if (current.length) paragraphs.push({ lines: current, startLine: currentStart });
  if (!paragraphs.length) {
    return [{
      startLine: beginLine,
      endLine: beginLine + 1,
      source: `\\begin{${envName}}${envArgs}\n\\end{${envName}}`,
      parentEnv: envName
    }];
  }
  return paragraphs.map((paragraph, index) => {
    const first = index === 0;
    const last = index === paragraphs.length - 1;
    const prefix = first ? `\\begin{${envName}}${envArgs}\n` : "";
    const suffix = last ? `\n\\end{${envName}}` : "";
    return {
      startLine: paragraph.startLine,
      endLine: paragraph.startLine + paragraph.lines.length - 1,
      source: `${prefix}${paragraph.lines.join("\n")}${suffix}`,
      parentEnv: envName
    };
  });
}

function splitFastPreviewBlocks(source) {
  const lines = String(source || "").replace(/\r\n/g, "\n").split("\n");
  const visibleLines = lines.map((line) => fastPreviewVisibleLine(line));
  const blocks = [];
  const ordinals = new Map();
  let blockStart = 0;
  let blockLines = [];

  const nextId = (blockSource) => {
    const hash = fastPreviewHash(blockSource).toString(16);
    const ordinal = ordinals.get(hash) || 0;
    ordinals.set(hash, ordinal + 1);
    return `fast-block-${hash}-${ordinal}`;
  };
  const pushBlock = (endLine) => {
    if (!blockLines.some((line) => line.trim())) {
      blockLines = [];
      return;
    }
    const blockSource = blockLines.join("\n");
    blocks.push({ id: nextId(blockSource), startLine: blockStart + 1, endLine: endLine + 1, source: blockSource });
    blockLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = visibleLines[index];
    const trimmed = line.trim();
    const boundary = trimmed === "" || FAST_PREVIEW_SECTION_PATTERN.test(trimmed) || FAST_PREVIEW_BEGIN_END_PATTERN.test(trimmed);
    if (boundary && blockLines.length) pushBlock(index - 1);
    if (trimmed === "") {
      blockStart = index + 1;
      continue;
    }

    const beginMatch = trimmed.match(/^\\begin\{(\w+\*?)\}(.*)$/);
    if (beginMatch && FAST_PREVIEW_GROUPED_ENVS.has(beginMatch[1])) {
      const envName = beginMatch[1];
      const envArgs = beginMatch[2] || "";
      const beginPattern = `\\begin{${envName}}`;
      const endPattern = `\\end{${envName}}`;
      const beginLine = index;
      const bodyStartLine = index + 1;
      const bodyLines = [];
      let depth = 1;
      index += 1;
      while (index < lines.length && depth > 0) {
        const inner = visibleLines[index].trim();
        if (inner.includes(beginPattern)) depth += 1;
        if (inner.includes(endPattern)) depth -= 1;
        if (depth > 0) bodyLines.push(visibleLines[index]);
        if (depth > 0) index += 1;
      }
      const envBlocks = FAST_PREVIEW_PROSE_ENVS.has(envName)
        ? fastPreviewSplitProseEnv({ envName, envArgs, bodyLines, bodyStartLine, beginLine })
        : [{
            startLine: beginLine,
            endLine: index,
            source: [visibleLines[beginLine], ...bodyLines, visibleLines[index] || ""].join("\n"),
            parentEnv: envName
          }];
      envBlocks.forEach((block) => blocks.push({
        ...block,
        id: nextId(block.source),
        startLine: block.startLine + 1,
        endLine: block.endLine + 1
      }));
      blockStart = index + 1;
      continue;
    }

    if (trimmed && !blockLines.some((line) => line.trim())) blockStart = index;
    blockLines.push(line);
  }
  if (blockLines.length) pushBlock(lines.length - 1);
  return blocks;
}

function renderFastPreviewText(source) {
  return fastPreviewEscape(source)
    .replace(/\\(?:textbf|bfseries)\s*\{([^{}]*)\}/g, "<strong>$1</strong>")
    .replace(/\\(?:emph|textit)\s*\{([^{}]*)\}/g, "<em>$1</em>")
    .replace(/\\(?:cite\w*|ref|eqref|autoref|cref|Cref|pageref)\s*(?:\[[^\]]*\]\s*)*\{([^{}]*)\}/g, "<span class=\"fast-preview-command\">[$1]</span>")
    .replace(/\\includegraphics(?:\[[^\]]*\])?\{([^{}]*)\}/g, "<figure>Image: $1</figure>")
    .replace(/\\\\/g, "<br>")
    .replace(/\n/g, "<br>");
}

function fastPreviewIsEscaped(source, index) {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) count += 1;
  return count % 2 === 1;
}

function fastPreviewFindClosingDollar(source, start, display) {
  const marker = display ? "$$" : "$";
  for (let index = start; index < source.length; index += 1) {
    if (source.startsWith(marker, index) && !fastPreviewIsEscaped(source, index)) return index;
  }
  return -1;
}

function fastPreviewFindClosingMarker(source, start, marker) {
  const index = source.indexOf(marker, start);
  return index >= 0 ? index : -1;
}

function renderFastPreviewMath(math, { display = false, envName = "" } = {}) {
  const escaped = fastPreviewEscape(math.trim());
  const classes = `math-pending${display ? " display" : ""}`;
  const label = envName ? ` data-env="${fastPreviewEscape(envName)}"` : "";
  return `<span class="${classes}" data-math="${escaped}"${label} title="双击定位到源码；正式 PDF 以 TeX 编译结果为准">${escaped}</span>`;
}

function renderFastPreviewInline(source) {
  const text = String(source || "");
  let html = "";
  let cursor = 0;
  const appendText = (end) => {
    if (end > cursor) html += renderFastPreviewText(text.slice(cursor, end));
    cursor = end;
  };

  while (cursor < text.length) {
    if (text.startsWith("$$", cursor) && !fastPreviewIsEscaped(text, cursor)) {
      const close = fastPreviewFindClosingDollar(text, cursor + 2, true);
      if (close >= 0) {
        const math = text.slice(cursor + 2, close);
        html += renderFastPreviewMath(math, { display: true });
        cursor = close + 2;
        continue;
      }
    }
    if (text.startsWith("\\[", cursor)) {
      const close = fastPreviewFindClosingMarker(text, cursor + 2, "\\]");
      if (close >= 0) {
        const math = text.slice(cursor + 2, close);
        html += renderFastPreviewMath(math, { display: true });
        cursor = close + 2;
        continue;
      }
    }
    if (text.startsWith("\\(", cursor)) {
      const close = fastPreviewFindClosingMarker(text, cursor + 2, "\\)");
      if (close >= 0) {
        const math = text.slice(cursor + 2, close);
        html += renderFastPreviewMath(math);
        cursor = close + 2;
        continue;
      }
    }
    if (text[cursor] === "$" && !fastPreviewIsEscaped(text, cursor)) {
      const close = fastPreviewFindClosingDollar(text, cursor + 1, false);
      if (close >= 0) {
        const math = text.slice(cursor + 1, close);
        html += renderFastPreviewMath(math);
        cursor = close + 1;
        continue;
      }
    }
    const next = [
      text.indexOf("$$", cursor + 1),
      text.indexOf("\\[", cursor + 1),
      text.indexOf("\\(", cursor + 1),
      text.indexOf("$", cursor + 1)
    ].filter((index) => index >= 0).sort((left, right) => left - right)[0] ?? text.length;
    appendText(next);
  }
  return html;
}

function fastPreviewMathEnvironment(source, envName) {
  const body = source
    .replace(new RegExp(`^\\\\begin\\{${envName.replace("*", "\\*")}\\}[^\\n]*\\n?`), "")
    .replace(new RegExp(`\\n?\\\\end\\{${envName.replace("*", "\\*")}\\}\\s*$`), "")
    .trim();
  if (/^align|^flalign|^alignat/.test(envName)) return `\\begin{aligned}\n${body}\n\\end{aligned}`;
  if (/^gather/.test(envName)) return `\\begin{gathered}\n${body}\n\\end{gathered}`;
  return body;
}

function renderFastPreviewBlock(block) {
  const source = block.source.trim();
  const section = source.match(/^\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{([^{}]*)\}/);
  let html = "";
  if (/^\\documentclass|^\\usepackage|^\\newcommand|^\\renewcommand|^\\def|^\\title|^\\author|^\\date|^\\maketitle|^\\bibliography|^\\bibliographystyle|^\\begin\{document\}/.test(source)) {
    html = "";
  } else if (section) {
    const tag = section[1] === "chapter" || section[1] === "section" ? "h2" : section[1] === "subsection" ? "h3" : "h4";
    html = `<${tag}>${renderFastPreviewInline(section[2])}</${tag}>`;
  } else if (/^\\begin\{/.test(source)) {
    const envName = source.match(/^\\begin\{([^{}]+)\}/)?.[1] || "environment";
    if (/^(equation|align|gather|multline|alignat|flalign)\*?$/.test(envName)) {
      html = renderFastPreviewMath(fastPreviewMathEnvironment(source, envName), { display: true, envName });
    } else {
      html = `<div class="fast-preview-env"><strong>${fastPreviewEscape(envName)}</strong><br>${renderFastPreviewInline(source)}</div>`;
    }
  } else if (/^\\end\{document\}/.test(source)) {
    html = "";
  } else {
    html = `<p>${renderFastPreviewInline(source)}</p>`;
  }
  return {
    ...block,
    sourceHash: fastPreviewHash(block.source),
    htmlHash: fastPreviewHash(html),
    html
  };
}

function setPreviewMode(mode) {
  state.previewMode = mode;
  elements.previewPanel.dataset.previewMode = mode;
  elements.previewModeLabel.textContent = mode === "pdf" ? "正式 PDF" : "快速预览";
  elements.pdfScroll.classList.toggle("fast-preview-scroll", mode === "fast");
  elements.pdfScroll.classList.toggle("pdf-preview-scroll", mode === "pdf");
  if (mode === "fast") {
    elements.visiblePage.textContent = "—";
    elements.pageStatus.textContent = "快速预览";
  }
}

function resetPdfRenderer() {
  state.pdfRenderToken += 1;
  state.pdfObserver?.disconnect();
  state.pdfObserver = null;
  for (const task of state.pdfPageRenderTasks.values()) task.cancel();
  state.pdfPageRenderTasks.clear();
  for (const entry of state.pdfTextLayers.values()) if (!entry.ready) entry.task.cancel();
  state.pdfTextLayers.clear();
  state.pdfDocument = null;
}

async function fastPreviewSource(file = "") {
  const sourceFile = file || state.currentDocument?.file || state.sourceFile || state.project?.config?.mainTex || "";
  if (!sourceFile) throw new Error("尚未选择可预览的 TeX 文件。");
  if (state.sourceDirty && state.sourceFile === sourceFile) {
    return { file: sourceFile, content: elements.sourceEditor.value };
  }
  return api(`/api/source?file=${encodeURIComponent(sourceFile)}`);
}

function registerFastPreviewMath(root) {
  state.fastPreviewMathObserver?.disconnect();
  state.fastPreviewMathObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const node = entry.target;
      const math = node.dataset.math || node.textContent || "";
      const displayMode = node.classList.contains("display");
      if (window.katex?.renderToString) {
        try {
          node.innerHTML = window.katex.renderToString(math, {
            displayMode,
            throwOnError: true,
            strict: "ignore",
            trust: false
          });
          node.classList.remove("math-pending");
          node.classList.add("math-rendered");
        } catch (error) {
          node.innerHTML = `
            <span class="math-fallback-label">公式暂未快速渲染 · 正式 PDF 以 TeX 为准</span>
            <code class="math-source">${fastPreviewEscape(math)}</code>
          `;
          node.classList.remove("math-pending");
          node.classList.add("math-rendered", "math-fallback");
          node.title = error.message || "KaTeX 无法渲染该公式";
        }
      } else {
        node.innerHTML = `
          <span class="math-fallback-label">KaTeX 未加载 · 显示原始公式</span>
          <code class="math-source">${fastPreviewEscape(math)}</code>
        `;
        node.classList.remove("math-pending");
        node.classList.add("math-rendered", "math-fallback");
      }
      state.fastPreviewMathObserver.unobserve(node);
    }
  }, { root: elements.pdfScroll, rootMargin: "100% 0px" });
  root.querySelectorAll(".math-pending").forEach((node) => state.fastPreviewMathObserver.observe(node));
}

function applyFastPreviewPatches(nextBlocks) {
  const documentNode = elements.pdfScroll.querySelector(".fast-preview-document");
  if (!documentNode) return false;
  const oldById = new Map(state.fastPreviewCache.map((block) => [block.id, block]));
  const newIds = new Set(nextBlocks.map((block) => block.id));
  state.fastPreviewCache
    .filter((block) => !newIds.has(block.id))
    .forEach((block) => document.getElementById(block.id)?.remove());

  let anchor = documentNode.querySelector(".fast-preview-meta");
  for (const block of nextBlocks) {
    if (!block.html) continue;
    const old = oldById.get(block.id);
    let node = document.getElementById(block.id);
    if (!node) {
      node = document.createElement("div");
      node.className = "fast-preview-block";
      node.id = block.id;
      anchor.after(node);
    }
    if (!old || old.htmlHash !== block.htmlHash) node.innerHTML = block.html;
    node.dataset.sourceLine = String(block.startLine);
    node.dataset.endLine = String(block.endLine);
    if (node.previousElementSibling !== anchor) anchor.after(node);
    anchor = node;
  }
  state.fastPreviewCache = nextBlocks;
  registerFastPreviewMath(documentNode);
  return true;
}

async function renderFastPreview(file = "") {
  const token = ++state.fastPreviewToken;
  window.clearTimeout(state.fastPreviewTimer);
  state.fastPreviewTimer = 0;
  setPreviewMode("fast");
  resetPdfRenderer();
  const started = performance.now();
  if (!state.fastPreviewCache.length || state.fastPreviewFile !== (file || state.fastPreviewFile)) {
    elements.pdfScroll.innerHTML = '<div class="pdf-loading">正在生成快速预览...</div>';
  }
  try {
    const source = await fastPreviewSource(file);
    if (token !== state.fastPreviewToken) return;
    const fileChanged = state.fastPreviewFile && state.fastPreviewFile !== source.file;
    if (fileChanged) state.fastPreviewCache = [];
    const nextBlocks = splitFastPreviewBlocks(source.content).map(renderFastPreviewBlock);
    state.fastPreviewFile = source.file;
    const reused = applyFastPreviewPatches(nextBlocks);
    if (!reused) {
      const documentNode = document.createElement("div");
      documentNode.className = "fast-preview-document";
      const meta = document.createElement("div");
      meta.className = "fast-preview-meta";
      meta.textContent = `${source.file} · 快速 HTML 预览，正式排版请点击“编译全文”`;
      documentNode.append(meta);
      for (const block of nextBlocks) {
        if (!block.html) continue;
        const node = document.createElement("div");
        node.className = "fast-preview-block";
        node.id = block.id;
        node.dataset.sourceLine = String(block.startLine);
        node.dataset.endLine = String(block.endLine);
        node.innerHTML = block.html;
        documentNode.append(node);
      }
      elements.pdfScroll.replaceChildren(documentNode);
      state.fastPreviewCache = nextBlocks;
      registerFastPreviewMath(documentNode);
    }
    const meta = elements.pdfScroll.querySelector(".fast-preview-meta");
    if (meta) meta.textContent = `${source.file} · 快速 HTML 预览，正式排版请点击“编译全文”`;
    const elapsed = Math.round(performance.now() - started);
    elements.pageStatus.textContent = `快速预览 · ${nextBlocks.filter((block) => block.html).length} blocks · ${elapsed}ms`;
  } catch (error) {
    if (token !== state.fastPreviewToken) return;
    state.fastPreviewCache = [];
    elements.pdfScroll.innerHTML = '<div class="pdf-loading">快速预览生成失败</div>';
    elements.pageStatus.textContent = "快速预览失败";
    toast(error.message, "error", 5200);
  }
}

function scheduleFastPreview(file = "", delay = 120) {
  if (state.previewMode !== "fast") setPreviewMode("fast");
  window.clearTimeout(state.fastPreviewTimer);
  state.fastPreviewTimer = window.setTimeout(() => {
    void renderFastPreview(file).catch((error) => toast(error.message, "error", 5200));
  }, delay);
}

function previewFileAfterSourceChange(file = "") {
  return String(file || "").toLowerCase().endsWith(".tex")
    ? file
    : state.currentDocument?.file || state.project?.config?.mainTex || "";
}

async function renderPdf() {
  setPreviewMode("pdf");
  state.fastPreviewMathObserver?.disconnect();
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
  if (state.previewMode !== "pdf") return;
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

function flashSourceSelection() {
  window.clearTimeout(state.sourceHighlightTimer);
  elements.sourceEditor.classList.remove("source-located");
  void elements.sourceEditor.offsetWidth;
  elements.sourceEditor.classList.add("source-located");
  state.sourceHighlightTimer = window.setTimeout(() => {
    elements.sourceEditor.classList.remove("source-located");
  }, 2600);
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
  state.dismissedBuildDrawerFingerprint = "";
  elements.compileDiagnosis.classList.add("hidden");
  elements.compileDiagnosisStatus.textContent = "";
  elements.compileDiagnosisSummary.textContent = "";
  elements.compileDiagnosisList.replaceChildren();
}

function closeBuildDrawer() {
  state.dismissedBuildDrawerFingerprint = state.compileDiagnosisFingerprint || state.dismissedBuildDrawerFingerprint;
  elements.buildDrawer.classList.add("hidden");
}

function toggleBuildDrawer() {
  const closed = elements.buildDrawer.classList.contains("hidden");
  if (closed) {
    state.dismissedBuildDrawerFingerprint = "";
    elements.buildDrawer.classList.remove("hidden");
  } else {
    closeBuildDrawer();
  }
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
  flashSourceSelection();
  updateSourceStatus();
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
  if (state.dismissedBuildDrawerFingerprint !== fingerprint) {
    elements.buildDrawer.classList.remove("hidden");
  }
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
    if (state.previewMode === "pdf") updatePdf(build.pdf);
  }
  updateWarnings(build.warnings || [], build.layoutChanges || [], build.errors || []);
  if (!build.success && !build.skipped) {
    toast("编译失败，AI 正在定位错误。", "error", 5200);
    void diagnoseBuild(build);
  } else if (build.success && !build.skipped) {
    clearCompileDiagnosis();
  }
}

async function refreshProject({ preserveDocument = true, remoteName = state.gitRemoteName } = {}) {
  const previousRoot = state.project?.config?.projectRoot;
  const previousMainTex = state.project?.config?.mainTex;
  const query = remoteName ? `?remoteName=${encodeURIComponent(remoteName)}` : "";
  state.project = await api(`/api/bootstrap${query}`);
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
    state.fastPreviewFile = "";
    state.fastPreviewCache = [];
    invalidateReferences();
    clearCompileDiagnosis();
  }
  if (state.project.setupRequired) {
    openSetup(state.project);
    return false;
  }
  updateProjectHeader();
  renderDocumentList();
  renderSourceFileOptions(state.sourceDirty ? state.sourceFile : state.currentFile);
  if (state.previewMode === "pdf") updatePdf();
  else scheduleFastPreview(state.currentDocument?.file || state.currentFile || state.project.config?.mainTex || "");
  if (state.mode === "source" && !state.sourceFile && elements.sourceFileSelect.value) {
    await loadSourceFile(elements.sourceFileSelect.value, { force: true });
  }
  if (!preserveDocument && state.project.documents.length) {
    await loadDocument(state.project.documents[0].file);
  }
  return true;
}

async function applyProjectPayload(project, { preserveDocument = true } = {}) {
  if (!project) return false;
  const previousRoot = state.project?.config?.projectRoot;
  const previousMainTex = state.project?.config?.mainTex;
  state.project = project;
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
    state.fastPreviewFile = "";
    state.fastPreviewCache = [];
    invalidateReferences();
    clearCompileDiagnosis();
  }
  updateProjectHeader();
  renderDocumentList();
  renderSourceFileOptions(state.sourceDirty ? state.sourceFile : state.currentFile);
  if (!preserveDocument && state.project.documents?.length) {
    await loadDocument(state.project.documents[0].file);
    return true;
  }
  if (state.previewMode === "pdf") updatePdf();
  else scheduleFastPreview(state.currentDocument?.file || state.currentFile || state.project.config?.mainTex || "");
  return true;
}

function scheduleProjectRefresh(delay = 160) {
  window.clearTimeout(state.projectRefreshTimer);
  state.projectRefreshTimer = window.setTimeout(async () => {
    state.projectRefreshTimer = 0;
    try {
      await refreshProject();
    } catch (error) {
      console.warn("Background project refresh failed:", error);
    }
  }, delay);
}

function clearMathDropTargets() {
  elements.segmentList.querySelectorAll(".math-drop-before, .math-drop-after").forEach((row) => {
    row.classList.remove("math-drop-before", "math-drop-after");
  });
}

function mathDropPosition(row, event) {
  const rect = row.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function attachMathDropTarget(row, target) {
  row.addEventListener("dragover", (event) => {
    if (!state.draggingMathBlock || state.draggingMathBlock.file !== target.file) return;
    if (target.type === "math" && target.id === state.draggingMathBlock.id) return;
    event.preventDefault();
    const position = mathDropPosition(row, event);
    row.classList.toggle("math-drop-before", position === "before");
    row.classList.toggle("math-drop-after", position === "after");
  });
  row.addEventListener("dragleave", () => {
    row.classList.remove("math-drop-before", "math-drop-after");
  });
  row.addEventListener("drop", async (event) => {
    if (!state.draggingMathBlock || state.draggingMathBlock.file !== target.file) return;
    event.preventDefault();
    const dragged = state.draggingMathBlock;
    const position = mathDropPosition(row, event);
    clearMathDropTargets();
    try {
      const result = await api("/api/math-block/move", {
        method: "POST",
        body: JSON.stringify({
          file: dragged.file,
          id: dragged.id,
          sourceHash: dragged.sourceHash,
          startLine: dragged.startLine,
          target: { ...target, position },
          deferCompile: state.project?.config?.autoCompile !== true
        })
      });
      state.currentDocument = result.document;
      renderSegments();
      scheduleFastPreview(result.document.file, 0);
      updateBuild(result.build);
      scheduleProjectRefresh();
      toast("公式块已移动。", "success");
    } catch (error) {
      toast(error.message, "error", 5600);
    } finally {
      state.draggingMathBlock = null;
    }
  });
}

function segmentChineseSaveTimerKey(segment) {
  return `chinese:${segment.id}`;
}

function segmentEnglishSaveTimerKey(segment) {
  return `english:${segment.id}`;
}

function clearSegmentSaveTimers(segment) {
  for (const key of [segmentChineseSaveTimerKey(segment), segmentEnglishSaveTimerKey(segment)]) {
    window.clearTimeout(state.saveTimers.get(key));
    state.saveTimers.delete(key);
  }
}

function segmentTranslationKey(segment) {
  return `${segment.file}\0${segment.id || `${segment.index}:${segment.sourceHash}`}`;
}

function segmentTranslationLabel(segmentOrJob) {
  return `P${String(Number(segmentOrJob.index || 0) + 1).padStart(2, "0")}`;
}

function segmentTranslationJob(segment) {
  return state.segmentTranslationJobs.get(segmentTranslationKey(segment)) || null;
}

function paintSegmentTranslationRow(row, job) {
  const status = row.querySelector(".segment-status");
  const button = row.querySelector(".translate-button");
  const running = job.status === "running";
  status.textContent = job.status === "queued" ? "排队中" : running ? "正在翻译…" : "翻译失败";
  status.className = `segment-status ${job.status === "failed" ? "english-changed" : "pending"}`;
  status.title = job.message || "";
  button.title = job.status === "queued" ? "已加入翻译队列" : running ? "正在请求 AI 翻译" : "翻译失败，可修改后重试";
  setBusy(button, job.status !== "failed");
}

function updateSegmentTranslationRow(job) {
  if (state.currentDocument?.file !== job.file) return;
  const row = [...elements.segmentList.querySelectorAll(".segment-row")]
    .find((candidate) => candidate.dataset.file === job.file && candidate.dataset.segmentId === job.segmentId);
  if (!row) return;
  paintSegmentTranslationRow(row, job);
}

function applySegmentTranslationState(row, segment) {
  const job = segmentTranslationJob(segment);
  if (!job) return false;
  paintSegmentTranslationRow(row, job);
  return true;
}

function enqueueSegmentTranslation(segment, chinese) {
  const key = segmentTranslationKey(segment);
  const existing = state.segmentTranslationJobs.get(key);
  if (existing) {
    if (existing.status === "failed") {
      state.segmentTranslationJobs.delete(key);
    } else {
      toast(`${segmentTranslationLabel(existing)} 已在翻译队列中。`, "success", 2600);
      updateSegmentTranslationRow(existing);
      return;
    }
  }
  const job = {
    key,
    segmentId: segment.id,
    file: segment.file,
    index: segment.index,
    sourceHash: segment.sourceHash,
    chinese,
    deferCompile: state.project?.config?.autoCompile !== true,
    status: "queued",
    message: "已加入翻译队列，等待空闲翻译通道。"
  };
  state.segmentTranslationJobs.set(key, job);
  state.segmentTranslationQueue.push(key);
  updateSegmentTranslationRow(job);
  setFileTranslationProgress(0, Math.max(1, state.segmentTranslationJobs.size), `${segmentTranslationLabel(job)} · 已加入翻译队列`);
  toast(`${segmentTranslationLabel(job)} 已加入翻译队列。`, "success", 2800);
  runSegmentTranslationQueue();
}

function runSegmentTranslationQueue() {
  while (
    state.activeSegmentTranslations < MAX_PARALLEL_SEGMENT_TRANSLATIONS
    && state.segmentTranslationQueue.length
  ) {
    const key = state.segmentTranslationQueue.shift();
    const job = state.segmentTranslationJobs.get(key);
    if (!job || job.status !== "queued") continue;
    void runSegmentTranslationJob(job);
  }
}

async function runSegmentTranslationJob(job) {
  state.activeSegmentTranslations += 1;
  job.status = "running";
  job.message = "正在请求 AI，完成后会写入英文 TeX。";
  updateSegmentTranslationRow(job);
  setFileTranslationProgress(1, 2, `${segmentTranslationLabel(job)} · 正在请求 AI 翻译...`);
  const slowTimer = window.setTimeout(() => {
    if (state.segmentTranslationJobs.get(job.key)?.status !== "running") return;
    job.message = "AI 仍在处理中；你可以继续把其他段落加入队列。";
    updateSegmentTranslationRow(job);
    setFileTranslationProgress(1, 2, `${segmentTranslationLabel(job)} · AI 仍在处理中，其他段落可以继续排队`, "warning");
  }, 15_000);
  try {
    const result = await api("/api/segment/translate", {
      method: "POST",
      body: JSON.stringify({
        file: job.file,
        index: job.index,
        sourceHash: job.sourceHash,
        chinese: job.chinese,
        deferCompile: job.deferCompile
      })
    });
    window.clearTimeout(slowTimer);
    state.segmentTranslationJobs.delete(job.key);
    if (state.currentFile === result.document.file) {
      state.currentDocument = result.document;
      renderSegments();
      scheduleFastPreview(result.document.file, 0);
    }
    updateBuild(result.build);
    invalidateReferences();
    scheduleProjectRefresh();
    if (result.build && !result.build.skipped) {
      setFileTranslationProgress(2, 2, result.build.success ? `${segmentTranslationLabel(job)} · 英文与 PDF 已更新` : `${segmentTranslationLabel(job)} · 英文已写入 TeX，但编译存在错误`, result.build.success ? "" : "error");
      toast(result.build.success ? `${segmentTranslationLabel(job)} 英文段落和 PDF 已更新。` : `${segmentTranslationLabel(job)} 英文段落已写入 TeX，但 PDF 编译存在错误。`, result.build.success ? "success" : "error", 5600);
    } else {
      setFileTranslationProgress(2, 2, `${segmentTranslationLabel(job)} · 英文已写入 TeX，PDF 尚未重新编译`);
      toast(`${segmentTranslationLabel(job)} 英文段落已写入 TeX。`, "success", 4200);
    }
  } catch (error) {
    window.clearTimeout(slowTimer);
    const message = translationFailureMessage(error);
    job.status = "failed";
    job.message = message;
    updateSegmentTranslationRow(job);
    setFileTranslationProgress(0, 2, `${segmentTranslationLabel(job)} · 翻译失败：${message}`, "error");
    toast(message, "error", 6200);
    window.setTimeout(() => {
      if (state.segmentTranslationJobs.get(job.key) !== job) return;
      state.segmentTranslationJobs.delete(job.key);
      if (state.currentFile === job.file && state.currentDocument) renderSegments();
    }, 7000);
  } finally {
    window.clearTimeout(slowTimer);
    state.activeSegmentTranslations = Math.max(0, state.activeSegmentTranslations - 1);
    runSegmentTranslationQueue();
  }
}

function createSegmentRow(segment) {
  const row = document.createElement("article");
  row.className = "segment-row";
  row.dataset.segmentId = segment.id;
  row.dataset.file = segment.file;
  row.dataset.segmentIndex = String(segment.index);
  row.dataset.segmentSourceHash = segment.sourceHash;
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
        <button class="mini-button comment-paragraph-button" type="button" title="注释本段（Ctrl+/）"><i data-lucide="percent"></i></button>
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
  const commentParagraphButton = row.querySelector(".comment-paragraph-button");
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
  attachCitationTarget(chinese);
  attachCitationTarget(english);
  if (segment.chinese) translateChineseButton.title = "重新翻译本段到中文";
  applySegmentTranslationState(row, segment);
  let englishSaveInFlight = false;
  let englishSavePending = false;
  const latestSourceHash = () => row.dataset.segmentSourceHash || segment.sourceHash;
  const markEnglishChanged = (message = "英文待保存") => {
    english.classList.add("changed");
    status.textContent = message;
    status.className = "segment-status english-changed";
  };
  const refreshSegmentSnapshot = (document) => {
    const nextSegment = document?.segments?.find((item) => item.index === segment.index);
    if (!nextSegment) return null;
    segment.id = nextSegment.id;
    segment.sourceHash = nextSegment.sourceHash;
    segment.english = nextSegment.english;
    segment.chinese = nextSegment.chinese;
    segment.translationStatus = nextSegment.translationStatus;
    row.dataset.segmentId = nextSegment.id;
    row.dataset.segmentSourceHash = nextSegment.sourceHash;
    return nextSegment;
  };
  const scheduleEnglishAutosave = (delay = 950) => {
    const key = segmentEnglishSaveTimerKey(segment);
    window.clearTimeout(state.saveTimers.get(key));
    state.saveTimers.set(key, window.setTimeout(() => {
      state.saveTimers.delete(key);
      void saveEnglish(false, { automatic: true });
    }, delay));
  };

  translateChineseButton.addEventListener("click", async () => {
    setBusy(translateChineseButton, true);
    setFileTranslationProgress(0, 1, `P${String(segment.index + 1).padStart(2, "0")} · 正在翻译本段...`);
    try {
      const result = await api("/api/file/translate-to-chinese", {
        method: "POST",
        body: JSON.stringify({
          file: segment.file,
          sectionId: segment.sectionId,
          segmentIds: [segment.id],
          force: true
        })
      });
      state.currentDocument = result.document;
      renderSegments();
      scheduleProjectRefresh();
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
    const key = segmentChineseSaveTimerKey(segment);
    window.clearTimeout(state.saveTimers.get(key));
    state.saveTimers.set(key, window.setTimeout(async () => {
      state.saveTimers.delete(key);
      try {
        const saved = await api("/api/segment/chinese", {
          method: "POST",
          body: JSON.stringify({
            file: segment.file,
            index: segment.index,
            sourceHash: latestSourceHash(),
            chinese: chinese.value
          })
        });
        if (!saved.stale) chinese.classList.remove("changed");
      } catch (error) {
        toast(error.message, "error");
      }
    }, 700));
  });

  const commentParagraph = async () => {
    const englishSelection = english.selectionEnd > english.selectionStart
      ? { selectionStart: english.selectionStart, selectionEnd: english.selectionEnd }
      : null;
    const chineseSelection = chinese.selectionEnd > chinese.selectionStart;
    if (!englishSelection && chineseSelection) {
      toast("中文选区无法安全定位到 TeX 源码；请在右侧英文 LaTeX 中选择对应内容，或取消选择后注释整段。", "warning", 6200);
      return;
    }
    clearSegmentSaveTimers(segment);
    setBusy(commentParagraphButton, true);
    try {
      const result = await api("/api/segment/comment", {
        method: "POST",
        body: JSON.stringify({
          file: segment.file,
          index: segment.index,
          sourceHash: latestSourceHash(),
          chinese: chinese.value,
          ...(englishSelection || {})
        })
      });
      state.currentDocument = result.document;
      renderSegments();
      scheduleFastPreview(result.document.file, 0);
      updateBuild(result.build);
      invalidateReferences();
      scheduleProjectRefresh();
      toast("本段已注释，TeX 源码仍然保留。", "success", 4600);
    } catch (error) {
      toast(error.message, "error", 5600);
    } finally {
      setBusy(commentParagraphButton, false);
    }
  };

  commentParagraphButton.addEventListener("click", commentParagraph);
  chinese.addEventListener("keydown", (event) => {
    if (event.key !== "/" || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    if (!commentParagraphButton.disabled) void commentParagraph();
  });
  english.addEventListener("keydown", (event) => {
    if (event.key !== "/" || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    if (!commentParagraphButton.disabled) void commentParagraph();
  });

  english.addEventListener("input", () => {
    fitSegmentRow(row);
    markEnglishChanged("英文待自动保存");
    englishSavePending = englishSaveInFlight;
    scheduleEnglishAutosave();
  });

  translateButton.addEventListener("click", () => {
    if (!chinese.value.trim()) {
      toast("请先填写中文工作稿。", "error");
      chinese.focus();
      return;
    }
    enqueueSegmentTranslation({ ...segment, sourceHash: latestSourceHash() }, chinese.value);
  });

  async function saveEnglish(force = false, options = {}) {
    const automatic = options.automatic === true;
    const timerKey = segmentEnglishSaveTimerKey(segment);
    window.clearTimeout(state.saveTimers.get(timerKey));
    state.saveTimers.delete(timerKey);
    if (englishSaveInFlight) {
      englishSavePending = true;
      if (!automatic) toast("英文正在保存，最新修改会继续写入 TeX。", "warning", 3000);
      return false;
    }

    const deferCompile = state.project?.config?.autoCompile !== true;
    const requestedEnglish = english.value;
    let forceRetry = false;
    let saved = false;
    englishSaveInFlight = true;
    setBusy(saveEnglishButton, true);
    status.textContent = automatic ? "英文自动保存中..." : "英文保存中...";
    status.className = "segment-status pending";
    try {
      const result = await api("/api/segment/english", {
        method: "POST",
        body: JSON.stringify({
          file: segment.file,
          index: segment.index,
          sourceHash: latestSourceHash(),
          english: requestedEnglish,
          chinese: chinese.value,
          deferCompile,
          force
        })
      });
      state.currentDocument = result.document;
      const nextSegment = refreshSegmentSnapshot(result.document);
      scheduleFastPreview(result.document.file, 0);
      updateBuild(result.build);
      invalidateReferences();
      scheduleProjectRefresh();
      if (english.value === requestedEnglish) {
        english.classList.remove("changed");
        status.textContent = automatic ? "英文已自动保存" : statusLabel(nextSegment?.translationStatus || segment.translationStatus);
        status.className = `segment-status ${automatic ? "synced" : (nextSegment?.translationStatus || segment.translationStatus)}`;
      } else {
        englishSavePending = true;
        markEnglishChanged("英文待继续保存");
      }
      if (!automatic && result.build && !result.build.skipped) {
        toast(result.build.success ? "英文修改已写入 TeX，PDF 已更新。" : "英文修改已写入 TeX，但编译仍有错误。", result.build.success ? "success" : "error");
      } else if (!automatic) {
        toast("英文修改已写入 TeX。需要更新 PDF 时请点击“编译全文”。", "success");
      }
      saved = true;
    } catch (error) {
      if (error.status === 409 && error.payload?.code === "LATEX_TOKEN_LOSS" && !force) {
        const missingTokens = error.payload.details?.missingTokens || [];
        const confirmed = window.confirm(`修改删除了 LaTeX 标记：\n${missingTokens.join("\n")}\n\n如果这是你主动删除的内容，可以继续保存。仍然写入 TeX 吗？`);
        if (confirmed) {
          forceRetry = true;
        } else {
          markEnglishChanged("英文未保存：等待确认");
        }
      } else {
        markEnglishChanged("英文保存失败");
        toast(error.message, "error", 5200);
      }
    } finally {
      englishSaveInFlight = false;
      setBusy(saveEnglishButton, false);
      if (!forceRetry && englishSavePending) {
        englishSavePending = false;
        scheduleEnglishAutosave(250);
      }
    }
    if (forceRetry) return saveEnglish(true, { automatic });
    return saved;
  }

  saveEnglishButton.addEventListener("click", () => saveEnglish(false));
  addParagraphButton.addEventListener("click", () => openParagraphDialog(segment));
  revertButton.addEventListener("click", () => {
    const timerKey = segmentEnglishSaveTimerKey(segment);
    window.clearTimeout(state.saveTimers.get(timerKey));
    state.saveTimers.delete(timerKey);
    englishSavePending = false;
    english.value = segment.english;
    fitSegmentRow(row);
    english.classList.remove("changed");
    status.textContent = statusLabel(segment.translationStatus);
    status.className = `segment-status ${segment.translationStatus}`;
  });
  deleteParagraphButton.addEventListener("click", async () => {
    const confirmed = window.confirm("删除当前段落会同时移除英文 TeX 内容和中文工作稿，可在之后按 Ctrl+Z 撤销。继续吗？");
    if (!confirmed) return;
    clearSegmentSaveTimers(segment);
    setBusy(deleteParagraphButton, true);
    try {
      const result = await api("/api/segment/delete", {
        method: "POST",
        body: JSON.stringify({
          file: segment.file,
          index: segment.index,
          sourceHash: latestSourceHash()
        })
      });
      state.currentDocument = result.document;
      renderSegments();
      scheduleFastPreview(result.document.file, 0);
      updateBuild(result.build);
      invalidateReferences();
      scheduleProjectRefresh();
      toast("段落已删除。", "success");
    } catch (error) {
      toast(error.payload?.code === "LAST_PARAGRAPH" ? "每个文件至少需要保留一个可编辑正文段落。" : error.message, "error", 5200);
    } finally {
      setBusy(deleteParagraphButton, false);
    }
  });
  attachMathDropTarget(row, {
    type: "segment",
    file: segment.file,
    index: segment.index,
    sourceHash: latestSourceHash()
  });
  return row;
}

function fitMathBlockEditor(editor) {
  editor.style.height = "auto";
  editor.style.height = `${Math.min(Math.max(editor.scrollHeight, 128), 420)}px`;
}

function createMathBlockRow(block) {
  const row = document.createElement("article");
  row.className = "math-row";
  row.dataset.file = block.file;
  row.dataset.mathId = block.id;
  row.dataset.mathStartLine = String(block.startLine);
  row.innerHTML = `
    <div class="segment-header math-header">
      <div class="segment-identity">
        <span class="segment-index"></span>
        <span class="line-range"></span>
        <span class="segment-status synced">公式 TeX</span>
      </div>
      <div class="segment-actions">
        <button class="mini-button math-drag-handle" type="button" draggable="true" title="拖动公式到其他段落之间"><i data-lucide="grip-vertical"></i></button>
        <button class="mini-button save-math-button" type="button" title="保存公式 TeX"><i data-lucide="save"></i></button>
        <button class="mini-button revert-math-button" type="button" title="恢复已加载的公式"><i data-lucide="undo-2"></i></button>
      </div>
    </div>
    <div class="math-editor">
      <textarea class="math-source-editor" spellcheck="false" aria-label="公式 TeX 源码"></textarea>
    </div>
  `;

  const status = row.querySelector(".segment-status");
  const editor = row.querySelector(".math-source-editor");
  const dragHandle = row.querySelector(".math-drag-handle");
  const saveButton = row.querySelector(".save-math-button");
  const revertButton = row.querySelector(".revert-math-button");

  row.querySelector(".segment-index").textContent = `F${String((block.index || 0) + 1).padStart(2, "0")}`;
  row.querySelector(".line-range").textContent = `L${block.startLine}-${block.endLine}`;
  editor.value = block.source || "";
  window.requestAnimationFrame(() => fitMathBlockEditor(editor));

  dragHandle.addEventListener("dragstart", (event) => {
    state.draggingMathBlock = {
      file: block.file,
      id: block.id,
      sourceHash: block.sourceHash,
      startLine: block.startLine
    };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", block.id);
    row.classList.add("dragging");
  });

  dragHandle.addEventListener("dragend", () => {
    state.draggingMathBlock = null;
    row.classList.remove("dragging");
    clearMathDropTargets();
  });

  editor.addEventListener("input", () => {
    editor.classList.add("changed");
    status.textContent = "公式待保存";
    status.className = "segment-status english-changed";
    fitMathBlockEditor(editor);
  });

  revertButton.addEventListener("click", () => {
    editor.value = block.source || "";
    editor.classList.remove("changed");
    status.textContent = "公式 TeX";
    status.className = "segment-status synced";
    fitMathBlockEditor(editor);
  });

  saveButton.addEventListener("click", async () => {
    const deferCompile = state.project?.config?.autoCompile !== true;
    setBusy(saveButton, true);
    try {
      const result = await api("/api/math-block", {
        method: "POST",
        body: JSON.stringify({
          file: block.file,
          id: block.id,
          sourceHash: block.sourceHash,
          startLine: block.startLine,
          source: editor.value,
          deferCompile
        })
      });
      state.currentDocument = result.document;
      renderSegments();
      scheduleFastPreview(result.document.file, 0);
      updateBuild(result.build);
      scheduleProjectRefresh();
      toast(
        result.build && !result.build.skipped
          ? result.build.success ? "公式已保存，PDF 已更新。" : "公式已保存，但编译仍有错误。"
          : "公式已保存。需要更新正式 PDF 时请点击“编译全文”。",
        result.build && !result.build.success ? "error" : "success",
        5200
      );
    } catch (error) {
      toast(error.message, "error", 5600);
    } finally {
      setBusy(saveButton, false);
    }
  });

  attachMathDropTarget(row, {
    type: "math",
    file: block.file,
    id: block.id,
    sourceHash: block.sourceHash,
    startLine: block.startLine
  });
  return row;
}

function tableMatrix(block, kind) {
  const english = (block.rows || []).map((row) => row.cells.map((cell) => cell.text || ""));
  if (kind === "english") return english;
  const chinese = Array.isArray(block.chineseRows) ? block.chineseRows : [];
  return english.map((row, rowIndex) => row.map((cell, columnIndex) => (
    chinese[rowIndex]?.[columnIndex] ?? cell
  )));
}

function createEditableTable(matrix, className) {
  const table = document.createElement("table");
  table.className = `editable-paper-table ${className}`;
  const tbody = document.createElement("tbody");
  matrix.forEach((row) => {
    const tr = document.createElement("tr");
    row.forEach((cell) => {
      const td = document.createElement("td");
      const textarea = document.createElement("textarea");
      textarea.value = cell;
      textarea.rows = 1;
      textarea.addEventListener("input", () => {
        textarea.style.height = "auto";
        textarea.style.height = `${Math.max(34, textarea.scrollHeight)}px`;
      });
      window.requestAnimationFrame(() => {
        textarea.style.height = "auto";
        textarea.style.height = `${Math.max(34, textarea.scrollHeight)}px`;
      });
      td.append(textarea);
      tr.append(td);
    });
    tbody.append(tr);
  });
  table.append(tbody);
  return table;
}

function readEditableTable(table) {
  return [...table.querySelectorAll("tr")].map((row) => (
    [...row.querySelectorAll("textarea")].map((textarea) => textarea.value.trim())
  ));
}

function createTableBlockRow(block) {
  const row = document.createElement("article");
  row.className = "table-row";
  row.dataset.file = block.file;
  row.dataset.tableId = block.id;
  row.innerHTML = `
    <div class="segment-header table-header">
      <div class="segment-identity">
        <span class="segment-index"></span>
        <span class="line-range"></span>
        <span class="segment-status synced">表格</span>
      </div>
      <div class="segment-actions">
        <button class="mini-button save-table-button" type="button" title="保存表格"><i data-lucide="save"></i></button>
        <button class="mini-button revert-table-button" type="button" title="恢复已加载的表格"><i data-lucide="undo-2"></i></button>
      </div>
    </div>
    <div class="table-editor">
      <div class="table-editor-label">中文表格</div>
      <div class="table-editor-scroll chinese-table"></div>
      <div class="table-editor-label">英文表格</div>
      <div class="table-editor-scroll english-table"></div>
    </div>
  `;
  const status = row.querySelector(".segment-status");
  const saveButton = row.querySelector(".save-table-button");
  const revertButton = row.querySelector(".revert-table-button");
  const chineseShell = row.querySelector(".chinese-table");
  const englishShell = row.querySelector(".english-table");

  const renderTables = () => {
    chineseShell.replaceChildren(createEditableTable(tableMatrix(block, "chinese"), "chinese"));
    englishShell.replaceChildren(createEditableTable(tableMatrix(block, "english"), "english"));
    status.textContent = "表格";
    status.className = "segment-status synced";
  };

  row.querySelector(".segment-index").textContent = `T${String((block.index || 0) + 1).padStart(2, "0")}`;
  row.querySelector(".line-range").textContent = `L${block.startLine}-${block.endLine}`;
  renderTables();
  row.addEventListener("input", (event) => {
    if (!event.target.closest(".table-editor")) return;
    status.textContent = "表格待保存";
    status.className = "segment-status english-changed";
  });

  revertButton.addEventListener("click", renderTables);

  saveButton.addEventListener("click", async () => {
    setBusy(saveButton, true);
    try {
      const result = await api("/api/table-block", {
        method: "POST",
        body: JSON.stringify({
          file: block.file,
          id: block.id,
          sourceHash: block.sourceHash,
          startLine: block.startLine,
          chineseRows: readEditableTable(chineseShell.querySelector("table")),
          englishRows: readEditableTable(englishShell.querySelector("table")),
          deferCompile: state.project?.config?.autoCompile !== true
        })
      });
      state.currentDocument = result.document;
      renderSegments();
      scheduleFastPreview(result.document.file, 0);
      updateBuild(result.build);
      scheduleProjectRefresh();
      toast("表格已保存。", "success");
    } catch (error) {
      toast(error.message, "error", 5600);
    } finally {
      setBusy(saveButton, false);
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
    toast("请先输入新增段落的中文或英文工作稿。", "error");
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
    scheduleFastPreview(result.document.file, 0);
    updateBuild(result.build);
    invalidateReferences();
    scheduleProjectRefresh();
    toast("新段落已生成并插入。", "success");
  } catch (error) {
    const missing = error.payload?.details?.missingTokens;
    toast(
      missing?.length
        ? `模型丢失 LaTeX 标记：${missing.join(", ")}`
        : error.payload?.code === "DANGEROUS_LATEX_COMMANDS"
          ? dangerousLatexMessage(error)
          : error.payload?.code === "INVALID_PARAGRAPH"
            ? "AI 没有返回可插入的英文正文段落，请重试或把新增内容写成一个完整段落。"
          : error.message,
      "error",
      6200
    );
  } finally {
    setBusy(button, false);
  }
}

function figureAnchorText(anchor) {
  if (!anchor) return "选择图片和排版位置";
  if (anchor.type === "source") return `${anchor.file} · 当前 TeX 光标位置`;
  return `${anchor.file} · P${String(Number(anchor.index || 0) + 1).padStart(2, "0")} 后方`;
}

function openFigureDialog(anchor) {
  state.figureAnchor = anchor;
  elements.figureImagesInput.value = "";
  elements.figurePlacementInput.value = anchor?.type === "source"
    ? "插入当前位置附近，放在栏顶部"
    : "插入本段之后，放在栏顶部";
  elements.figureCaptionInput.value = "";
  elements.figureLabelInput.value = "";
  elements.figureAnchorMeta.textContent = figureAnchorText(anchor);
  if (!elements.figureDialog.open) elements.figureDialog.showModal();
  window.requestAnimationFrame(() => elements.figureImagesInput.focus());
}

function closeFigureDialog() {
  state.figureAnchor = null;
  if (elements.figureDialog.open) elements.figureDialog.close();
}

async function openSourceFigureDialog() {
  if (!state.sourceFile) {
    toast("请先选择一个 TeX 文件。", "error");
    return;
  }
  if (!state.sourceFile.toLowerCase().endsWith(".tex")) {
    toast("图片只能插入 TeX 文件，不能插入 Bib 文件。", "error");
    return;
  }
  if (state.sourceDirty) {
    const saved = await saveSourceFile({ deferCompile: true, quiet: true, refreshPreview: false });
    if (!saved) return;
  }
  openFigureDialog({
    type: "source",
    file: state.sourceFile,
    sourceHash: state.sourceHash,
    cursorOffset: elements.sourceEditor.selectionStart || 0
  });
}

function applyFigureInsertionResult(result) {
  if (result.source && result.source.file === state.sourceFile) {
    state.sourceHash = result.source.sourceHash;
    state.sourceEol = result.source.eol || state.sourceEol;
    elements.sourceEditor.value = result.source.content;
    state.sourceSavedContent = elements.sourceEditor.value;
    state.sourceDirty = false;
    updateSourceLineNumbers();
    setSourceDirty(false);
    refreshSourceSearch();
  }
  if (result.document && result.document.file === state.currentFile) {
    state.currentDocument = result.document;
    renderSegments();
  }
  const previewFile = result.document?.file || result.source?.file || state.currentFile || state.sourceFile;
  if (previewFile?.toLowerCase().endsWith(".tex")) scheduleFastPreview(previewFile, 0);
  updateBuild(result.build);
  invalidateReferences();
  scheduleProjectRefresh();
}

async function submitFigureInsertion(event) {
  event.preventDefault();
  const anchor = state.figureAnchor;
  if (!anchor) return;
  if (state.sourceDirty && state.sourceFile === anchor.file) {
    const saved = await saveSourceFile({ deferCompile: true, quiet: true, refreshPreview: false });
    if (!saved) return;
    if (anchor.type === "source") anchor.sourceHash = state.sourceHash;
  }
  const images = elements.figureImagesInput.value.trim();
  if (!images) {
    toast("请先输入至少一张图片链接或路径。", "error");
    elements.figureImagesInput.focus();
    return;
  }
  setBusy(elements.insertFigureSubmitButton, true);
  try {
    const result = await api("/api/figure/insert", {
      method: "POST",
      body: JSON.stringify({
        file: anchor.file,
        anchor,
        images,
        description: elements.figurePlacementInput.value.trim(),
        caption: elements.figureCaptionInput.value.trim(),
        label: elements.figureLabelInput.value.trim(),
        deferCompile: state.project?.config?.autoCompile !== true
      })
    });
    closeFigureDialog();
    applyFigureInsertionResult(result);
    const copied = (result.assets || []).filter((asset) => asset.copied).length;
    toast(`已插入 ${result.assets?.length || 0} 张图片${copied ? `，并复制到项目内 ${copied} 张` : ""}。`, "success", 5600);
  } catch (error) {
    toast(error.message, "error", 6800);
  } finally {
    setBusy(elements.insertFigureSubmitButton, false);
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
  const mathBlocks = documentPayload.mathBlocks || [];
  const tableBlocks = documentPayload.tableBlocks || [];
  const items = [
    ...documentPayload.segments.map((segment) => ({ type: "segment", startLine: segment.startLine, item: segment })),
    ...mathBlocks.map((block) => ({ type: "math", startLine: block.startLine, item: block })),
    ...tableBlocks.map((block) => ({ type: "table", startLine: block.startLine, item: block }))
  ].sort((left, right) => (
    Number(left.startLine || 0) - Number(right.startLine || 0)
    || (left.type === "segment" ? -1 : left.type === "math" ? 0 : 1)
  ));
  elements.currentFile.textContent = fileLabel(documentPayload.file);
  elements.fileMeta.textContent = `${documentPayload.segments.length} 段 · ${mathBlocks.length} 公式 · ${tableBlocks.length} 表格 · ${sections.length} 节`;
  elements.segmentList.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "此文件没有检测到可编辑的正文段落、公式或表格";
    elements.segmentList.append(empty);
  } else {
    let previousHeadingPath = [];
    for (const entry of items) {
      const headingPath = Array.isArray(entry.item.headingPath) ? entry.item.headingPath : [];
      let commonLength = 0;
      while (
        commonLength < previousHeadingPath.length
        && commonLength < headingPath.length
        && previousHeadingPath[commonLength].id === headingPath[commonLength].id
      ) commonLength += 1;
      for (const heading of headingPath.slice(commonLength)) {
        const node = document.createElement("div");
        node.className = `segment-heading level-${heading.level}`;
        const kind = document.createElement("span");
        kind.className = "segment-heading-kind";
        kind.textContent = heading.level === 1 ? "章节" : heading.level === 2 ? "小节" : "三级标题";
        const title = document.createElement("strong");
        title.className = "segment-heading-title";
        title.textContent = heading.title;
        const line = document.createElement("span");
        line.className = "segment-heading-line";
        line.textContent = `L${heading.line}`;
        node.append(kind, title, line);
        elements.segmentList.append(node);
      }
      elements.segmentList.append(
        entry.type === "segment"
          ? createSegmentRow(entry.item)
          : entry.type === "math" ? createMathBlockRow(entry.item) : createTableBlockRow(entry.item)
      );
      previousHeadingPath = headingPath;
    }
  }
  fitAllSegmentRows();
  renderDocumentList();
  updateTranslateFileButton();
  refreshIcons();
}

async function loadDocument(file) {
  state.currentFile = file;
  state.currentDocument = null;
  state.currentSectionId = null;
  renderFileTranslationProgress(file);
  elements.segmentList.innerHTML = '<div class="empty-state">正在读取段落...</div>';
  try {
    state.currentDocument = await api(`/api/document?file=${encodeURIComponent(file)}`);
    renderSegments();
    if (state.previewMode === "fast") scheduleFastPreview(file, 0);
    if (state.mode === "source") {
      const loaded = await loadSourceFile(file);
      if (!loaded) renderSourceFileOptions(state.sourceFile);
    } else if (!state.sourceDirty) {
      renderSourceFileOptions(file);
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

function ensureSourceSearchControls() {
  if (elements.sourceSearchInput) return;
  const toolbar = elements.sourceFileSelect.closest(".toolbar-actions");
  const search = document.createElement("div");
  search.className = "source-search";
  search.setAttribute("role", "search");
  search.innerHTML = `
    <i data-lucide="search"></i>
    <input id="sourceSearchInput" type="search" autocomplete="off" placeholder="搜索 TeX 源码" disabled>
    <span id="sourceSearchCount">0 / 0</span>
    <button class="icon-button small" id="sourceSearchPreviousButton" type="button" title="上一个匹配" disabled>
      <i data-lucide="chevron-up"></i>
    </button>
    <button class="icon-button small" id="sourceSearchNextButton" type="button" title="下一个匹配" disabled>
      <i data-lucide="chevron-down"></i>
    </button>
  `;
  toolbar.insertBefore(search, elements.sourceFileSelect);
  elements.sourceSearchInput = search.querySelector("#sourceSearchInput");
  elements.sourceSearchCount = search.querySelector("#sourceSearchCount");
  elements.sourceSearchPreviousButton = search.querySelector("#sourceSearchPreviousButton");
  elements.sourceSearchNextButton = search.querySelector("#sourceSearchNextButton");
}

function sourceLineCount() {
  return elements.sourceEditor.value.split(/\r?\n/).length;
}

function sourceCursorPosition() {
  const value = elements.sourceEditor.value.slice(0, elements.sourceEditor.selectionStart || 0);
  const lines = value.split(/\r?\n/);
  return {
    line: lines.length,
    column: (lines.at(-1) || "").length + 1
  };
}

function updateSourceLineNumbers() {
  const count = sourceLineCount();
  elements.sourceLineNumbers.textContent = Array.from({ length: count }, (_value, index) => index + 1).join("\n");
}

function toggleSourceLineComments() {
  const editor = elements.sourceEditor;
  const value = editor.value;
  const selectionStart = editor.selectionStart;
  const selectionEnd = editor.selectionEnd;
  const effectiveEnd = selectionEnd > selectionStart && value[selectionEnd - 1] === "\n"
    ? selectionEnd - 1
    : selectionEnd;
  const rangeStart = value.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
  const nextBreak = value.indexOf("\n", effectiveEnd);
  const rangeEnd = nextBreak === -1 ? value.length : nextBreak;
  const lines = value.slice(rangeStart, rangeEnd).split("\n");
  const contentLines = lines.filter((line) => line.trim());
  const uncomment = contentLines.length > 0 && contentLines.every((line) => /^\s*%/.test(line));
  const replacement = lines.map((line) => {
    if (!line.trim()) return line;
    return uncomment
      ? line.replace(/^(\s*)%\s?/, "$1")
      : line.replace(/^(\s*)/, "$1% ");
  }).join("\n");
  editor.setRangeText(replacement, rangeStart, rangeEnd, "select");
  editor.dispatchEvent(new Event("input", { bubbles: true }));
}

function updateSourceStatus() {
  if (!state.sourceFile || elements.sourceEditor.disabled) return;
  const lines = sourceLineCount();
  const cursor = sourceCursorPosition();
  const saved = state.sourceDirty ? "有未保存修改" : "已保存";
  elements.sourceStatus.textContent = `${lines} 行 · 第 ${cursor.line} 行，第 ${cursor.column} 列 · ${saved}`;
}

function setSourceDirty(dirty) {
  state.sourceDirty = dirty;
  elements.sourceStatus.classList.toggle("dirty", dirty);
  elements.sourceStatus.classList.remove("error");
  elements.saveSourceButton.disabled = !dirty;
  updateSourceStatus();
}

function setSourceSearchEnabled(enabled) {
  if (!elements.sourceSearchInput) return;
  elements.sourceSearchInput.disabled = !enabled;
  const hasMatches = enabled && state.sourceSearchMatches.length > 0;
  elements.sourceSearchPreviousButton.disabled = !hasMatches;
  elements.sourceSearchNextButton.disabled = !hasMatches;
}

function refreshSourceSearch({ keepIndex = false } = {}) {
  if (!elements.sourceSearchInput) return;
  const query = elements.sourceSearchInput.value;
  state.sourceSearchQuery = query;
  state.sourceSearchMatches = [];
  state.sourceSearchIndex = keepIndex ? state.sourceSearchIndex : -1;
  if (!query) {
    elements.sourceSearchCount.textContent = "0 / 0";
    setSourceSearchEnabled(Boolean(state.sourceFile));
    return;
  }
  const text = elements.sourceEditor.value.toLowerCase();
  const needle = query.toLowerCase();
  let position = 0;
  while (needle && position <= text.length) {
    const index = text.indexOf(needle, position);
    if (index < 0) break;
    state.sourceSearchMatches.push({ start: index, end: index + query.length });
    position = index + Math.max(needle.length, 1);
  }
  if (state.sourceSearchMatches.length && state.sourceSearchIndex >= state.sourceSearchMatches.length) {
    state.sourceSearchIndex = state.sourceSearchMatches.length - 1;
  }
  const current = state.sourceSearchIndex >= 0 ? state.sourceSearchIndex + 1 : 0;
  elements.sourceSearchCount.textContent = `${current} / ${state.sourceSearchMatches.length}`;
  setSourceSearchEnabled(Boolean(state.sourceFile));
}

function selectSourceSearchMatch(index) {
  const matches = state.sourceSearchMatches;
  if (!matches.length) {
    elements.sourceSearchCount.textContent = "0 / 0";
    toast("没有找到匹配内容。", "error", 2600);
    return;
  }
  state.sourceSearchIndex = (index + matches.length) % matches.length;
  const match = matches[state.sourceSearchIndex];
  elements.sourceEditor.focus();
  elements.sourceEditor.setSelectionRange(match.start, match.end);
  const lineHeight = Number.parseFloat(getComputedStyle(elements.sourceEditor).lineHeight) || 20;
  const line = elements.sourceEditor.value.slice(0, match.start).split(/\r?\n/).length;
  elements.sourceEditor.scrollTop = Math.max(0, (line - 4) * lineHeight);
  elements.sourceLineNumbers.scrollTop = elements.sourceEditor.scrollTop;
  elements.sourceSearchCount.textContent = `${state.sourceSearchIndex + 1} / ${matches.length}`;
  flashSourceSelection();
  updateSourceStatus();
}

function moveSourceSearch(direction) {
  if (!elements.sourceSearchInput.value) {
    elements.sourceSearchInput.focus();
    return;
  }
  if (elements.sourceSearchInput.value !== state.sourceSearchQuery) refreshSourceSearch();
  const nextIndex = state.sourceSearchIndex < 0 ? 0 : state.sourceSearchIndex + direction;
  selectSourceSearchMatch(nextIndex);
}

function focusSourceSearch() {
  if (!elements.sourceSearchInput || state.mode !== "source" || !state.sourceFile) return;
  elements.sourceSearchInput.disabled = false;
  elements.sourceSearchInput.focus();
  elements.sourceSearchInput.select();
  refreshSourceSearch({ keepIndex: true });
}

function confirmDiscardSourceChanges() {
  return !state.sourceDirty || window.confirm("当前源码有未保存修改。放弃这些修改吗？");
}

function renderSourceFileOptions(preferredFile = "") {
  const files = state.project?.sourceFiles || state.project?.texFiles || [];
  const requested = String(preferredFile || "").replaceAll("\\", "/");
  const currentDocumentFile = String(state.currentFile || state.currentDocument?.file || "").replaceAll("\\", "/");
  let preferred = files.includes(requested) ? requested : "";
  if (!preferred && !state.sourceDirty && files.includes(currentDocumentFile)) preferred = currentDocumentFile;
  if (!preferred && files.includes(state.sourceFile)) preferred = state.sourceFile;
  if (!preferred && files.includes(state.project?.config?.mainTex)) preferred = state.project.config.mainTex;
  if (!preferred) preferred = files[0];
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
  setSourceSearchEnabled(files.length > 0);
  if (!files.length) {
    elements.sourceEditor.value = "";
    elements.sourceLineNumbers.textContent = "1";
    state.sourceSearchMatches = [];
    state.sourceSearchIndex = -1;
    if (elements.sourceSearchCount) elements.sourceSearchCount.textContent = "0 / 0";
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
    refreshSourceSearch();
    if (state.previewMode === "fast" && source.file.toLowerCase().endsWith(".tex")) scheduleFastPreview(source.file, 0);
    return true;
  } catch (error) {
    elements.sourceStatus.classList.add("error");
    elements.sourceStatus.textContent = "源码读取失败";
    toast(error.message, "error", 5200);
    return false;
  }
}

async function saveSourceFile(options = {}) {
  const deferCompile = options.deferCompile ?? true;
  const quiet = options.quiet === true;
  if (!state.sourceFile || !state.sourceDirty) return true;
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
        sourceHash: state.sourceHash,
        deferCompile,
        refreshDocument: options.refreshDocument === true
      })
    });
    state.sourceHash = result.source.sourceHash;
    state.sourceEol = result.source.eol || state.sourceEol;
    state.sourceSavedContent = elements.sourceEditor.value;
    state.sourceDirty = false;
    if (options.refreshPreview !== false) scheduleFastPreview(previewFileAfterSourceChange(state.sourceFile), 0);
    updateBuild(result.build);
    const savedFile = result.source.file;
    if (result.project) state.project = result.project;
    invalidateReferences();
    if (result.document && savedFile === state.currentFile) {
      state.currentDocument = result.document;
      renderSegments();
    } else if (savedFile === state.currentFile) {
      state.currentDocument = null;
    }
    if (!quiet) {
      const kind = state.sourceFile.toLowerCase().endsWith(".bib") ? "Bib" : "TeX";
      toast(
        result.build
          ? result.build.skipped
            ? `${kind} 源码已保存。`
            : result.build.success ? `${kind} 源码已保存，PDF 已更新。` : `${kind} 源码已保存，但编译仍有错误。`
          : `${kind} 源码已保存。需要更新 PDF 时请点击“编译全文”。`,
        !result.build || result.build.success || result.build.skipped ? "success" : "error",
        5200
      );
    }
    return true;
  } catch (error) {
    if (error.status === 409 && error.payload?.code === "SOURCE_CHANGED") {
      const reload = window.confirm("该源码文件已在其他位置发生变化。是否放弃当前修改并重新载入？");
      if (reload) await loadSourceFile(state.sourceFile, { force: true });
    } else {
      elements.sourceStatus.classList.add("error");
      elements.sourceStatus.textContent = "保存失败 · 修改仍保留在编辑器中";
      toast(error.message, "error", 6200);
    }
    return false;
  } finally {
    setBusy(button, false);
    setSourceDirty(elements.sourceEditor.value !== state.sourceSavedContent);
  }
}

async function createTexFile() {
  if (state.sourceDirty) {
    const saved = await saveSourceFile({ deferCompile: true, quiet: true, refreshPreview: false });
    if (!saved) return;
  }
  const file = window.prompt("请输入新的 TeX 文件名，例如 sections/new-section.tex", "new-section.tex");
  if (file === null) return;
  const prepared = file.trim();
  if (!prepared) return;
  setBusy(elements.createTexFileButton, true);
  try {
    const result = await api("/api/source/create", {
      method: "POST",
      body: JSON.stringify({ file: prepared })
    });
    state.project = result.project;
    if (state.mode !== "source") setMode("source", { loadCurrent: false });
    renderDocumentList();
    renderSourceFileOptions(result.source.file);
    await loadSourceFile(result.source.file, { force: true });
    toast("TeX 文件已创建。", "success");
  } catch (error) {
    toast(error.message, "error", 5200);
  } finally {
    setBusy(elements.createTexFileButton, false);
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
    const saved = await saveSourceFile({ deferCompile: true, quiet: true, refreshPreview: false });
    if (!saved) return;
  }
  const buttons = [document.querySelector("#compileButton"), elements.previewCompileButton];
  buttons.forEach((button) => setBusy(button, true));
  try {
    setPreviewMode("pdf");
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
    buttons.forEach((button) => setBusy(button, false));
  }
}

async function changeGitRemoteTarget(event) {
  const remoteName = String(event.currentTarget.value || "");
  if (!remoteName || remoteName === state.gitRemoteName) return;
  const selectedLabel = event.currentTarget.selectedOptions[0]?.textContent || remoteName;
  event.currentTarget.disabled = true;
  try {
    await api("/api/projects/git/default", {
      method: "POST",
      body: JSON.stringify({ projectRoot: state.project.config.projectRoot, remoteName })
    });
    await refreshProject({ remoteName });
    toast(`默认同步目标已切换为 ${selectedLabel}。`, "success", 3600);
  } catch (error) {
    updateProjectHeader();
    toast(error.message, "error", 5200);
  }
}

async function pullPaper() {
  if (state.sourceDirty) {
    toast("请先保存或放弃源码修改，再拉取远端版本。", "error", 5200);
    return;
  }
  const button = document.querySelector("#pullButton");
  const remoteName = state.gitRemoteName;
  const remoteLabel = state.project.git.remoteLabel || "远端仓库";
  setBusy(button, true);
  try {
    const result = await api("/api/git/pull", {
      method: "POST",
      body: JSON.stringify({ remoteName })
    });
    if (result.project) await applyProjectPayload(result.project, { preserveDocument: false });
    else await refreshProject({ preserveDocument: false });
    await compilePaper();
    toast(`已从 ${remoteLabel} 拉取最新版本。`, "success");
  } catch (error) {
    if (await resolveGitSyncConflictFromError(error, "pull")) return;
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

function finishGitConflictSelection(value) {
  const resolve = state.gitConflictResolver;
  state.gitConflictResolver = null;
  if (elements.gitConflictDialog.open) elements.gitConflictDialog.close();
  if (resolve) resolve(value);
}

function renderConflictSnippet(title, snippet, className = "") {
  const panel = document.createElement("div");
  panel.className = `git-conflict-snippet ${className}`.trim();
  const label = document.createElement("div");
  label.className = "git-conflict-snippet-title";
  label.textContent = title;
  const pre = document.createElement("pre");
  pre.textContent = snippet || "（没有可预览的文本内容）";
  panel.append(label, pre);
  return panel;
}

function chooseGitSyncConflict(details = {}) {
  const files = details.files || [];
  const autoResolved = details.autoResolvedFiles || [];
  elements.gitConflictList.replaceChildren();
  elements.gitConflictMeta.textContent = autoResolved.length
    ? `已按更新时间自动处理 ${autoResolved.length} 个文件；还有 ${files.length} 个文件需要手动选择`
    : `${details.remoteLabel || "Overleaf"} 与本地共有 ${files.length} 个冲突文件，无法按更新时间判断`;
  files.forEach((item, index) => {
    const row = document.createElement("section");
    row.className = "git-conflict-row";
    row.dataset.file = item.file;
    const header = document.createElement("div");
    header.className = "git-conflict-row-header";
    const pathNode = document.createElement("div");
    pathNode.className = "git-conflict-path";
    pathNode.textContent = item.file;
    const sizeNode = document.createElement("div");
    sizeNode.className = "git-conflict-size";
    const timeNote = item.localUpdatedAt || item.remoteUpdatedAt
      ? ` · 本地 ${item.localUpdatedAt || "未知"} / ${details.remoteLabel || "Overleaf"} ${item.remoteUpdatedAt || "未知"}`
      : "";
    sizeNode.textContent = `本地 ${item.localBytes || 0} B / ${details.remoteLabel || "Overleaf"} ${item.remoteBytes || 0} B${timeNote}`;
    header.append(pathNode, sizeNode);

    const options = document.createElement("div");
    options.className = "git-conflict-options";
    const localOption = document.createElement("label");
    const localRadio = document.createElement("input");
    localRadio.type = "radio";
    localRadio.name = `git-conflict-${index}`;
    localRadio.value = "local";
    localRadio.checked = true;
    localOption.append(localRadio, document.createTextNode("保留本地版本"));
    const remoteOption = document.createElement("label");
    const remoteRadio = document.createElement("input");
    remoteRadio.type = "radio";
    remoteRadio.name = `git-conflict-${index}`;
    remoteRadio.value = "remote";
    remoteOption.append(remoteRadio, document.createTextNode(`保留 ${details.remoteLabel || "Overleaf"} 版本`));
    options.append(localOption, remoteOption);

    const snippets = document.createElement("div");
    snippets.className = "git-conflict-snippets";
    if (item.diffSnippet) snippets.append(renderConflictSnippet("冲突位置", item.diffSnippet, "wide"));
    snippets.append(
      renderConflictSnippet("本地版本", item.localSnippet, "local"),
      renderConflictSnippet(`${details.remoteLabel || "Overleaf"} 版本`, item.remoteSnippet, "remote")
    );

    row.append(header, options, snippets);
    elements.gitConflictList.append(row);
  });
  if (!elements.gitConflictDialog.open) elements.gitConflictDialog.showModal();
  refreshIcons();
  return new Promise((resolve) => {
    state.gitConflictResolver = resolve;
  });
}

async function resolveGitSyncConflictFromError(error, operation) {
  if (error.status !== 409 || error.payload?.code !== "GIT_SYNC_CONFLICT") return false;
  const details = error.payload.details || {};
  const choices = await chooseGitSyncConflict(details);
  if (!choices) {
    toast("已取消冲突合并。本地内容和远端内容都没有被覆盖。", "error", 5600);
    return true;
  }
  toast("正在按你的选择合并冲突...", "success", 3600);
  const result = await api("/api/git/resolve-conflict", {
    method: "POST",
    body: JSON.stringify({
      operation: details.operation || operation,
      files: choices,
      remoteName: details.remoteName || state.gitRemoteName,
      message: operation === "push"
        ? "Resolve remote conflict before pushing"
        : "Resolve remote conflict after pulling"
    })
  });
  updateBuild(result.build);
  if (result.project) await applyProjectPayload(result.project, { preserveDocument: false });
  else await refreshProject({ preserveDocument: false });
  toast(
    operation === "push"
      ? (result.pushed ? `已按选择合并并推送到 ${details.remoteLabel || "远端仓库"}。` : "已按选择合并，没有新的提交需要推送。")
      : `已按选择合并 ${details.remoteLabel || "远端仓库"} 的修改。`,
    "success",
    6200
  );
  return true;
}

function summarizeChangedGitFiles(files = [], limit = 3) {
  const names = files.map((file) => String(file || "").replace(/^[ MADRCU?!]{1,2}\s+/, "").trim()).filter(Boolean);
  if (names.length <= limit) return names.join("、");
  return `${names.slice(0, limit).join("、")} 等`;
}

async function pushPaper() {
  if (state.sourceDirty) {
    toast("请先保存源码修改，再推送论文。", "error", 5200);
    return;
  }
  const button = document.querySelector("#pushButton");
  const remoteName = state.gitRemoteName;
  const remoteLabel = state.project.git.remoteLabel || "远端仓库";
  let selection = null;
  setBusy(button, true);
  try {
    toast("正在检查待推送文件...", "success", 2400);
    const preview = await api(`/api/git/push-preview?remoteName=${encodeURIComponent(remoteName)}`);
    if (preview.required) {
      toast("首次推送需要确认上传文件，请在弹窗中点击“确认并推送”。", "success", 5200);
      selection = await chooseGitPushFiles(preview);
      if (!selection) {
        toast("已取消推送，本地文件没有上传。", "error", 4200);
        return;
      }
    }
    toast(`正在提交并推送到 ${remoteLabel}...`, "success", 4200);
    const result = await api("/api/git/push", {
      method: "POST",
      body: JSON.stringify({
        message: "Update bilingual paper draft",
        confirmed: Boolean(selection),
        files: selection || [],
        remoteName
      })
    });
    updateBuild(result.build);
    if (result.project) await applyProjectPayload(result.project);
    else await refreshProject();
    const git = result.project?.git || result.status || state.project?.git;
    const pending = git?.changedFiles?.length || 0;
    if (pending) {
      const examples = summarizeChangedGitFiles(git.changedFiles);
      toast(
        result.pushed
          ? `已推送远端，但仍有 ${pending} 个本地文件未提交：${examples}`
          : `没有新的提交被推送，仍有 ${pending} 个本地文件未提交：${examples}`,
        "error",
        7600
      );
    } else {
      toast(result.pushed ? `已推送至 ${remoteLabel}。` : `没有需要推送到 ${remoteLabel} 的修改。`, "success", 5200);
    }
  } catch (error) {
    updateBuild(error.payload?.details);
    if (await resolveGitSyncConflictFromError(error, "push")) return;
    toast(error.message, "error", 5600);
  } finally {
    setBusy(button, false);
  }
}

async function translateCurrentFile() {
  if (!state.currentFile || !state.currentDocument) return;
  const translationFile = state.currentFile;
  if (state.fileTranslationJobs.has(translationFile)) {
    state.visibleTranslationJobFile = translationFile;
    renderFileTranslationProgress(translationFile);
    toast(`${translationFile} 正在后台翻译，可以继续查看或编辑其他 TeX。`, "success", 4200);
    return;
  }
  const pendingIds = state.currentDocument.segments
    .map((segment) => segment.id);
  if (!pendingIds.length) {
    toast("当前 TeX 文件没有可翻译的段落。", "success");
    return;
  }
  const currentFileLabel = translationFile;
  const total = pendingIds.length;
  const job = {
    file: translationFile,
    total,
    completed: 0,
    translated: 0,
    skipped: 0,
    label: `${currentFileLabel} · 正在提取术语表...`,
    statusClass: ""
  };
  state.fileTranslationJobs.set(translationFile, job);
  state.visibleTranslationJobFile = translationFile;
  renderFileTranslationProgress(translationFile);
  try {
    const terminology = await api("/api/file/terminology", {
      method: "POST",
      body: JSON.stringify({ file: translationFile })
    });
    job.label = `${currentFileLabel} · 术语表 ${terminology.entries?.length || 0} 条，正在准备翻译...`;
    renderFileTranslationProgress(translationFile);
    for (let offset = 0; offset < pendingIds.length; offset += 1) {
      const segmentIds = pendingIds.slice(offset, offset + 1);
      const end = Math.min(offset + segmentIds.length, total);
      job.label = `${currentFileLabel} · 正在翻译第 ${offset + 1}-${end} 段...`;
      renderFileTranslationProgress(translationFile);
      const result = await api("/api/file/translate-to-chinese", {
        method: "POST",
        body: JSON.stringify({ file: translationFile, segmentIds, force: true })
      });
      if (state.currentFile === translationFile) {
        state.currentDocument = result.document;
        renderSegments();
      }
      job.completed += result.progress?.attempted ?? segmentIds.length;
      job.translated += result.progress?.translated ?? 0;
      job.skipped += result.progress?.skipped ?? 0;
      job.label = `${currentFileLabel} · 已处理 ${job.completed} 个段落`;
      renderFileTranslationProgress(translationFile);
    }
    scheduleProjectRefresh();
    if (job.skipped) {
      finishFileTranslationJob(translationFile, {
        label: `${currentFileLabel} · 翻译完成，${job.skipped} 段未收到有效结果`,
        statusClass: "warning"
      });
      toast(`${currentFileLabel} 中文工作稿已更新，模型没有返回其中 ${job.skipped} 个段落的有效翻译。`, "error", 5600);
    } else {
      finishFileTranslationJob(translationFile, {
        label: `${currentFileLabel} · 翻译完成，共更新 ${job.translated} 个段落`,
        statusClass: ""
      });
      toast(`${currentFileLabel} 的中文工作稿已更新。`, "success");
    }
  } catch (error) {
    if (state.currentFile === translationFile && state.currentDocument) renderSegments();
    finishFileTranslationJob(translationFile, {
      label: `${currentFileLabel} · 翻译中断：${error.message}`,
      statusClass: "error"
    });
    toast(error.message, "error", 5600);
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
  const exportToken = ++state.pdfExportToken;
  const previousStatus = elements.pageStatus.textContent;
  const exportStatuses = new Set(["正在保存 PDF...", "PDF 已保存", "已取消保存 PDF", "PDF 下载已开始", "PDF 保存失败"]);
  setBusy(elements.exportPdfButton, true);
  elements.pageStatus.textContent = "正在保存 PDF...";
  try {
    if (window.paperBridgeDesktop) {
      const destination = await window.paperBridgeDesktop.exportPdf(name);
      if (destination) {
        elements.pageStatus.textContent = "PDF 已保存";
        toast(`PDF 已导出到 ${destination}`, "success", 5200);
      } else {
        elements.pageStatus.textContent = "已取消保存 PDF";
        toast("已取消保存 PDF。", "success", 2600);
      }
      return;
    }
    const link = document.createElement("a");
    link.href = "/api/pdf";
    link.download = name;
    link.click();
    elements.pageStatus.textContent = "PDF 下载已开始";
    toast("PDF 下载已开始。", "success", 3200);
  } catch (error) {
    elements.pageStatus.textContent = "PDF 保存失败";
    toast(error.message, "error");
  } finally {
    setBusy(elements.exportPdfButton, false);
    window.setTimeout(() => {
      if (state.pdfExportToken === exportToken && exportStatuses.has(elements.pageStatus.textContent)) {
        elements.pageStatus.textContent = previousStatus;
      }
    }, 2200);
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
  const referencesOpen = mode === "references";
  document.querySelectorAll(".mode-button").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  elements.workspace.classList.toggle("references-open", referencesOpen);
  elements.editView.classList.toggle("hidden", mode !== "edit" && !referencesOpen);
  elements.sourceView.classList.toggle("hidden", mode !== "source");
  elements.referencesView.classList.toggle("hidden", !referencesOpen);
  elements.formatView.classList.toggle("hidden", mode !== "format");
  elements.previewPanel.classList.toggle("hidden", referencesOpen);
  if (mode === "source") {
    renderSourceFileOptions(loadCurrent ? state.currentFile : state.sourceFile);
    if (loadCurrent) void loadSourceFile(elements.sourceFileSelect.value, { force: true });
  }
  if (mode === "edit" && state.currentFile && loadCurrent) void loadDocument(state.currentFile);
  if (mode === "references") void loadReferences();
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
  document.querySelector("#migrateStorageButton").disabled = true;
  document.querySelector("#projectRootInput").value = config.projectRoot;
  document.querySelector("#projectNameInput").value = config.projectName || fileLabel(config.projectRoot || "论文项目");
  const overleafToken = document.querySelector("#overleafTokenInput");
  overleafToken.value = "";
  overleafToken.placeholder = config.hasOverleafToken ? "已保存，留空保持不变" : "用于自动拉取和推送";
  document.querySelector("#clearOverleafTokenButton").disabled = !config.hasOverleafToken;
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
  updateStorageMigrationButton();
  refreshIcons();
  elements.settingsDialog.showModal();
}

function updateStorageMigrationButton() {
  const config = state.project?.config || {};
  const input = document.querySelector("#storageRootInput");
  const migrateButton = document.querySelector("#migrateStorageButton");
  const note = document.querySelector("#storageMigrationNote");
  const value = input.value.trim();
  const canChange = config.canChangeStorage !== false;
  const changed = state.storageRootSelected && value && value !== config.storageRoot;
  migrateButton.disabled = !canChange || !changed;
  if (!canChange) {
    note.textContent = "当前运行方式不支持在软件内迁移数据目录。";
  } else if (changed) {
    note.textContent = "已选择新的数据位置。确认无误后，点击“迁移数据目录”执行迁移；仅保存设置不会迁移数据。";
  } else {
    note.textContent = "选择新的空文件夹后，点击“迁移数据目录”才会迁移配置、中文工作稿、备份和 PaperBridge 导入的项目；外部本地项目不会移动。";
  }
}

async function migrateStorageFromSettings() {
  const previous = state.project.config;
  const storageRoot = document.querySelector("#storageRootInput").value.trim();
  const storageChanged = state.storageRootSelected && storageRoot && storageRoot !== previous.storageRoot;
  if (!storageChanged) {
    toast("请先选择一个新的数据保存位置。", "warning");
    return false;
  }
  if (state.sourceDirty) {
    if (!confirmDiscardSourceChanges()) return false;
    state.sourceDirty = false;
  }
  const confirmed = window.confirm([
    "PaperBridge 将把配置、中文工作稿、备份和已导入的项目迁移到新位置。",
    "外部打开的本地论文文件夹不会移动。迁移完成前请勿关闭程序。",
    "",
    `新位置：${storageRoot}`
  ].join("\n"));
  if (!confirmed) return false;
  const button = document.querySelector("#migrateStorageButton");
  setBusy(button, true);
  try {
    const oldProjectRoot = previous.projectRoot;
    let projectRoot = document.querySelector("#projectRootInput").value.trim();
    const result = await api("/api/storage/migrate", {
      method: "POST",
      body: JSON.stringify({ storageRoot })
    });
    state.project = result.project;
    const nextConfig = state.project.config;
    if (projectRoot === oldProjectRoot) projectRoot = nextConfig.projectRoot;
    document.querySelector("#storageRootInput").value = nextConfig.storageRoot;
    document.querySelector("#projectRootInput").value = projectRoot;
    state.storageRootSelected = false;
    updateStorageMigrationButton();
    await refreshProject({ preserveDocument: false });
    if (result.migration.cleanupWarning) toast(result.migration.cleanupWarning, "error", 7000);
    toast("数据目录迁移完成。", "success");
    return true;
  } catch (error) {
    toast(error.message, "error", 7000);
    return false;
  } finally {
    setBusy(button, false);
    updateStorageMigrationButton();
  }
}

async function clearOverleafToken() {
  const button = document.querySelector("#clearOverleafTokenButton");
  if (!state.project.config?.hasOverleafToken && !document.querySelector("#overleafTokenInput").value.trim()) {
    toast("当前没有已保存的 Overleaf Token。", "warning");
    return;
  }
  if (!window.confirm("确定清除已保存的 Overleaf Git Token 吗？清除后，Overleaf 拉取和推送需要重新填写 Token。")) return;
  setBusy(button, true);
  try {
    const next = await api("/api/config/clear-overleaf-token", { method: "POST", body: "{}" });
    state.project.config = { ...state.project.config, ...next };
    const input = document.querySelector("#overleafTokenInput");
    input.value = "";
    input.placeholder = "用于自动拉取和推送";
    button.disabled = true;
    toast("已清除保存的 Overleaf Token。", "success");
  } catch (error) {
    toast(error.message, "error", 5200);
  } finally {
    setBusy(button, false);
  }
}

async function saveSettings({ close = true } = {}) {
  let previous = state.project.config;
  let projectRoot = document.querySelector("#projectRootInput").value.trim();
  const mainTex = document.querySelector("#mainTexInput").value.trim();
  const projectName = document.querySelector("#projectNameInput").value.trim();
  const storageRoot = document.querySelector("#storageRootInput").value.trim();
  const storageChanged = state.storageRootSelected && storageRoot && storageRoot !== previous.storageRoot;
  if ((projectRoot !== previous.projectRoot || mainTex !== previous.mainTex) && state.sourceDirty) {
    if (!confirmDiscardSourceChanges()) return false;
    state.sourceDirty = false;
  }
  if (storageChanged) {
    toast("数据目录不会随“保存设置”自动迁移。请点击“迁移数据目录”按钮执行迁移。", "warning", 6500);
    return false;
  }
  const next = await api("/api/config", {
    method: "POST",
    body: JSON.stringify({
      autoCompile: document.querySelector("#autoCompileInput").checked,
      overleafToken: document.querySelector("#overleafTokenInput").value.trim(),
      gitUsername: document.querySelector("#gitUsernameInput").value.trim(),
      gitToken: document.querySelector("#gitTokenInput").value.trim(),
      translation: collectProvider("translation"),
      format: collectProvider("format")
    })
  });
  if (projectRoot !== previous.projectRoot || mainTex !== previous.mainTex) {
    await api("/api/project/open", {
      method: "POST",
      body: JSON.stringify({ projectRoot, mainTex })
    });
  }
  await api("/api/project/name", {
    method: "POST",
    body: JSON.stringify({ projectRoot, mainTex, name: projectName })
  });
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
  ensureSourceSearchControls();
  elements.undoButton.addEventListener("click", () => void undoLastChange());
  document.querySelector("#compileButton").addEventListener("click", compilePaper);
  elements.previewCompileButton.addEventListener("click", compilePaper);
  elements.gitRemoteSelect.addEventListener("change", changeGitRemoteTarget);
  document.querySelector("#closeGitManagerButton").addEventListener("click", closeGitManager);
  document.querySelector("#addGitRemoteButton").addEventListener("click", () => showGitRemoteForm());
  document.querySelector("#cancelGitRemoteButton").addEventListener("click", hideGitRemoteForm);
  document.querySelector("#testGitRemoteButton").addEventListener("click", testGitRemoteForm);
  elements.gitRemoteProvider.addEventListener("change", () => updateGitRemoteProviderForm({ preserveCredential: false }));
  elements.gitRemoteForm.addEventListener("submit", saveGitRemote);
  document.querySelector("#addGitCredentialButton").addEventListener("click", () => showGitCredentialForm());
  document.querySelector("#cancelGitCredentialButton").addEventListener("click", hideGitCredentialForm);
  elements.gitCredentialProvider.addEventListener("change", updateGitCredentialProviderForm);
  elements.gitCredentialForm.addEventListener("submit", saveGitCredential);
  elements.gitManagerDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeGitManager();
  });
  document.querySelector("#pullButton").addEventListener("click", pullPaper);
  document.querySelector("#pushButton").addEventListener("click", pushPaper);
  document.querySelector("#translateFileButton").addEventListener("click", translateCurrentFile);
  elements.terminologyButton.addEventListener("click", openTerminologyDialog);
  document.querySelector("#closeTerminologyButton").addEventListener("click", closeTerminologyDialog);
  document.querySelector("#cancelTerminologyButton").addEventListener("click", closeTerminologyDialog);
  elements.terminologyDialog.addEventListener("cancel", (event) => {
    if (!state.terminologyDirty) return;
    if (!window.confirm("术语表有未保存修改，确定关闭吗？")) event.preventDefault();
  });
  elements.terminologyDialog.addEventListener("close", () => {
    state.terminologyFile = null;
    state.terminologyEntries = [];
    state.terminologyDirty = false;
  });
  elements.terminologySearch.addEventListener("input", renderTerminologyEntries);
  elements.addTerminologyButton.addEventListener("click", addTerminologyEntry);
  elements.saveTerminologyButton.addEventListener("click", saveTerminology);
  elements.regenerateTerminologyButton.addEventListener("click", regenerateTerminology);
  elements.applyTerminologyDefinitionsButton.addEventListener("click", applyTerminologyDefinitions);
  elements.refreshReferencesButton.addEventListener("click", () => loadReferences({ force: true }));
  elements.addReferenceButton.addEventListener("click", openReferenceAddDialog);
  elements.referenceLookupButton.addEventListener("click", lookupNewReference);
  elements.referenceAddForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.submitter?.id === "referenceLookupButton") void lookupNewReference();
    else void addNewReference();
  });
  elements.referenceAddKey.addEventListener("input", () => {
    const key = elements.referenceAddKey.value.trim();
    if (!key || !elements.referenceAddBib.value.trim()) return;
    elements.referenceAddBib.value = elements.referenceAddBib.value.replace(
      /^(@[A-Za-z]+\s*[({]\s*)[^,\s]+(\s*,)/,
      `$1${key}$2`
    );
  });
  elements.closeReferenceAddButton.addEventListener("click", closeReferenceAddDialog);
  elements.cancelReferenceAddButton.addEventListener("click", closeReferenceAddDialog);
  elements.referenceAddDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeReferenceAddDialog();
  });
  elements.referencesSearch.addEventListener("input", renderReferences);
  elements.insertSelectedReferenceButton.addEventListener("click", () => {
    const entry = selectedReference();
    if (!entry) {
      toast("请先选择一篇文献。", "error");
      return;
    }
    insertCitationAtCurrentTarget(entry);
  });
  elements.closeReferencesButton.addEventListener("click", () => setMode("edit", { loadCurrent: false }));
  elements.referenceInsertSearch.addEventListener("input", renderReferenceInsertList);
  document.querySelector("#closeReferenceInsertButton").addEventListener("click", closeReferenceInsertDialog);
  document.querySelector("#cancelReferenceInsertButton").addEventListener("click", closeReferenceInsertDialog);
  elements.referenceInsertDialog.addEventListener("cancel", () => closeCitationContextMenu());
  elements.referenceInsertForm.addEventListener("submit", (event) => event.preventDefault());
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
    if (await chooseStoragePath(document.querySelector("#storageRootInput"))) {
      state.storageRootSelected = true;
      updateStorageMigrationButton();
    }
  });
  document.querySelector("#migrateStorageButton").addEventListener("click", migrateStorageFromSettings);
  document.querySelector("#storageRootInput").addEventListener("input", () => {
    state.storageRootSelected = true;
    updateStorageMigrationButton();
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
  document.querySelector("#clearOverleafTokenButton").addEventListener("click", clearOverleafToken);
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
  elements.insertFigureSourceButton.addEventListener("click", openSourceFigureDialog);
  elements.figureForm.addEventListener("submit", submitFigureInsertion);
  document.querySelector("#closeFigureButton").addEventListener("click", closeFigureDialog);
  document.querySelector("#cancelFigureButton").addEventListener("click", closeFigureDialog);
  elements.figureDialog.addEventListener("close", () => {
    state.figureAnchor = null;
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
  elements.gitConflictForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const files = [...elements.gitConflictList.querySelectorAll(".git-conflict-row")].map((row) => ({
      file: row.dataset.file,
      choice: row.querySelector('input[type="radio"]:checked')?.value || "local"
    }));
    if (!files.length) {
      toast("没有检测到可处理的冲突文件。", "error");
      finishGitConflictSelection(null);
      return;
    }
    finishGitConflictSelection(files);
  });
  document.querySelector("#closeGitConflictButton").addEventListener("click", () => finishGitConflictSelection(null));
  document.querySelector("#cancelGitConflictButton").addEventListener("click", () => finishGitConflictSelection(null));
  elements.gitConflictDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finishGitConflictSelection(null);
  });
  document.querySelector("#refreshPdfButton").addEventListener("click", () => {
    if (state.previewMode === "fast") void renderFastPreview(state.fastPreviewFile || state.currentDocument?.file || "");
    else void renderPdf();
  });
  elements.exportPdfButton.addEventListener("click", exportPdf);
  document.querySelector("#previousPageButton").addEventListener("click", () => movePdfPage(-1));
  document.querySelector("#nextPageButton").addEventListener("click", () => movePdfPage(1));
  document.querySelector("#zoomOutButton").addEventListener("click", () => setPdfZoom(state.pdfZoom - 10));
  document.querySelector("#zoomInButton").addEventListener("click", () => setPdfZoom(state.pdfZoom + 10));
  elements.pdfZoomValue.addEventListener("click", () => setPdfZoom(100));
  elements.translationSectionSelect.addEventListener("change", (event) => {
    state.currentSectionId = event.currentTarget.value;
    renderFileTranslationProgress(state.currentFile);
  });
  elements.sourceFileSelect.addEventListener("change", async (event) => {
    const previous = state.sourceFile;
    const loaded = await loadSourceFile(event.currentTarget.value);
    if (!loaded) event.currentTarget.value = previous || "";
  });
  elements.sourceEditor.addEventListener("input", () => {
    updateSourceLineNumbers();
    setSourceDirty(elements.sourceEditor.value !== state.sourceSavedContent);
    refreshSourceSearch({ keepIndex: true });
    if (state.sourceFile?.toLowerCase().endsWith(".tex")) scheduleFastPreview(state.sourceFile, 160);
  });
  elements.sourceEditor.addEventListener("scroll", () => {
    elements.sourceLineNumbers.scrollTop = elements.sourceEditor.scrollTop;
  }, { passive: true });
  attachCitationTarget(elements.sourceEditor);
  elements.sourceEditor.addEventListener("click", updateSourceStatus);
  elements.sourceEditor.addEventListener("keyup", updateSourceStatus);
  elements.sourceEditor.addEventListener("select", updateSourceStatus);
  elements.sourceEditor.addEventListener("keydown", (event) => {
    if (event.key === "/" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      toggleSourceLineComments();
      return;
    }
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
  elements.sourceSearchInput.addEventListener("input", () => refreshSourceSearch());
  elements.sourceSearchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      moveSourceSearch(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      elements.sourceEditor.focus();
    }
  });
  elements.sourceSearchPreviousButton.addEventListener("click", () => moveSourceSearch(-1));
  elements.sourceSearchNextButton.addEventListener("click", () => moveSourceSearch(1));
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || state.mode !== "source" || document.querySelector("dialog[open]")) return;
    const key = event.key.toLowerCase();
    if (key === "f" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      focusSourceSearch();
      return;
    }
    if (key === "s" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void saveSourceFile();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.defaultPrevented
      || event.shiftKey
      || !(event.ctrlKey || event.metaKey)
      || event.key.toLowerCase() !== "z"
      || document.querySelector("dialog[open]")
    ) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("textarea, input, select, [contenteditable='true']")) return;
    event.preventDefault();
    if (state.undoCount) void undoLastChange();
  });
  elements.saveSourceButton.addEventListener("click", () => saveSourceFile());
  elements.createTexFileButton.addEventListener("click", createTexFile);
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
  elements.pdfScroll.addEventListener("dblclick", (event) => {
    if (state.previewMode === "fast") void locateFastPreviewSelection(event);
    else void locatePdfSelection(event);
  });
  elements.pdfScroll.addEventListener("scroll", updateVisiblePdfPage, { passive: true });
  window.addEventListener("resize", () => schedulePdfPanelResize());
  document.querySelector("#warningsButton").addEventListener("click", toggleBuildDrawer);
  document.querySelector("#closeWarningsButton").addEventListener("click", closeBuildDrawer);
  document.querySelectorAll(".mode-button").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
  window.addEventListener("beforeunload", (event) => {
    if (
      !state.sourceDirty
      && !state.terminologyDirty
      && !state.saveTimers.size
      && !state.pendingWrites
      && !state.fileTranslationJobs.size
      && !state.segmentTranslationQueue.length
      && !state.activeSegmentTranslations
      && !state.undoCount
    ) return;
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
  document.querySelector("#testFormatButton").addEventListener("click", (event) => testProvider("format", event.currentTarget));
}

async function initialize() {
  bindEvents();
  window.paperBridgeDesktop?.onCloseRequest?.(handleDesktopCloseRequest);
  renderFormatFiles();
  applyEditorPreferences(false);
  applyWorkspaceSplit(false);
  setPdfZoom(state.pdfZoom, { persist: false, preserveViewport: false });
  setPreviewMode("fast");
  refreshIcons();
  try {
    const ready = await refreshProject({ preserveDocument: false });
    updateWarnings([]);
  } catch (error) {
    toast(error.message, "error", 8000);
    elements.segmentList.innerHTML = '<div class="empty-state">无法打开论文项目</div>';
  }
}

initialize();
