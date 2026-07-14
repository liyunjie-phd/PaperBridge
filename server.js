import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import {
  analyzeLatexCommands,
  cleanModelText,
  deleteSegment,
  discoverTexFiles,
  findMissingProtectedTokens,
  insertSegment,
  readDocument,
  replaceSegment
} from "./lib/latex.js";
import { callProvider, parseJsonResponse } from "./lib/providers.js";
import {
  analyzeFormat,
  applyFormat,
  configureFormatRuntime,
  latestFormatJob
} from "./lib/format.js";
import {
  compileProject,
  configureGitLocalExcludes,
  connectGitRepository,
  configureProjectRuntime,
  getDependencyStatus,
  getGitStatus,
  getGitPushPreview,
  getPdfInfo,
  pullProject,
  pushProject
} from "./lib/project.js";
import {
  detectMainTex,
  importGitProject,
  importOverleafProject,
  importZipProject,
  normalizeGitRepositoryUrl,
  openLocalProject
} from "./lib/setup.js";

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));

let runtime = {
  dataRoot: process.env.PAPERBRIDGE_DATA_ROOT || APP_ROOT,
  projectsRoot: process.env.PAPERBRIDGE_PROJECTS_ROOT || path.join(APP_ROOT, "projects"),
  tectonicPath: process.env.PAPERBRIDGE_TECTONIC_PATH || "",
  encryptSecret: null,
  decryptSecret: null
};

const configPath = () => path.join(runtime.dataRoot, "config.local.json");
const stateRoot = () => path.join(runtime.dataRoot, "data");

async function readJsonWithBackup(target, fallback, label) {
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch (primaryError) {
    try {
      return JSON.parse(await fs.readFile(`${target}.bak`, "utf8"));
    } catch (backupError) {
      if (primaryError.code === "ENOENT" && backupError.code === "ENOENT") return structuredClone(fallback);
      throw new Error(`${label}已损坏，且最近备份无法读取：${target}`);
    }
  }
}

async function writeJsonAtomic(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.copyFile(target, `${target}.bak`).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

const defaultProvider = (model) => ({
  type: "openai-compatible",
  baseUrl: "https://api.deepseek.com",
  apiPath: "",
  apiKey: "",
  model,
  jsonMode: true,
  extraHeaders: ""
});

const DEFAULT_CONFIG = {
  projectRoot: "",
  mainTex: "",
  port: 4317,
  pageLimit: 14,
  autoCompile: true,
  overleafToken: "",
  gitUsername: "",
  gitToken: "",
  translation: defaultProvider("deepseek-v4-flash"),
  review: defaultProvider("deepseek-v4-pro")
};

function mergeConfig(base, incoming = {}) {
  return {
    ...base,
    ...incoming,
    translation: { ...base.translation, ...(incoming.translation || {}) },
    review: { ...base.review, ...(incoming.review || {}) }
  };
}

async function loadConfig() {
  const stored = await readJsonWithBackup(configPath(), DEFAULT_CONFIG, "PaperBridge 配置");
  try {
    stored.overleafToken = decodeSecret(stored.overleafToken);
    stored.gitToken = decodeSecret(stored.gitToken);
    if (stored.translation) stored.translation.apiKey = decodeSecret(stored.translation.apiKey);
    if (stored.review) stored.review.apiKey = decodeSecret(stored.review.apiKey);
    return mergeConfig(DEFAULT_CONFIG, stored);
  } catch (error) {
    throw new Error(`PaperBridge 配置无法解密：${error.message}`);
  }
}

let config = structuredClone(DEFAULT_CONFIG);

function encodeSecret(value) {
  if (!value || !runtime.encryptSecret) return value || "";
  const encrypted = runtime.encryptSecret(String(value));
  return encrypted ? `enc:v1:${encrypted}` : String(value);
}

function decodeSecret(value) {
  if (typeof value !== "string" || !value.startsWith("enc:v1:")) return value || "";
  if (!runtime.decryptSecret) return "";
  return runtime.decryptSecret(value.slice(7)) || "";
}

async function saveConfig() {
  const stored = structuredClone(config);
  stored.overleafToken = encodeSecret(stored.overleafToken);
  stored.gitToken = encodeSecret(stored.gitToken);
  stored.translation.apiKey = encodeSecret(stored.translation.apiKey);
  stored.review.apiKey = encodeSecret(stored.review.apiKey);
  await writeJsonAtomic(configPath(), stored);
}

function safeProvider(profile) {
  return { ...profile, apiKey: "", hasApiKey: Boolean(profile.apiKey) };
}

function safeConfig() {
  const { overleafToken, gitToken, ...visible } = config;
  return {
    ...visible,
    hasOverleafToken: Boolean(overleafToken),
    hasGitToken: Boolean(gitToken),
    translation: safeProvider(config.translation),
    review: safeProvider(config.review)
  };
}

function projectStatePath() {
  const key = crypto.createHash("sha1").update(path.resolve(config.projectRoot).toLowerCase()).digest("hex");
  return path.join(stateRoot(), `${key}.json`);
}

const stateQueues = new Map();
const emptyState = () => ({ version: 1, translations: {}, review: null });

async function readStateFromDisk(target = projectStatePath()) {
  return readJsonWithBackup(target, emptyState(), "论文中文工作稿");
}

async function loadState() {
  const target = projectStatePath();
  const pending = stateQueues.get(target);
  if (pending) await pending;
  return readStateFromDisk(target);
}

async function updateState(mutator) {
  const target = projectStatePath();
  const previous = stateQueues.get(target) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const state = await readStateFromDisk(target);
    const result = await mutator(state);
    await writeJsonAtomic(target, state);
    return result;
  });
  stateQueues.set(target, operation);
  operation.finally(() => {
    if (stateQueues.get(target) === operation) stateQueues.delete(target);
  }).catch(() => {});
  return operation;
}

async function hasConfiguredProject() {
  if (!config.projectRoot || !config.mainTex) return false;
  return fs.access(path.join(config.projectRoot, config.mainTex)).then(() => true).catch(() => false);
}

async function getFiles() {
  return discoverTexFiles(config.projectRoot, config.mainTex);
}

async function assertDocumentFile(file) {
  const files = await getFiles();
  if (!files.includes(file)) throw new Error("The selected file is not part of the configured LaTeX project.");
}

function resolveTranslation(state, segment) {
  const exact = state.translations[segment.id];
  if (exact?.sourceHash === segment.sourceHash) {
    return { entry: exact, status: exact.pendingEnglish ? "pending" : "synced" };
  }
  const relocated = Object.values(state.translations).find(
    (entry) => entry.file === segment.file && entry.sourceHash === segment.sourceHash
  );
  if (relocated) return { entry: relocated, status: relocated.pendingEnglish ? "pending" : "synced" };
  if (exact) return { entry: exact, status: "english-changed" };
  return { entry: null, status: "missing" };
}

async function getDocumentPayload(file) {
  await assertDocumentFile(file);
  const document = await readDocument(config.projectRoot, file);
  const state = await loadState();
  return {
    file,
    segments: document.segments.map((segment) => {
      const translation = resolveTranslation(state, segment);
      return {
        ...segment,
        chinese: translation.entry?.chinese || "",
        translationStatus: translation.status,
        updatedAt: translation.entry?.updatedAt || null
      };
    })
  };
}

async function getProjectPayload() {
  const dependencies = await getDependencyStatus();
  if (!await hasConfiguredProject()) {
    return {
      setupRequired: true,
      config: safeConfig(),
      documents: [],
      pdf: { exists: false, pages: 0, size: 0, updatedAt: null },
      git: {
        available: false,
        overleaf: false,
        provider: "none",
        remoteName: "",
        remoteUrl: "",
        branch: "",
        dirty: false,
        changedFiles: [],
        untrackedCount: 0,
        ahead: 0,
        behind: 0
      },
      dependencies
    };
  }
  const files = await getFiles();
  const documents = [];
  for (const file of files) {
    const document = await getDocumentPayload(file);
    if (!document.segments.length) continue;
    documents.push({
      file,
      segments: document.segments.length,
      translated: document.segments.filter((segment) => segment.chinese).length,
      stale: document.segments.filter((segment) => ["english-changed", "pending"].includes(segment.translationStatus)).length
    });
  }
  const [pdf, git] = await Promise.all([
    getPdfInfo(config.projectRoot, config.mainTex),
    getGitStatus(config.projectRoot)
  ]);
  return { setupRequired: false, config: safeConfig(), documents, pdf, git, dependencies };
}

function getSegment(document, index) {
  const segment = document.segments[Number(index)];
  if (!segment) throw new Error("The selected paragraph no longer exists.");
  return segment;
}

async function storeChinese(segment, chinese, nextSourceHash = segment.sourceHash, pendingEnglish = false) {
  await updateState((state) => {
    state.translations[segment.id] = {
      id: segment.id,
      file: segment.file,
      index: segment.index,
      chinese,
      sourceHash: nextSourceHash,
      pendingEnglish,
      englishSnapshot: segment.english,
      updatedAt: new Date().toISOString()
    };
  });
}

async function remapFileTranslations(file, previousDocument, nextDocument, inserted = null) {
  await updateState((state) => {
    const previousByHash = new Map();
    for (const segment of previousDocument.segments) {
      const translation = resolveTranslation(state, segment).entry;
      if (!translation) continue;
      const entries = previousByHash.get(segment.sourceHash) || [];
      entries.push(translation);
      previousByHash.set(segment.sourceHash, entries);
    }

    for (const [id, entry] of Object.entries(state.translations)) {
      if (entry.file === file) delete state.translations[id];
    }

    for (const segment of nextDocument.segments) {
      if (inserted && segment.id === inserted.segment.id) {
        state.translations[segment.id] = {
          id: segment.id,
          file,
          index: segment.index,
          chinese: inserted.chinese,
          sourceHash: segment.sourceHash,
          pendingEnglish: false,
          englishSnapshot: segment.english,
          updatedAt: new Date().toISOString()
        };
        continue;
      }
      const previous = previousByHash.get(segment.sourceHash)?.shift();
      if (!previous) continue;
      state.translations[segment.id] = {
        ...previous,
        id: segment.id,
        file,
        index: segment.index
      };
    }

    state.review = null;
  });
}

async function maybeCompile() {
  if (!config.autoCompile) {
    return { success: true, skipped: true, pdf: await getPdfInfo(config.projectRoot, config.mainTex), warnings: [], log: "" };
  }
  return compileAndTrackLayout();
}

async function compileAndTrackLayout() {
  const build = await compileProject(config.projectRoot, config.mainTex);
  if (!build.success) return { ...build, layoutChanges: [] };
  const changes = await updateState((state) => {
    const previous = new Map((state.layoutSnapshot || []).map((item) => [item.label, item]));
    const current = new Map((build.floatLayout || []).map((item) => [item.label, item]));
    const nextChanges = [];
    for (const item of build.floatLayout || []) {
      const before = previous.get(item.label);
      if (before && before.page !== item.page) {
        nextChanges.push({ kind: "moved", label: item.label, type: item.type, from: before.page, to: item.page });
      } else if (state.layoutSnapshot && !before) {
        nextChanges.push({ kind: "added", label: item.label, type: item.type, to: item.page });
      }
    }
    for (const item of state.layoutSnapshot || []) {
      if (!current.has(item.label)) nextChanges.push({ kind: "removed", label: item.label, type: item.type, from: item.page });
    }
    state.layoutSnapshot = build.floatLayout || [];
    return nextChanges;
  });
  return { ...build, layoutChanges: changes };
}

const pendingAiApprovals = new Map();

function approvalKey(parts) {
  return crypto.createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

function pruneAiApprovals() {
  const now = Date.now();
  for (const [token, entry] of pendingAiApprovals) {
    if (entry.expiresAt <= now) pendingAiApprovals.delete(token);
  }
  while (pendingAiApprovals.size > 40) pendingAiApprovals.delete(pendingAiApprovals.keys().next().value);
}

function consumeAiApproval(token, key) {
  pruneAiApprovals();
  const entry = pendingAiApprovals.get(String(token || ""));
  if (!entry || entry.key !== key) {
    const error = new Error("LaTeX 命令确认已失效，请重新生成英文。");
    error.code = "LATEX_APPROVAL_EXPIRED";
    throw error;
  }
  pendingAiApprovals.delete(String(token));
  return entry.output;
}

function inspectAiLatexOutput(references, output, key) {
  const analysis = analyzeLatexCommands(references, output);
  if (analysis.dangerousCommands.length) {
    const error = new Error("AI 输出包含危险 LaTeX 命令，PaperBridge 已阻止写入。");
    error.status = 422;
    error.code = "DANGEROUS_LATEX_COMMANDS";
    error.details = analysis;
    throw error;
  }
  if (analysis.unexpectedCommands.length) {
    pruneAiApprovals();
    const token = crypto.randomUUID();
    pendingAiApprovals.set(token, { key, output, expiresAt: Date.now() + 10 * 60_000 });
    const error = new Error("AI 输出新增了原文中没有的 LaTeX 命令，需要确认后才能写入。");
    error.status = 409;
    error.code = "UNEXPECTED_LATEX_COMMANDS";
    error.details = { ...analysis, approvalToken: token };
    throw error;
  }
  return output;
}

function translationPrompt(segment, chinese, previous, next) {
  return {
    system: [
      "You are an academic paper translator and LaTeX editor.",
      "Translate Chinese revisions into concise, publication-ready academic English.",
      "The current English is a style and terminology reference, not a source that must be copied.",
      "Preserve every LaTeX command, citation, reference, inline formula, symbol, number, and factual claim.",
      "Do not add evidence, results, citations, or claims. Do not output Markdown fences or commentary.",
      "Return only the complete replacement LaTeX paragraph."
    ].join(" "),
    user: [
      `Previous paragraph:\n${previous || "(none)"}`,
      `Current English paragraph:\n${segment.english}`,
      `Chinese revision:\n${chinese}`,
      `Next paragraph:\n${next || "(none)"}`
    ].join("\n\n")
  };
}

function newParagraphPrompt(chinese, previous, next) {
  return {
    system: [
      "You are an academic paper translator and LaTeX editor.",
      "Translate the new Chinese paragraph into one concise, publication-ready academic English paragraph.",
      "Use neighboring paragraphs only for terminology, tense, and style consistency.",
      "Preserve every LaTeX command, citation, reference, inline formula, symbol, number, and factual claim in the Chinese text.",
      "Do not add evidence, results, citations, headings, list markers, or claims.",
      "Do not output Markdown fences or commentary. Return only one complete LaTeX body paragraph."
    ].join(" "),
    user: [
      `Previous English paragraph:\n${previous || "(none)"}`,
      `New Chinese paragraph:\n${chinese}`,
      `Next English paragraph:\n${next || "(none)"}`
    ].join("\n\n")
  };
}

async function translateParagraph(file, index, sourceHash, chinese, approvalToken = "") {
  const document = await getDocumentPayload(file);
  const segment = getSegment(document, index);
  if (sourceHash && sourceHash !== segment.sourceHash) {
    const error = new Error("The paragraph changed after it was loaded. Reload before translating.");
    error.code = "SOURCE_CHANGED";
    throw error;
  }
  const key = approvalKey(["translate", file, segment.index, segment.sourceHash, chinese]);
  let nextEnglish;
  if (approvalToken) {
    nextEnglish = consumeAiApproval(approvalToken, key);
  } else {
    const prompt = translationPrompt(
      segment,
      chinese,
      document.segments[segment.index - 1]?.english,
      document.segments[segment.index + 1]?.english
    );
    const raw = await callProvider(config.translation, { ...prompt, temperature: 0.15, maxTokens: 4096 });
    nextEnglish = inspectAiLatexOutput(
      [segment.english, chinese],
      cleanModelText(raw),
      key
    );
  }
  const missingTokens = findMissingProtectedTokens(segment.english, chinese, nextEnglish);
  if (missingTokens.length) {
    const error = new Error("The AI response removed protected LaTeX tokens.");
    error.code = "LATEX_TOKEN_LOSS";
    error.details = { missingTokens };
    throw error;
  }
  const updated = await replaceSegment(config.projectRoot, file, segment.index, segment.sourceHash, nextEnglish);
  const nextSegment = updated.segments[segment.index];
  await storeChinese({ ...nextSegment, file }, chinese, nextSegment.sourceHash, false);
  return { document: await getDocumentPayload(file), build: await maybeCompile() };
}

async function addParagraph(file, index, sourceHash, chinese, position, approvalToken = "") {
  const document = await getDocumentPayload(file);
  const anchor = getSegment(document, index);
  if (sourceHash && sourceHash !== anchor.sourceHash) {
    const error = new Error("The paragraph changed after it was loaded. Reload before adding a paragraph.");
    error.code = "SOURCE_CHANGED";
    throw error;
  }
  const preparedChinese = String(chinese || "").trim();
  if (!preparedChinese) throw new Error("Please enter the Chinese text for the new paragraph.");
  const normalizedPosition = position === "before" ? "before" : "after";
  const neighborIndex = normalizedPosition === "before" ? anchor.index - 1 : anchor.index + 1;
  const key = approvalKey(["add", file, anchor.index, anchor.sourceHash, preparedChinese, normalizedPosition]);
  let nextEnglish;
  if (approvalToken) {
    nextEnglish = consumeAiApproval(approvalToken, key);
  } else {
    const prompt = newParagraphPrompt(
      preparedChinese,
      normalizedPosition === "before" ? document.segments[neighborIndex]?.english : anchor.english,
      normalizedPosition === "before" ? anchor.english : document.segments[neighborIndex]?.english
    );
    const raw = await callProvider(config.translation, { ...prompt, temperature: 0.15, maxTokens: 4096 });
    nextEnglish = inspectAiLatexOutput([preparedChinese], cleanModelText(raw), key);
  }
  const missingTokens = findMissingProtectedTokens("", preparedChinese, nextEnglish);
  if (missingTokens.length) {
    const error = new Error("The AI response removed protected LaTeX tokens.");
    error.code = "LATEX_TOKEN_LOSS";
    error.details = { missingTokens };
    throw error;
  }

  const inserted = await insertSegment(
    config.projectRoot,
    file,
    anchor.index,
    anchor.sourceHash,
    nextEnglish,
    normalizedPosition
  );
  await remapFileTranslations(file, document, inserted.document, {
    segment: inserted.segment,
    chinese: preparedChinese
  });
  return { document: await getDocumentPayload(file), build: await maybeCompile() };
}

async function removeParagraph(file, index, sourceHash) {
  const document = await getDocumentPayload(file);
  const segment = getSegment(document, index);
  if (document.segments.length <= 1) {
    const error = new Error("At least one editable body paragraph must remain in this file.");
    error.code = "LAST_PARAGRAPH";
    throw error;
  }
  const removed = await deleteSegment(config.projectRoot, file, segment.index, sourceHash || segment.sourceHash);
  await remapFileTranslations(file, document, removed.document);
  return { document: await getDocumentPayload(file), build: await maybeCompile() };
}

async function translateFileToChinese(file) {
  const document = await getDocumentPayload(file);
  const pending = document.segments.filter((segment) => !segment.chinese || segment.translationStatus !== "synced");
  for (let offset = 0; offset < pending.length; offset += 8) {
    const chunk = pending.slice(offset, offset + 8);
    const input = chunk.map((segment) => ({ id: segment.id, english: segment.english }));
    const raw = await callProvider(config.translation, {
      system: [
        "You translate academic LaTeX prose from English to clear Chinese for author-side editing.",
        "Preserve LaTeX commands, citations, references, formulas, numbers, and terminology exactly.",
        "Return JSON only."
      ].join(" "),
      user: `Return {"translations":[{"id":"...","chinese":"..."}]}. Translate every item in this JSON array:\n${JSON.stringify(input)}`,
      json: true,
      temperature: 0.15,
      maxTokens: 8192
    });
    const parsed = parseJsonResponse(raw);
    await updateState((state) => {
      for (const item of parsed.translations || []) {
        const segment = chunk.find((candidate) => candidate.id === item.id);
        if (!segment || typeof item.chinese !== "string") continue;
        const missingTokens = findMissingProtectedTokens(segment.english, "", item.chinese);
        if (missingTokens.length) continue;
        state.translations[segment.id] = {
          id: segment.id,
          file: segment.file,
          index: segment.index,
          chinese: item.chinese.trim(),
          sourceHash: segment.sourceHash,
          pendingEnglish: false,
          englishSnapshot: segment.english,
          updatedAt: new Date().toISOString()
        };
      }
    });
  }
  return getDocumentPayload(file);
}

async function reviewPaper() {
  const files = await getFiles();
  const paragraphs = [];
  for (const file of files) {
    const document = await getDocumentPayload(file);
    for (const segment of document.segments) {
      paragraphs.push({ id: segment.id, file, index: segment.index, english: segment.english });
    }
  }
  const raw = await callProvider(config.review, {
    system: [
      "You are a meticulous senior academic editor reviewing a complete systems research paper.",
      "Check grammar, terminology consistency, paragraph transitions, argument continuity, unsupported wording, and cross-section coherence.",
      "Do not invent experiments, citations, facts, or results. Preserve LaTeX syntax in every revision.",
      "Report only actionable issues and return JSON only."
    ].join(" "),
    user: [
      "Return this JSON shape:",
      '{"summary":"...","issues":[{"id":"file:index","severity":"high|medium|low","category":"grammar|clarity|coherence|terminology|claim","message":"...","revisedEnglish":"complete replacement paragraph"}]}',
      "Each revisedEnglish value must be a complete replacement for the matching paragraph and retain all LaTeX tokens.",
      `Paper paragraphs:\n${JSON.stringify(paragraphs)}`
    ].join("\n\n"),
    json: true,
    temperature: 0.1,
    maxTokens: 16_000
  });
  const parsed = parseJsonResponse(raw);
  const validIds = new Set(paragraphs.map((item) => item.id));
  const issues = (parsed.issues || []).filter((issue) => validIds.has(issue.id) && issue.revisedEnglish);
  const review = {
    summary: parsed.summary || "",
    issues: issues.map((issue, index) => ({ ...issue, issueId: `issue-${index + 1}`, status: "open" })),
    createdAt: new Date().toISOString()
  };
  await updateState((state) => {
    state.review = review;
  });
  return review;
}

async function applyReviewIssue(issueId, approveCommands = false) {
  const state = await loadState();
  const issue = state.review?.issues?.find((item) => item.issueId === issueId);
  if (!issue) throw new Error("Review issue not found.");
  const [file, indexText] = issue.id.match(/^(.*):(\d+)$/)?.slice(1) || [];
  if (!file) throw new Error("Review issue has an invalid paragraph id.");
  const document = await getDocumentPayload(file);
  const segment = getSegment(document, Number(indexText));
  const nextEnglish = cleanModelText(issue.revisedEnglish);
  const commandAnalysis = analyzeLatexCommands([segment.english, segment.chinese], nextEnglish);
  if (commandAnalysis.dangerousCommands.length) {
    const error = new Error("审校建议包含危险 LaTeX 命令，PaperBridge 已阻止写入。");
    error.status = 422;
    error.code = "DANGEROUS_LATEX_COMMANDS";
    error.details = commandAnalysis;
    throw error;
  }
  if (commandAnalysis.unexpectedCommands.length && !approveCommands) {
    const error = new Error("审校建议新增了原文中没有的 LaTeX 命令，需要确认后才能写入。");
    error.status = 409;
    error.code = "UNEXPECTED_LATEX_COMMANDS";
    error.details = commandAnalysis;
    throw error;
  }
  const missingTokens = findMissingProtectedTokens(segment.english, segment.chinese, nextEnglish);
  if (missingTokens.length) {
    const error = new Error("The suggested revision removes protected LaTeX tokens.");
    error.code = "LATEX_TOKEN_LOSS";
    error.details = { missingTokens };
    throw error;
  }
  const updated = await replaceSegment(config.projectRoot, file, segment.index, segment.sourceHash, nextEnglish);
  const nextSegment = updated.segments[segment.index];
  const review = await updateState((latestState) => {
    const latestIssue = latestState.review?.issues?.find((item) => item.issueId === issueId);
    if (!latestIssue) throw new Error("Review issue no longer exists.");
    latestIssue.status = "applied";
    latestIssue.appliedAt = new Date().toISOString();
    return latestState.review;
  });
  return { review, document: await getDocumentPayload(file), build: await maybeCompile() };
}

const app = express();
app.use(express.json({ limit: "12mb" }));
app.use("/vendor/lucide", express.static(path.join(APP_ROOT, "node_modules", "lucide", "dist", "umd")));
app.use("/vendor/pdfjs", express.static(path.join(APP_ROOT, "node_modules", "pdfjs-dist", "build")));
app.get("/favicon.ico", (_req, res) => res.status(204).end());
app.use(express.static(path.join(APP_ROOT, "public")));

const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

app.get("/api/bootstrap", route(async (_req, res) => res.json(await getProjectPayload())));

app.post("/api/setup", route(async (req, res) => {
  const incoming = req.body || {};
  const source = incoming.source || {};
  const preserveProviders = incoming.preserveProviders === true;
  const translation = preserveProviders
    ? config.translation
    : {
        ...defaultProvider(""),
        ...(incoming.translation || {}),
        apiKey: incoming.translation?.apiKey || config.translation.apiKey
      };
  const review = preserveProviders
    ? config.review
    : {
        ...translation,
        ...(incoming.review || {}),
        apiKey: incoming.review?.apiKey || translation.apiKey || config.review.apiKey
      };
  if (!translation.model || !translation.apiKey) throw new Error("请填写翻译模型和 API Key。");
  if (!review.model || !review.apiKey) throw new Error("请填写审校模型和 API Key。");

  let project;
  const overleafToken = String(source.token || config.overleafToken || "").trim();
  const gitUsername = String(source.gitUsername || config.gitUsername || "").trim();
  const gitToken = String(source.gitToken || config.gitToken || "").trim();
  if (source.mode === "overleaf") {
    project = await importOverleafProject(source.projectUrl, overleafToken, runtime.projectsRoot);
  } else if (source.mode === "git") {
    project = await importGitProject(source.gitUrl, gitUsername, gitToken, runtime.projectsRoot);
  } else if (source.mode === "zip") {
    project = await importZipProject(source.zipPath, runtime.projectsRoot);
  } else if (source.mode === "local") {
    project = await openLocalProject(source.localPath);
  } else {
    throw new Error("请选择论文来源。");
  }
  if (["zip", "local"].includes(source.mode) && source.connectGit === true) {
    const gitUrl = normalizeGitRepositoryUrl(source.gitUrl);
    await connectGitRepository(project.projectRoot, gitUrl, gitUsername, gitToken);
    project.gitUrl = gitUrl;
  }
  if (source.mode === "git" || source.connectGit === true) {
    await configureGitLocalExcludes(project.projectRoot, project.mainTex);
  }

  config = {
    ...config,
    projectRoot: project.projectRoot,
    mainTex: String(incoming.mainTex || project.mainTex),
    pageLimit: Math.max(1, Number(incoming.pageLimit || 14)),
    autoCompile: incoming.autoCompile !== false,
    overleafToken: source.mode === "overleaf" ? overleafToken : config.overleafToken,
    gitUsername: source.mode === "git" || source.connectGit === true ? gitUsername : config.gitUsername,
    gitToken: source.mode === "git" || source.connectGit === true ? gitToken : config.gitToken,
    translation,
    review
  };
  await saveConfig();
  res.json(await getProjectPayload());
}));

app.post("/api/provider/test-inline", route(async (req, res) => {
  const content = await callProvider(req.body.profile || {}, {
    system: "Reply with exactly OK.",
    user: "Connection test",
    temperature: 0,
    maxTokens: 16
  });
  res.json({ ok: /^\s*OK\s*[.!]?\s*$/i.test(content), response: cleanModelText(content) });
}));

app.get("/api/format/latest", route(async (_req, res) => {
  res.json(await latestFormatJob(config.projectRoot, config.mainTex));
}));

app.post("/api/format/analyze", route(async (req, res) => {
  if (!await hasConfiguredProject()) throw new Error("请先连接论文项目。");
  res.json(await analyzeFormat({
    provider: config.review,
    projectRoot: config.projectRoot,
    mainTex: config.mainTex,
    requirements: String(req.body.requirements || ""),
    filePaths: Array.isArray(req.body.filePaths) ? req.body.filePaths : []
  }));
}));

app.post("/api/format/apply", route(async (req, res) => {
  if (!await hasConfiguredProject()) throw new Error("请先连接论文项目。");
  res.json(await applyFormat({
    provider: config.review,
    projectRoot: config.projectRoot,
    mainTex: config.mainTex,
    jobId: String(req.body.jobId || ""),
    approvalToken: String(req.body.approvalToken || "")
  }));
}));

app.get("/api/document", route(async (req, res) => {
  res.json(await getDocumentPayload(String(req.query.file || "")));
}));

app.post("/api/project/open", route(async (req, res) => {
  const requestedRoot = String(req.body.projectRoot || "").trim();
  if (!requestedRoot) throw new Error("Project folder is required.");
  const projectRoot = path.resolve(requestedRoot);
  const mainTex = String(req.body.mainTex || "").trim() || await detectMainTex(projectRoot);
  await fs.access(path.join(projectRoot, mainTex));
  config = { ...config, projectRoot, mainTex };
  const git = await getGitStatus(projectRoot);
  if (git.provider === "git") await configureGitLocalExcludes(projectRoot, mainTex);
  await getFiles();
  await saveConfig();
  res.json(await getProjectPayload());
}));

app.get("/api/config", (_req, res) => res.json(safeConfig()));

app.post("/api/config", route(async (req, res) => {
  const incoming = req.body || {};
  const mergeProvider = (current, next = {}) => ({
    ...current,
    ...next,
    apiKey: next.apiKey ? String(next.apiKey).trim() : current.apiKey
  });
  config = {
    ...config,
    pageLimit: Math.max(1, Number(incoming.pageLimit || config.pageLimit)),
    autoCompile: incoming.autoCompile !== false,
    overleafToken: incoming.overleafToken ? String(incoming.overleafToken).trim() : config.overleafToken,
    gitUsername: incoming.gitUsername === undefined ? config.gitUsername : String(incoming.gitUsername || "").trim(),
    gitToken: incoming.gitToken ? String(incoming.gitToken).trim() : config.gitToken,
    translation: mergeProvider(config.translation, incoming.translation),
    review: mergeProvider(config.review, incoming.review)
  };
  await saveConfig();
  res.json(safeConfig());
}));

app.post("/api/provider/test", route(async (req, res) => {
  const profile = req.body.purpose === "review" ? config.review : config.translation;
  const content = await callProvider(profile, {
    system: "Reply with exactly OK.",
    user: "Connection test",
    temperature: 0,
    maxTokens: 16
  });
  res.json({ ok: /^\s*OK\s*[.!]?\s*$/i.test(content), response: cleanModelText(content) });
}));

app.post("/api/segment/chinese", route(async (req, res) => {
  const document = await getDocumentPayload(req.body.file);
  const segment = getSegment(document, req.body.index);
  await storeChinese(segment, String(req.body.chinese || ""), segment.sourceHash, true);
  res.json({ saved: true });
}));

app.post("/api/segment/translate", route(async (req, res) => {
  res.json(await translateParagraph(
    req.body.file,
    req.body.index,
    req.body.sourceHash,
    String(req.body.chinese || ""),
    String(req.body.approvalToken || "")
  ));
}));

app.post("/api/segment/add", route(async (req, res) => {
  res.json(await addParagraph(
    req.body.file,
    req.body.index,
    req.body.sourceHash,
    String(req.body.chinese || ""),
    req.body.position,
    String(req.body.approvalToken || "")
  ));
}));

app.post("/api/segment/delete", route(async (req, res) => {
  res.json(await removeParagraph(req.body.file, req.body.index, req.body.sourceHash));
}));

app.post("/api/segment/english", route(async (req, res) => {
  const document = await getDocumentPayload(req.body.file);
  const segment = getSegment(document, req.body.index);
  const nextEnglish = String(req.body.english || "").trim();
  const missingTokens = findMissingProtectedTokens(segment.english, segment.chinese, nextEnglish);
  if (missingTokens.length && !req.body.force) {
    const error = new Error("The edit removes protected LaTeX tokens.");
    error.status = 409;
    error.code = "LATEX_TOKEN_LOSS";
    error.details = { missingTokens };
    throw error;
  }
  const updated = await replaceSegment(config.projectRoot, req.body.file, segment.index, req.body.sourceHash, nextEnglish);
  const nextSegment = updated.segments[segment.index];
  if (req.body.chinese) {
    await storeChinese({ ...nextSegment, file: req.body.file }, req.body.chinese, nextSegment.sourceHash, false);
  }
  res.json({ document: await getDocumentPayload(req.body.file), build: await maybeCompile() });
}));

app.post("/api/file/translate-to-chinese", route(async (req, res) => {
  res.json(await translateFileToChinese(req.body.file));
}));

app.post("/api/compile", route(async (_req, res) => {
  res.json(await compileAndTrackLayout());
}));

app.post("/api/git/pull", route(async (_req, res) => {
  res.json({ git: await pullProject(config.projectRoot), project: await getProjectPayload() });
}));

app.get("/api/git/push-preview", route(async (_req, res) => {
  res.json(await getGitPushPreview(config.projectRoot));
}));

app.post("/api/git/push", route(async (req, res) => {
  const build = await compileAndTrackLayout();
  if (!build.success) {
    const error = new Error("Compilation failed. The paper was not pushed.");
    error.status = 409;
    error.details = build;
    throw error;
  }
  const result = await pushProject(config.projectRoot, String(req.body.message || ""), {
    confirmed: req.body.confirmed === true,
    files: Array.isArray(req.body.files) ? req.body.files : []
  });
  res.json({ ...result, build });
}));

app.post("/api/review", route(async (_req, res) => res.json(await reviewPaper())));

app.get("/api/review", route(async (_req, res) => {
  const state = await loadState();
  res.json(state.review || { summary: "", issues: [], createdAt: null });
}));

app.post("/api/review/apply", route(async (req, res) => {
  res.json(await applyReviewIssue(String(req.body.issueId || ""), req.body.approveCommands === true));
}));

app.get("/api/pdf", route(async (_req, res) => {
  const pdf = await getPdfInfo(config.projectRoot, config.mainTex);
  if (!pdf.exists) return res.status(404).send("PDF not found");
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(pdf.path);
}));

app.use((error, _req, res, _next) => {
  const status = error.status || (error.code === "SOURCE_CHANGED" ? 409 : 400);
  res.status(status).json({
    error: error.message || "Request failed",
    code: error.code || "REQUEST_FAILED",
    details: error.details || null
  });
});

let activeServer = null;

async function createAskPassScript() {
  const askPassPath = path.join(runtime.dataRoot, "git-askpass.cmd");
  const script = [
    "@echo off",
    "echo %~1| findstr /I \"username\" >nul",
    "if %errorlevel%==0 (echo %PAPERBRIDGE_GIT_USERNAME%) else (echo %PAPERBRIDGE_GIT_TOKEN%)"
  ].join("\r\n");
  await fs.mkdir(runtime.dataRoot, { recursive: true });
  await fs.writeFile(askPassPath, `${script}\r\n`, "utf8");
  return askPassPath;
}

export async function startServer(options = {}) {
  if (activeServer) {
    const address = activeServer.address();
    return { server: activeServer, port: address.port, url: `http://127.0.0.1:${address.port}` };
  }
  runtime = {
    ...runtime,
    ...options,
    dataRoot: options.dataRoot || runtime.dataRoot,
    projectsRoot: options.projectsRoot || runtime.projectsRoot,
    tectonicPath: options.tectonicPath || runtime.tectonicPath
  };
  await fs.mkdir(runtime.dataRoot, { recursive: true });
  await fs.mkdir(runtime.projectsRoot, { recursive: true });
  config = await loadConfig();
  const askPassPath = await createAskPassScript();
  configureProjectRuntime({
    askPassPath,
    getOverleafToken: () => config.overleafToken || "",
    getGitToken: () => config.gitToken || "",
    getGitUsername: () => config.gitUsername || "",
    tectonicPath: runtime.tectonicPath
  });
  configureFormatRuntime({ dataRoot: runtime.dataRoot });

  const port = Number.isFinite(Number(options.port)) ? Number(options.port) : Number(config.port || 4317);
  activeServer = await new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1", () => resolve(server));
    server.once("error", reject);
  });
  const address = activeServer.address();
  const url = `http://127.0.0.1:${address.port}`;
  console.log(`PaperBridge running at ${url}`);
  console.log(`Paper project: ${config.projectRoot || "not configured"}`);
  return { server: activeServer, port: address.port, url };
}

export async function stopServer() {
  if (!activeServer) return;
  const server = activeServer;
  activeServer = null;
  await new Promise((resolve) => server.close(resolve));
}

const executedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (executedDirectly) {
  startServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
