import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import extract from "extract-zip";
import WordExtractor from "word-extractor";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  analyzeLatexCommands,
  discoverBibliographyFiles,
  discoverTexFiles,
  parseSegments,
  resolveProjectFile
} from "./latex.js";
import { callProvider, parseJsonResponse } from "./providers.js";
import { compileProject } from "./project.js";

const allowedUploads = new Set([".doc", ".docx", ".pdf", ".tex", ".zip"]);
const readableText = new Set([".tex", ".cls", ".sty", ".bst", ".bbx", ".cbx", ".lbx", ".bib", ".txt", ".md", ".cfg", ".def"]);
const templateAssets = new Set([".cls", ".sty", ".bst", ".bbx", ".cbx", ".lbx", ".cfg", ".def", ".ttf", ".otf", ".png", ".jpg", ".jpeg", ".pdf", ".eps"]);
const skippedDirectories = new Set([".git", "node_modules", "build", "out", "dist"]);
const formatCommandLine = /^\s*\\(?:documentclass|usepackage|RequirePackage|PassOptionsToPackage|geometry|setlength|addtolength|title|author|affiliation|institution|email|date|maketitle|keywords|bibliographystyle|bibliography|addbibresource|printbibliography|pagestyle|thispagestyle|section|subsection|subsubsection|appendix|begin\{(?:abstract|figure\*?|table\*?|document)\}|end\{(?:abstract|figure\*?|table\*?|document)\}|includegraphics|caption|newcommand|renewcommand|providecommand|newenvironment|renewenvironment|Declare\w*|def|edef|gdef|let)\b/;

let runtime = { dataRoot: process.cwd(), callProvider };
const pendingFormatApprovals = new Map();
const formatApplyQueues = new Map();

export function configureFormatRuntime(next = {}) {
  runtime = { ...runtime, ...next };
}

const jobsRoot = () => path.join(runtime.dataRoot, "format-jobs");
const formatBackupsRoot = () => path.join(runtime.dataRoot, "format-backups");

async function writeFileAtomic(target, content) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    if (typeof content === "string") await fs.writeFile(temporary, content, "utf8");
    else await fs.writeFile(temporary, content);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function writeProjectSourceAtomic(projectRoot, file, content) {
  await writeFileAtomic(await resolveProjectFile(projectRoot, file), content);
}

function queueFormatApply(projectRoot, callback) {
  const key = path.resolve(projectRoot).toLowerCase();
  const previous = formatApplyQueues.get(key) || Promise.resolve();
  const operation = previous.catch(() => {}).then(callback);
  formatApplyQueues.set(key, operation);
  operation.finally(() => {
    if (formatApplyQueues.get(key) === operation) formatApplyQueues.delete(key);
  }).catch(() => {});
  return operation;
}

function jobRoot(jobId) {
  if (!/^[a-f0-9-]+$/i.test(String(jobId || ""))) throw new Error("无效的格式任务编号。");
  return path.join(jobsRoot(), jobId);
}

async function writeJob(job) {
  job.updatedAt = new Date().toISOString();
  await fs.mkdir(jobRoot(job.id), { recursive: true });
  await writeFileAtomic(path.join(jobRoot(job.id), "job.json"), `${JSON.stringify(job, null, 2)}\n`);
}

async function readJob(jobId) {
  return JSON.parse(await fs.readFile(path.join(jobRoot(jobId), "job.json"), "utf8"));
}

function publicJob(job) {
  return {
    id: job.id,
    requirements: job.requirements,
    sourceFiles: job.sourceFiles,
    analysis: job.analysis || null,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    build: job.build || null,
    execution: job.execution || null,
    workflow: job.workflow || null
  };
}

async function removeJobDirectory(target) {
  const root = path.resolve(jobsRoot());
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("拒绝清理格式任务目录之外的路径。");
  await fs.rm(resolved, { recursive: true, force: true });
}

async function collectFiles(root, directory = root, files = []) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) await collectFiles(root, absolute, files);
    } else if (entry.isFile()) {
      files.push({ absolute, relative: path.relative(root, absolute).replaceAll("\\", "/") });
    }
  }
  return files;
}

async function extractPdfText(file) {
  const loadingTask = getDocument({ data: new Uint8Array(await fs.readFile(file)), disableWorker: true });
  try {
    const pdf = await loadingTask.promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(`[Page ${pageNumber}]\n${content.items.map((item) => item.str || "").join(" ")}`);
    }
    return pages.join("\n\n");
  } finally {
    await loadingTask.destroy();
  }
}

async function extractWordText(file) {
  const extractor = new WordExtractor();
  const document = await extractor.extract(file);
  return [document.getBody(), document.getHeaders?.(), document.getFooters?.(), document.getTextboxes?.()]
    .filter(Boolean)
    .join("\n\n");
}

async function extractMaterialText(file) {
  const extension = path.extname(file).toLowerCase();
  if (readableText.has(extension)) return fs.readFile(file, "utf8");
  if (extension === ".pdf") return extractPdfText(file);
  if (extension === ".doc" || extension === ".docx") return extractWordText(file);
  return "";
}

async function prepareFormatJob(filePaths, requirements) {
  const id = crypto.randomUUID();
  const root = jobRoot(id);
  const uploads = path.join(root, "uploads");
  const extracts = path.join(root, "extracts");
  await fs.mkdir(uploads, { recursive: true });
  await fs.mkdir(extracts, { recursive: true });
  const job = {
    id,
    requirements: String(requirements || "").trim(),
    sourceFiles: [],
    extracts: [],
    assetRoots: [],
    status: "preparing",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  try {
    for (const [index, input] of [...new Set(filePaths || [])].entries()) {
      const source = path.resolve(String(input || ""));
      const extension = path.extname(source).toLowerCase();
      if (!allowedUploads.has(extension)) throw new Error(`不支持的格式文件：${path.basename(source)}`);
      const stat = await fs.stat(source);
      if (!stat.isFile()) throw new Error(`格式材料不是文件：${path.basename(source)}`);
      if (stat.size > 80 * 1024 * 1024) throw new Error(`格式材料超过 80 MB：${path.basename(source)}`);
      const copied = path.join(uploads, `${index + 1}-${path.basename(source)}`);
      await fs.copyFile(source, copied);
      job.sourceFiles.push({ name: path.basename(source), type: extension.slice(1).toUpperCase(), size: stat.size });

      let candidates = [{ absolute: copied, relative: path.basename(copied) }];
      if (extension === ".zip") {
        const destination = path.join(root, "materials", `zip-${index + 1}`);
        await fs.mkdir(destination, { recursive: true });
        await extract(copied, { dir: destination });
        job.assetRoots.push(path.relative(root, destination).replaceAll("\\", "/"));
        candidates = await collectFiles(destination);
      }

      for (const candidate of candidates.slice(0, 120)) {
        const candidateExtension = path.extname(candidate.absolute).toLowerCase();
        if (!readableText.has(candidateExtension) && ![".pdf", ".doc", ".docx"].includes(candidateExtension)) continue;
        const text = (await extractMaterialText(candidate.absolute)).slice(0, 240_000);
        if (!text.trim()) continue;
        const extractName = `${String(job.extracts.length + 1).padStart(3, "0")}.txt`;
        await fs.writeFile(path.join(extracts, extractName), text, "utf8");
        job.extracts.push({
          name: candidate.relative,
          type: candidateExtension.slice(1).toUpperCase(),
          file: `extracts/${extractName}`,
          characters: text.length
        });
      }
    }
    if (!job.requirements && !job.extracts.length) throw new Error("请描述目标格式，或至少上传一个格式文件。");
    job.status = "prepared";
    await writeJob(job);
    return job;
  } catch (error) {
    await removeJobDirectory(root);
    throw error;
  }
}

async function readProjectSources(projectRoot, mainTex) {
  const files = await discoverTexFiles(projectRoot, mainTex);
  return Promise.all(files.map(async (file) => ({
    file,
    content: await fs.readFile(await resolveProjectFile(projectRoot, file), "utf8")
  })));
}

export function buildFormatWorkflow(sources, mainTex, bibliographyFiles = []) {
  const globalFile = sources.some((source) => source.file === mainTex) ? mainTex : sources[0]?.file || mainTex;
  const localFiles = [];
  const supportFiles = [];
  for (const source of sources) {
    if (source.file === globalFile) continue;
    const document = parseSegments(source.content, source.file);
    if (document.segments.length || /\\(?:section|subsection|subsubsection)\*?\s*\{/.test(source.content)) {
      localFiles.push(source.file);
    } else {
      supportFiles.push(source.file);
    }
  }
  const stages = [{
    id: "global",
    scope: "global",
    label: "整体格式",
    files: [globalFile, ...supportFiles],
    responsibilities: ["单双栏", "字体与字号", "页边距", "宏包", "标题区", "Bib 调用"]
  }];
  for (const [index, file] of localFiles.entries()) {
    stages.push({
      id: `local-${index + 1}`,
      scope: "local",
      label: `局部章节 ${index + 1}`,
      files: [file],
      responsibilities: ["图片", "表格", "公式", "章节内部排版"]
    });
  }
  stages.push({
    id: "references",
    scope: "references",
    label: "参考文献库",
    files: bibliographyFiles,
    responsibilities: ["文献条目", "作者与题名", "DOI 和出版信息"],
    readOnly: true
  });
  return {
    mode: localFiles.length ? "global-local-bib" : "monolithic",
    globalFile,
    localFiles,
    supportFiles,
    bibliographyFiles,
    stages
  };
}

export function formatRelevantExcerpt(content, maxCharacters = 30_000) {
  const text = String(content || "");
  if (text.length <= maxCharacters) return text;
  const lines = text.split(/\r?\n/);
  const selected = new Set();
  const addRange = (start, end) => {
    for (let index = Math.max(0, start); index <= Math.min(lines.length - 1, end); index += 1) selected.add(index);
  };
  for (let index = 0; index < lines.length; index += 1) {
    if (formatCommandLine.test(lines[index])) addRange(index - 1, index + 4);
  }
  addRange(0, Math.min(12, lines.length - 1));
  addRange(Math.max(0, lines.length - 8), lines.length - 1);

  const ordered = [...selected].sort((left, right) => left - right);
  const ranges = [];
  for (const index of ordered) {
    const previous = ranges[ranges.length - 1];
    if (previous && index <= previous.end + 1) previous.end = index;
    else ranges.push({ start: index, end: index });
  }
  let excerpt = "";
  for (const range of ranges) {
    const block = `--- lines ${range.start + 1}-${range.end + 1} ---\n${lines.slice(range.start, range.end + 1).join("\n")}\n\n`;
    if (excerpt.length + block.length > maxCharacters) {
      excerpt += block.slice(0, Math.max(0, maxCharacters - excerpt.length));
      break;
    }
    excerpt += block;
  }
  return excerpt;
}

function deterministicFormatProfile(sources) {
  const collect = (pattern) => [...new Set(sources.flatMap((source) => [...source.content.matchAll(pattern)].map((match) => match[0].trim())))];
  return {
    files: sources.map((source) => ({ file: source.file, characters: source.content.length })),
    documentClass: collect(/^\s*\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/gm),
    packages: collect(/^\s*\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]+\}/gm),
    geometry: collect(/^\s*\\(?:geometry|setlength|addtolength)\b.*$/gm),
    bibliography: collect(/^\s*\\(?:bibliographystyle|bibliography|addbibresource|printbibliography)\b.*$/gm),
    titleAuthor: collect(/^\s*\\(?:title|author|affiliation|institution|email|date|maketitle)\b.*$/gm).slice(0, 60)
  };
}

function buildCurrentFormatContext(sources, workflow, maxCharacters = 90_000) {
  let context = `## Deterministic current-format profile\n${JSON.stringify(deterministicFormatProfile(sources), null, 2)}\n\n`;
  const order = [
    ...(workflow?.stages || []).filter((stage) => !stage.readOnly).flatMap((stage) => stage.files),
    ...sources.map((source) => source.file)
  ];
  const ordered = [...new Set(order)].map((file) => sources.find((source) => source.file === file)).filter(Boolean);
  for (const source of ordered) {
    const stage = workflow?.stages.find((item) => item.files.includes(source.file));
    const perFileLimit = stage?.scope === "global" ? 30_000 : 10_000;
    const block = `## ${stage?.label || "Current file"}: ${source.file}\n${formatRelevantExcerpt(source.content, perFileLimit)}\n\n`;
    if (context.length + block.length > maxCharacters) {
      context += block.slice(0, Math.max(0, maxCharacters - context.length));
      break;
    }
    context += block;
  }
  return context;
}

async function buildTargetFormatContext(job, maxCharacters = 90_000) {
  let context = job.requirements ? `## User requirements\n${job.requirements}\n\n` : "";
  const priority = (item) => item.type === "TEX" ? 0 : ["CLS", "STY", "CFG", "DEF"].includes(item.type) ? 1 : 2;
  for (const item of [...job.extracts].sort((left, right) => priority(left) - priority(right))) {
    const text = await fs.readFile(path.join(jobRoot(job.id), item.file), "utf8");
    const latexLike = ["TEX", "CLS", "STY", "CFG", "DEF", "BST", "BBX", "CBX", "LBX"].includes(item.type);
    const selected = latexLike ? formatRelevantExcerpt(text, 26_000) : text.slice(0, 22_000);
    const block = `## Target material: ${item.name}\n${selected}\n\n`;
    if (context.length + block.length > maxCharacters) {
      context += block.slice(0, Math.max(0, maxCharacters - context.length));
      break;
    }
    context += block;
  }
  return context;
}

async function callValidatedJson(provider, request, validate, { label, attempts = 3 } = {}) {
  let previousOutput = "";
  let validationError = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const feedback = validationError
      ? [
          "# Correction required",
          `Your previous response failed local validation: ${validationError}`,
          "Return a corrected JSON object only. Do not repeat the invalid response or add commentary.",
          `Previous response excerpt:\n${previousOutput.slice(0, 4000)}`
        ].join("\n\n")
      : "";
    const response = await runtime.callProvider(provider, {
      ...request,
      user: `${request.user}${feedback ? `\n\n${feedback}` : ""}`
    });
    try {
      return { value: validate(parseJsonResponse(response)), attempts: attempt };
    } catch (error) {
      previousOutput = String(response || "");
      validationError = String(error.message || error).slice(0, 1200);
    }
  }
  const error = new Error(`${label || "AI 输出"}连续 ${attempts} 次未通过结构校验：${validationError}`);
  error.code = "FORMAT_MODEL_OUTPUT_INVALID";
  error.details = { attempts, validationError };
  throw error;
}

function inferDifferenceScope(item) {
  const value = `${item.category || ""} ${item.action || ""}`.toLowerCase();
  if (/figure|table|float|equation|algorithm|图片|表格|公式|浮动/.test(value)) return "local";
  if (/bib entry|metadata|doi|文献条目|出版信息/.test(value)) return "references";
  return "global";
}

function normalizeAnalysis(value, sourceFiles, mainTex, workflow) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("根对象必须是 JSON object");
  if (!String(value.targetName || "").trim()) throw new Error("缺少 targetName");
  if (!String(value.summary || "").trim()) throw new Error("缺少 summary");
  if (!Array.isArray(value.differences) || !value.differences.length) throw new Error("differences 必须是非空数组");
  const differences = value.differences;
  for (const [index, item] of differences.entries()) {
    if (!item || typeof item !== "object") throw new Error(`differences[${index}] 必须是对象`);
    if (!String(item.category || "").trim()) throw new Error(`differences[${index}] 缺少 category`);
    if (!String(item.target || "").trim()) throw new Error(`differences[${index}] 缺少 target`);
    if (!String(item.action || "").trim()) throw new Error(`differences[${index}] 缺少 action`);
  }
  const explicitAffected = Array.isArray(value.affectedFiles)
    ? value.affectedFiles.map(String).filter((file) => sourceFiles.includes(file))
    : [];
  const normalizedDifferences = differences.slice(0, 40).map((item, index) => ({
    id: String(item.id || `F${index + 1}`),
    category: String(item.category || "其他"),
    current: String(item.current || "未识别"),
    target: String(item.target || "未识别"),
    action: String(item.action || "需要调整"),
    risk: ["low", "medium", "high"].includes(item.risk) ? item.risk : "medium",
    scope: ["global", "local", "references", "both"].includes(item.scope) ? item.scope : inferDifferenceScope(item)
  }));
  const affected = new Set(explicitAffected);
  if (normalizedDifferences.some((item) => ["global", "both"].includes(item.scope))) {
    affected.add(workflow?.globalFile || mainTex);
    for (const file of workflow?.supportFiles || []) affected.add(file);
  }
  if (normalizedDifferences.some((item) => ["local", "both"].includes(item.scope))) {
    for (const file of workflow?.localFiles || []) affected.add(file);
  }
  if (!affected.size) affected.add(mainTex);
  return {
    targetName: String(value.targetName).trim().slice(0, 300),
    summary: String(value.summary).trim().slice(0, 3000),
    differences: normalizedDifferences,
    affectedFiles: [...affected].filter((file) => sourceFiles.includes(file)),
    warnings: Array.isArray(value.warnings) ? value.warnings.map(String).slice(0, 20) : []
  };
}

export async function analyzeFormat({ provider, projectRoot, mainTex, requirements, filePaths }) {
  const job = await prepareFormatJob(filePaths, requirements);
  try {
    job.projectRoot = path.resolve(projectRoot);
    job.mainTex = mainTex;
    const [sources, bibliographyFiles] = await Promise.all([
      readProjectSources(projectRoot, mainTex),
      discoverBibliographyFiles(projectRoot, mainTex)
    ]);
    job.workflow = buildFormatWorkflow(sources, mainTex, bibliographyFiles);
    const result = await callValidatedJson(provider, {
      system: `You are a conservative LaTeX submission-format analyst. Compare only formatting and submission structure. Never propose rewriting research claims or prose. Preserve the paper title, abstract text, and keyword entries verbatim unless the target explicitly forbids a field; only their LaTeX wrappers may change. Follow the supplied global-then-local workflow: global layout belongs in the main TeX file, chapter-local float/table/equation formatting belongs in each chapter file, and Bib entries stay in their existing Bib files. Use the deterministic profile as authoritative for the current project and cite concrete target evidence. Cover document class, geometry, columns, fonts, title/author block, abstract/keywords, headings, citations/bibliography, floats, appendices, blind review, declarations, and page rules. Return JSON only.`,
      user: [
        "Return exactly this schema:",
        '{"targetName":"","summary":"","differences":[{"id":"F1","category":"document class","current":"article","target":"acmart sigconf","action":"replace documentclass options","risk":"high","scope":"global|local|references|both"}],"affectedFiles":["main.tex"],"warnings":[]}',
        "Use only file names listed in the current project. Include at least one concrete difference.",
        `# Required workflow\n${JSON.stringify(job.workflow, null, 2)}`,
        "# Target format evidence",
        await buildTargetFormatContext(job),
        "# Current LaTeX format evidence",
        buildCurrentFormatContext(sources, job.workflow)
      ].join("\n\n"),
      json: true,
      temperature: 0,
      maxTokens: 8000
    }, (value) => normalizeAnalysis(value, sources.map((source) => source.file), mainTex, job.workflow), {
      label: "格式差异分析",
      attempts: 3
    });
    job.analysis = { ...result.value, modelAttempts: result.attempts };
    job.status = "analyzed";
    await writeJob(job);
    return publicJob(job);
  } catch (error) {
    job.status = "analysis-failed";
    job.error = error.message;
    await writeJob(job);
    throw error;
  }
}

function collectMatches(sources, pattern) {
  const values = [];
  for (const source of sources) {
    for (const match of source.content.matchAll(pattern)) {
      for (const value of String(match[1] || "").split(",")) {
        const normalized = value.trim().replaceAll("\\", "/");
        if (normalized) values.push(normalized);
      }
    }
  }
  return [...new Set(values)].sort();
}

function proseWords(content) {
  const documentBody = content.includes("\\begin{document}")
    ? content.split("\\begin{document}").slice(1).join("\\begin{document}")
    : content;
  const abstracts = [...documentBody.matchAll(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/g)]
    .map((match) => match[1]);
  const withoutAbstracts = documentBody.replace(/\\begin\{abstract\}[\s\S]*?\\end\{abstract\}/g, " ");
  const firstSection = withoutAbstracts.search(/\\section\*?\s*\{/);
  let scholarlyBody = firstSection >= 0 ? withoutAbstracts.slice(firstSection) : withoutAbstracts;
  const bibliographyStart = scholarlyBody.search(/\\(?:bibliography\s*\{|printbibliography\b|begin\{thebibliography\})/);
  if (bibliographyStart >= 0) scholarlyBody = scholarlyBody.slice(0, bibliographyStart);
  return [...abstracts, scholarlyBody].join("\n")
    .replace(/(?<!\\)%.*$/gm, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\$[^$]*\$/g, " ")
    .replace(/\\begin\{[^}]+\}|\\end\{[^}]+\}/g, " ")
    .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/g, " ")
    .replace(/[{}\\]/g, " ")
    .match(/[A-Za-z0-9][A-Za-z0-9'-]*/g) || [];
}

export function verifyContentIntegrity(before, after) {
  const beforeWords = before.flatMap((source) => proseWords(source.content));
  const afterWords = after.flatMap((source) => proseWords(source.content));
  const allowedWordDelta = Math.max(5, Math.ceil(beforeWords.length * 0.01));
  const wordDelta = Math.abs(beforeWords.length - afterWords.length);
  const checks = [
    ["citation keys", /\\(?:cite|citep|citet|citeauthor|citeyear|textcite|parencite|autocite)\w*(?:\[[^\]]*\])?\{([^}]+)\}/g],
    ["figure paths", /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g],
    ["labels", /\\label\{([^}]+)\}/g],
    ["references", /\\(?:ref|eqref|autoref|cref|Cref)\{([^}]+)\}/g]
  ];
  const errors = [];
  if (wordDelta > allowedWordDelta) errors.push(`正文词数变化 ${wordDelta}，超过允许值 ${allowedWordDelta}`);
  for (const [label, pattern] of checks) {
    const left = collectMatches(before, pattern);
    const right = collectMatches(after, pattern);
    if (JSON.stringify(left) !== JSON.stringify(right)) errors.push(`${label} 未完整保留`);
  }
  if (errors.length) {
    const error = new Error(`格式迁移未通过内容完整性检查：${errors.join("；")}`);
    error.code = "FORMAT_INTEGRITY_FAILED";
    error.details = { errors, beforeWords: beforeWords.length, afterWords: afterWords.length };
    throw error;
  }
  return { beforeWords: beforeWords.length, afterWords: afterWords.length, wordDelta };
}

const operationAliases = new Map([
  ["replace", "replace"],
  ["replace_literal", "replace"],
  ["replace-all", "replace_all"],
  ["replace_all", "replace_all"],
  ["delete", "delete"],
  ["delete_literal", "delete"],
  ["insert_before", "insert_before"],
  ["insert-before", "insert_before"],
  ["insert_after", "insert_after"],
  ["insert-after", "insert_after"]
]);
const localStageGlobalCommand = /\\(?:documentclass|usepackage|RequirePackage|PassOptionsToPackage|geometry|pagestyle|onecolumn|twocolumn|bibliography|bibliographystyle|addbibresource|printbibliography)\b/;
const targetLiteralPattern = /\\(?:documentclass|usepackage|bibliographystyle|begin)(?:\[[^\]]*\])?\{[^{}\r\n]+\}/g;
const contentPackageRequirements = [
  { package: "booktabs", pattern: /\\(?:toprule|midrule|bottomrule|cmidrule)\b/ },
  { package: "graphicx", pattern: /\\(?:includegraphics|rotatebox|resizebox|scalebox)\b/ },
  { package: "amsmath", pattern: /\\(?:eqref|dfrac|tfrac|text)\b|\\begin\{(?:align|alignat|gather|multline|split|cases)\*?\}/ },
  { package: "amssymb", pattern: /\\(?:mathbb|square|blacksquare|nexists|varnothing)\b/ },
  { package: "multirow", pattern: /\\multirow\b/ },
  { package: "xcolor", pattern: /\\(?:color|textcolor|colorbox|definecolor)\b/ }
];

function normalizeTargetLiteral(value) {
  return String(value || "").replace(/\s+/g, "");
}

function stripLatexComments(value) {
  return String(value || "").replace(/(?<!\\)%.*$/gm, "");
}

function requiredTargetLiterals(requirements) {
  return [...new Set([...stripLatexComments(requirements).matchAll(targetLiteralPattern)].map((match) => match[0]))];
}

function requiredContentPackages(sources, packageSource) {
  const content = sources.map((source) => source.content).join("\n");
  return contentPackageRequirements
    .filter((item) => item.pattern.test(content) && hasPackage(packageSource?.content, item.package))
    .map((item) => item.package);
}

function hasPackage(content, packageName) {
  for (const match of stripLatexComments(content).matchAll(/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^{}]+)\}/g)) {
    if (match[1].split(",").map((item) => item.trim()).includes(packageName)) return true;
  }
  return false;
}

function validateGlobalTargetConstraints(content, requiredLiterals, protectedPackages) {
  const available = new Set([...stripLatexComments(content).matchAll(targetLiteralPattern)]
    .map((match) => normalizeTargetLiteral(match[0])));
  const missingLiterals = requiredLiterals.filter((literal) => !available.has(normalizeTargetLiteral(literal)));
  const missingPackages = protectedPackages.filter((packageName) => !hasPackage(content, packageName));
  if (!missingLiterals.length && !missingPackages.length) return;
  const parts = [];
  if (missingLiterals.length) parts.push(`missing required target LaTeX literals: ${missingLiterals.join(", ")}`);
  if (missingPackages.length) parts.push(`removed packages still required by manuscript commands: ${missingPackages.join(", ")}`);
  throw new Error(parts.join("; "));
}

function restoreProtectedPackageOperations(source, plan, protectedPackages) {
  const candidate = applyFormatOperations(source.content, plan);
  const missingPackages = protectedPackages.filter((packageName) => !hasPackage(candidate, packageName));
  if (!missingPackages.length) return plan;
  const declarations = [];
  for (const match of stripLatexComments(source.content).matchAll(/\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{([^{}]+)\}/g)) {
    const packages = match[1].split(",").map((item) => item.trim());
    if (packages.some((packageName) => missingPackages.includes(packageName))) declarations.push(match[0]);
  }
  const restoredPackages = missingPackages.filter((packageName) => declarations.some((line) => hasPackage(line, packageName)));
  if (restoredPackages.length !== missingPackages.length) {
    throw new Error(`could not restore original declarations for required packages: ${missingPackages.join(", ")}`);
  }
  const operations = [
    ...plan.operations,
    {
      id: `PB-PACKAGES-${plan.operations.length + 1}`,
      type: "insert_before",
      oldText: "\\begin{document}",
      newText: `${[...new Set(declarations)].join("\n")}\n`,
      reason: `restore original packages still required by manuscript commands: ${missingPackages.join(", ")}`
    }
  ];
  if (operations.length > 60) throw new Error("package restoration would exceed the per-file operation limit");
  const restored = { ...plan, operations };
  applyFormatOperations(source.content, restored);
  return restored;
}

function validateTransformedTargetConstraints(job, sources, transformed) {
  const globalFile = job.workflow?.globalFile || job.mainTex;
  const originalGlobal = sources.find((source) => source.file === globalFile);
  const transformedGlobal = transformed.find((source) => source.file === globalFile);
  if (!originalGlobal || !transformedGlobal) return;
  validateGlobalTargetConstraints(
    transformedGlobal.content,
    requiredTargetLiterals(job.requirements),
    requiredContentPackages(sources, originalGlobal)
  );
}

function countOccurrences(content, value) {
  if (!value) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = content.indexOf(value, offset)) >= 0) {
    count += 1;
    offset += Math.max(1, value.length);
  }
  return count;
}

function normalizeOperationPlan(value, source, { requireOperations = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("根对象必须是 JSON object");
  if (String(value.file || "").replaceAll("\\", "/") !== source.file) throw new Error(`file 必须是 ${source.file}`);
  if (!Array.isArray(value.operations)) throw new Error("operations 必须是数组");
  if (requireOperations && !value.operations.length) throw new Error("当前文件至少需要一个格式编辑操作");
  if (value.operations.length > 60) throw new Error("单个文件的操作数不能超过 60");
  const operations = value.operations.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`operations[${index}] 必须是对象`);
    const type = operationAliases.get(String(item.type || "").toLowerCase());
    if (!type) throw new Error(`operations[${index}].type 不受支持`);
    const oldText = String(item.oldText ?? item.old ?? item.anchor ?? item.find ?? "").replaceAll("\r\n", "\n");
    const newText = String(item.newText ?? item.new ?? item.replacement ?? item.insert ?? "").replaceAll("\r\n", "\n");
    if (!oldText) throw new Error(`operations[${index}] 缺少 oldText/anchor`);
    if (oldText.length > 20_000 || newText.length > 20_000) throw new Error(`operations[${index}] 文本过长`);
    if (["replace", "replace_all"].includes(type) && oldText === newText) throw new Error(`operations[${index}] 是无效的原文替换`);
    return {
      id: String(item.id || `E${index + 1}`),
      type,
      oldText,
      newText,
      reason: String(item.reason || "格式调整").slice(0, 500)
    };
  });
  const plan = { file: source.file, operations };
  applyFormatOperations(source.content, plan);
  return plan;
}

export function applyFormatOperations(content, plan) {
  const eol = String(content).includes("\r\n") ? "\r\n" : "\n";
  let next = String(content).replaceAll("\r\n", "\n");
  for (const [index, operation] of (plan.operations || []).entries()) {
    const occurrences = countOccurrences(next, operation.oldText);
    if (!occurrences) throw new Error(`操作 ${index + 1} 的 oldText/anchor 在当前文件中不存在`);
    if (operation.type !== "replace_all" && occurrences !== 1) {
      throw new Error(`操作 ${index + 1} 的 oldText/anchor 出现 ${occurrences} 次，必须提供更精确的上下文`);
    }
    if (operation.type === "replace") next = next.replace(operation.oldText, operation.newText);
    else if (operation.type === "replace_all") next = next.split(operation.oldText).join(operation.newText);
    else if (operation.type === "delete") next = next.replace(operation.oldText, "");
    else if (operation.type === "insert_before") next = next.replace(operation.oldText, `${operation.newText}${operation.oldText}`);
    else if (operation.type === "insert_after") next = next.replace(operation.oldText, `${operation.oldText}${operation.newText}`);
  }
  return eol === "\r\n" ? next.replaceAll("\n", "\r\n") : next;
}

async function generateFormatOperations(provider, job, sources, assetNames) {
  const affected = new Set((job.analysis.affectedFiles || []).filter((file) => sources.some((source) => source.file === file)));
  if (!affected.size) affected.add(job.mainTex);
  const targetContext = await buildTargetFormatContext(job, 24_000);
  const transformed = [];
  const plans = [];
  let totalAttempts = 0;
  let requiredPlanAssigned = false;
  const targetLiterals = requiredTargetLiterals(job.requirements);
  const globalSource = sources.find((source) => source.file === job.workflow?.globalFile);
  const protectedPackages = requiredContentPackages(sources, globalSource);
  const workflowOrder = (job.workflow?.stages || [])
    .filter((stage) => !stage.readOnly)
    .flatMap((stage) => stage.files);
  const orderedSources = [...new Set([...workflowOrder, ...sources.map((source) => source.file)])]
    .map((file) => sources.find((source) => source.file === file))
    .filter(Boolean);
  for (const source of orderedSources) {
    if (!affected.has(source.file)) {
      transformed.push({ ...source });
      continue;
    }
    const requireOperations = !requiredPlanAssigned;
    const stage = job.workflow?.stages.find((item) => item.files.includes(source.file)) || {
      id: "global",
      scope: "global",
      label: "整体格式",
      responsibilities: []
    };
    const localStage = stage.scope === "local";
    const example = {
      file: source.file,
      operations: [{
        id: "E1",
        type: "replace",
        oldText: localStage ? "\\begin{figure}[h]" : "\\documentclass{article}",
        newText: localStage ? "\\begin{figure}[t]" : "\\documentclass[sigconf]{acmart}",
        reason: localStage ? "调整当前章节的图片浮动位置" : "采用目标会议文档类"
      }]
    };
    const result = await callValidatedJson(provider, {
      system: [
        "You are a conservative LaTeX format migration planner.",
        `This is the ${stage.label} stage (${stage.scope}).`,
        localStage
          ? "Only edit chapter-local figure, table, equation, algorithm, or section-level layout. Never add documentclass, packages, geometry, fonts, page dimensions, or bibliography commands here."
          : "Only edit global layout, packages, title structure, columns, fonts, margins, and bibliography calls. Never rewrite chapter prose.",
        job.workflow?.mode === "monolithic"
          ? "This project is monolithic. Never add input or include commands, and do not reference support TeX files copied from a target example; keep the existing body in the current main TeX file."
          : "Preserve the existing global-then-local file structure and do not invent new input or include files.",
        "Return small exact edit operations, never a complete rewritten file.",
        "Do not rewrite, translate, shorten, or paraphrase scholarly prose.",
        "Preserve the paper title, abstract text, and every keyword entry verbatim; only change their LaTeX wrapper commands when the target requires it.",
        "Keep every package that is still required by commands, environments, tables, equations, figures, or citations in the existing manuscript unless you also provide a target-compatible replacement.",
        "Every oldText or anchor must be copied exactly from the supplied current-file excerpt, without line-number headers.",
        "Prefer the fewest edits that satisfy the approved analysis. Return JSON only."
      ].join(" "),
      user: [
        "Return this schema:",
        '{"file":"main.tex","operations":[{"id":"E1","type":"replace|replace_all|delete|insert_before|insert_after","oldText":"exact existing text or anchor","newText":"replacement or inserted text","reason":"brief reason"}]}',
        `Example shape (adapt file and content; do not copy blindly):\n${JSON.stringify(example, null, 2)}`,
        `# Workflow stage\n${JSON.stringify(stage, null, 2)}`,
        `# Approved format analysis\n${JSON.stringify(job.analysis, null, 2)}`,
        `# Target evidence\n${targetContext}`,
        `# Support assets available at project root\n${assetNames.join("\n") || "None"}`,
        `# Current file: ${source.file}\n${formatRelevantExcerpt(source.content, 26_000)}`
      ].join("\n\n"),
      json: true,
      temperature: 0,
      maxTokens: 6000
    }, (value) => {
      let plan = normalizeOperationPlan(value, source, { requireOperations });
      if (localStage && plan.operations.some((operation) => (
        localStageGlobalCommand.test(operation.oldText) || localStageGlobalCommand.test(operation.newText)
      ))) {
        throw new Error("局部章节阶段不得新增文档类、宏包、页面布局或参考文献命令");
      }
      if (!localStage && source.file === job.workflow?.globalFile) {
        plan = restoreProtectedPackageOperations(source, plan, protectedPackages);
        validateGlobalTargetConstraints(
          applyFormatOperations(source.content, plan),
          targetLiterals,
          protectedPackages
        );
      }
      const candidate = applyFormatOperations(source.content, plan);
      const commandAnalysis = analyzeLatexCommands([source.content], candidate);
      if (commandAnalysis.dangerousCommands.length) {
        throw new Error(`introduced dangerous LaTeX commands: ${commandAnalysis.dangerousCommands.join(", ")}`);
      }
      return plan;
    }, {
      label: `${source.file} 的格式编辑计划`,
      attempts: 3
    });
    const content = applyFormatOperations(source.content, result.value);
    transformed.push({ file: source.file, content });
    plans.push({ ...result.value, stage: stage.scope, stageId: stage.id, stageLabel: stage.label });
    totalAttempts += result.attempts;
    if (result.value.operations.length) requiredPlanAssigned = true;
  }
  if (!plans.some((plan) => plan.operations.length)) throw new Error("AI 没有生成任何可执行的格式修改。");
  return { transformed, plans, modelAttempts: totalAttempts };
}

function repairLocations(log, sources, mainTex) {
  const files = sources.map((source) => source.file);
  const locations = [];
  const seen = new Set();
  const add = (file, line) => {
    const normalized = String(file || "").replaceAll("\\", "/").replace(/^\.\//, "");
    const projectFile = files.find((candidate) => normalized === candidate || normalized.endsWith(`/${candidate}`));
    if (!projectFile) return;
    const value = Math.max(1, Number(line) || 1);
    const key = `${projectFile}:${value}`;
    if (!seen.has(key)) {
      seen.add(key);
      locations.push({ file: projectFile, line: value });
    }
  };
  for (const match of String(log || "").matchAll(/^(.+?\.tex):(\d+):\s*.+$/gm)) add(match[1], match[2]);
  for (const match of String(log || "").matchAll(/^l\.(\d+)\s*.*$/gm)) add(mainTex, match[1]);
  return locations.slice(0, 8);
}

function buildCompileRepairContext(sources, mainTex, build, compilerLog) {
  const locations = repairLocations(compilerLog, sources, mainTex);
  const snippets = [];
  for (const location of locations.slice(0, 6)) {
    const source = sources.find((item) => item.file === location.file);
    const lines = source?.content.split(/\r?\n/) || [];
    const start = Math.max(1, location.line - 5);
    const end = Math.min(lines.length, location.line + 5);
    snippets.push(`--- ${location.file}:${location.line} (lines ${start}-${end}) ---\n${lines.slice(start - 1, end).join("\n")}`);
  }
  const fallback = sources.map((source) => `## ${source.file}\n${formatRelevantExcerpt(source.content, 9000)}`).join("\n\n").slice(0, 28_000);
  return [
    `Compiler errors:\n${(build.errors || []).join("\n") || "Unknown fatal compiler error"}`,
    `Compiler log tail:\n${String(compilerLog || build.log || "").slice(-14_000)}`,
    `Exact source around reported lines:\n${snippets.join("\n\n") || "No exact line was reported."}`,
    `Format-relevant fallback context:\n${fallback}`
  ].join("\n\n").slice(0, 44_000);
}

async function repairFailedFormatBuild(provider, projectRoot, mainTex, sources, build) {
  let compilerLog = build.log || "";
  try {
    compilerLog = await fs.readFile(path.join(projectRoot, mainTex.replace(/\.tex$/i, ".log")), "utf8");
  } catch {
    // The compiler output is enough when no log file was produced.
  }
  const context = buildCompileRepairContext(sources, mainTex, build, compilerLog);
  const exampleFile = repairLocations(compilerLog, sources, mainTex)[0]?.file || mainTex;
  const example = {
    file: exampleFile,
    operations: [{
      id: "R1",
      type: "replace",
      oldText: "\\usepackage{missing-package}",
      newText: "% removed unavailable package",
      reason: "编译器报告宏包不可用"
    }]
  };
  return callValidatedJson(provider, {
    system: [
      "You repair a LaTeX format migration using compiler feedback.",
      "Return the smallest exact edit operations needed to resolve the fatal error.",
      "Do not rewrite scholarly prose, change research content, or return complete files.",
      "Copy oldText exactly from the supplied source context. Return JSON only."
    ].join(" "),
    user: [
      "Return this schema:",
      '{"file":"main.tex","operations":[{"id":"R1","type":"replace|replace_all|delete|insert_before|insert_after","oldText":"exact existing text or anchor","newText":"replacement or inserted text","reason":"compiler-based reason"}]}',
      `Example shape only:\n${JSON.stringify(example, null, 2)}`,
      context
    ].join("\n\n"),
    json: true,
    temperature: 0,
    maxTokens: 5000
  }, (value) => {
    const file = String(value?.file || "").replaceAll("\\", "/");
    const source = sources.find((item) => item.file === file);
    if (!source) throw new Error("repair file 必须是当前项目中的 TeX 文件");
    return { source, plan: normalizeOperationPlan(value, source, { requireOperations: true }) };
  }, {
    label: "编译错误修复计划",
    attempts: 2
  });
}

async function targetAssetManifest(job) {
  const assets = [];
  for (const relativeRoot of job.assetRoots || []) {
    const absoluteRoot = path.join(jobRoot(job.id), relativeRoot);
    for (const file of await collectFiles(absoluteRoot)) {
      if (templateAssets.has(path.extname(file.absolute).toLowerCase())) assets.push(file);
    }
  }
  return assets;
}

async function createBackup(projectRoot, jobId, sources) {
  const backupRoot = path.join(formatBackupsRoot(), jobId);
  await fs.mkdir(backupRoot, { recursive: true });
  for (const source of sources) {
    const destination = path.join(backupRoot, source.file);
    await writeFileAtomic(destination, source.content);
  }
  await writeFileAtomic(
    path.join(backupRoot, "manifest.json"),
    `${JSON.stringify({ projectRoot: path.resolve(projectRoot), files: sources.map((source) => source.file) }, null, 2)}\n`
  );
  return backupRoot;
}

async function removeBackupDirectory(target) {
  const [root, resolved] = await Promise.all([fs.realpath(formatBackupsRoot()), fs.realpath(target)]);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Refusing to remove a backup outside the format backup root.");
  }
  await fs.rm(resolved, { recursive: true, force: true });
}

async function pruneFormatBackups(projectRoot, keep = 3) {
  await fs.mkdir(formatBackupsRoot(), { recursive: true });
  const matches = [];
  for (const entry of await fs.readdir(formatBackupsRoot(), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(formatBackupsRoot(), entry.name);
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
      if (path.resolve(manifest.projectRoot || "") !== path.resolve(projectRoot)) continue;
      matches.push({ directory, modified: (await fs.stat(directory)).mtimeMs });
    } catch {
      // Ignore incomplete backups; they are not safe to associate with this project.
    }
  }
  matches.sort((left, right) => right.modified - left.modified);
  for (const item of matches.slice(keep)) await removeBackupDirectory(item.directory);
}

async function restoreBackup(projectRoot, backupRoot, sources, copiedAssets) {
  for (const source of sources) {
    await writeProjectSourceAtomic(projectRoot, source.file, await fs.readFile(path.join(backupRoot, source.file)));
  }
  const root = path.resolve(projectRoot);
  for (const asset of copiedAssets) {
    const target = path.resolve(projectRoot, asset);
    const relative = path.relative(root, target);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) await fs.rm(target, { force: true });
  }
}

async function copyTemplateAssets(job, projectRoot) {
  const copied = [];
  const skipped = [];
  for (const asset of await targetAssetManifest(job)) {
    const name = path.basename(asset.absolute);
    const destination = path.join(projectRoot, name);
    try {
      await fs.access(destination);
      skipped.push(name);
    } catch {
      await fs.copyFile(asset.absolute, destination);
      copied.push(name);
    }
  }
  return { copied, skipped };
}

function formatSourceFingerprint(sources) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(sources.map((source) => [source.file, source.content])), "utf8")
    .digest("hex");
}

function inspectFormatCommands(sources, transformed, additionalSources = []) {
  const dangerousCommands = [];
  const unexpectedCommands = [];
  for (const source of sources) {
    const next = transformed.find((item) => item.file === source.file);
    if (!next) continue;
    const additional = additionalSources.find((item) => item.file === source.file);
    const analysis = analyzeLatexCommands(
      [source.content, additional?.content].filter(Boolean),
      next.content
    );
    dangerousCommands.push(...analysis.dangerousCommands.map((command) => `${source.file}: ${command}`));
    unexpectedCommands.push(...analysis.unexpectedCommands.map((command) => `${source.file}: ${command}`));
  }
  return {
    dangerousCommands: [...new Set(dangerousCommands)].sort(),
    unexpectedCommands: [...new Set(unexpectedCommands)].sort()
  };
}

function pruneFormatApprovals() {
  const now = Date.now();
  for (const [token, entry] of pendingFormatApprovals) {
    if (entry.expiresAt <= now) pendingFormatApprovals.delete(token);
  }
  while (pendingFormatApprovals.size > 8) pendingFormatApprovals.delete(pendingFormatApprovals.keys().next().value);
}

async function applyFormatUnlocked({ provider, projectRoot, mainTex, jobId, approvalToken = "" }) {
  const job = await readJob(jobId);
  if (!job.analysis) throw new Error("请先完成格式差异分析。");
  if (path.resolve(projectRoot) !== path.resolve(job.projectRoot || "") || mainTex !== job.mainTex) {
    throw new Error("该格式分析属于另一篇论文，请重新分析当前项目。");
  }
  const sources = await readProjectSources(projectRoot, mainTex);
  const assets = await targetAssetManifest(job);
  const assetNames = [...new Set(assets.map((asset) => path.basename(asset.absolute)))].sort();
  let transformed = [];
  let integrity;

  job.status = "applying";
  await writeJob(job);
  try {
    pruneFormatApprovals();
    const pending = approvalToken ? pendingFormatApprovals.get(String(approvalToken)) : null;
    const fingerprint = formatSourceFingerprint(sources);
    if (approvalToken) {
      if (!pending || pending.jobId !== jobId || pending.fingerprint !== fingerprint) {
        const error = new Error("格式迁移的 LaTeX 命令确认已失效，请重新应用格式。");
        error.code = "LATEX_APPROVAL_EXPIRED";
        throw error;
      }
      transformed = pending.transformed;
      integrity = pending.integrity;
      job.execution = pending.execution;
      pendingFormatApprovals.delete(String(approvalToken));
    } else {
      const generated = await generateFormatOperations(provider, job, sources, assetNames);
      transformed = generated.transformed;
      const executionStages = [];
      for (const plan of generated.plans) {
        let stage = executionStages.find((item) => item.id === plan.stageId);
        if (!stage) {
          stage = { id: plan.stageId, label: plan.stageLabel, scope: plan.stage, files: [], operations: 0 };
          executionStages.push(stage);
        }
        stage.files.push(plan.file);
        stage.operations += plan.operations.length;
      }
      executionStages.push({
        id: "references",
        label: "参考文献库",
        scope: "references",
        files: job.workflow?.bibliographyFiles || [],
        operations: 0,
        preserved: true
      });
      job.execution = {
        strategy: "global-then-local-validated-operations",
        modelAttempts: generated.modelAttempts,
        operations: generated.plans.reduce((sum, plan) => sum + plan.operations.length, 0),
        files: generated.plans.map((plan) => ({ file: plan.file, stage: plan.stage, operations: plan.operations.length })),
        stages: executionStages
      };

      validateTransformedTargetConstraints(job, sources, transformed);
      integrity = verifyContentIntegrity(sources, transformed);
      const commandAnalysis = inspectFormatCommands(sources, transformed);
      if (commandAnalysis.dangerousCommands.length) {
        const error = new Error("格式迁移结果包含危险 LaTeX 命令，PaperBridge 已阻止写入。");
        error.status = 422;
        error.code = "DANGEROUS_LATEX_COMMANDS";
        error.details = commandAnalysis;
        throw error;
      }
      if (commandAnalysis.unexpectedCommands.length) {
        const token = crypto.randomUUID();
        pendingFormatApprovals.set(token, {
          jobId,
          fingerprint,
          transformed,
          integrity,
          execution: job.execution,
          expiresAt: Date.now() + 10 * 60_000
        });
        const error = new Error("格式迁移新增了当前项目中没有的 LaTeX 命令，需要确认后才能写入。");
        error.status = 409;
        error.code = "UNEXPECTED_LATEX_COMMANDS";
        error.details = { ...commandAnalysis, approvalToken: token };
        throw error;
      }
    }

    const backupRoot = await createBackup(projectRoot, job.id, sources);
    const copiedAssets = [];
    try {
      for (const source of transformed) {
        await writeProjectSourceAtomic(projectRoot, source.file, source.content);
      }
      const assetResult = await copyTemplateAssets(job, projectRoot);
      copiedAssets.push(...assetResult.copied);
      let build = await compileProject(projectRoot, mainTex, { clean: true });
      const repairFailures = [];
      let compileRepairAttempts = 0;
      while (!build.success && compileRepairAttempts < 2) {
        try {
          const repair = await repairFailedFormatBuild(provider, projectRoot, mainTex, transformed, build);
          const repaired = transformed.map((source) => source.file === repair.value.source.file
            ? { ...source, content: applyFormatOperations(source.content, repair.value.plan) }
            : source);
          validateTransformedTargetConstraints(job, sources, repaired);
          integrity = verifyContentIntegrity(sources, repaired);
          const repairCommands = inspectFormatCommands(transformed, repaired, sources);
          if (repairCommands.dangerousCommands.length || repairCommands.unexpectedCommands.length) {
            const error = new Error("编译修复尝试新增了未经确认的 LaTeX 命令，已停止自动修复。");
            error.code = "FORMAT_REPAIR_UNSAFE";
            error.details = repairCommands;
            throw error;
          }
          transformed = repaired;
          for (const source of transformed) {
            await writeProjectSourceAtomic(projectRoot, source.file, source.content);
          }
          compileRepairAttempts += 1;
          job.execution = {
            ...(job.execution || {}),
            modelAttempts: (job.execution?.modelAttempts || 0) + repair.attempts,
            compileRepairAttempts
          };
          build = await compileProject(projectRoot, mainTex);
        } catch (error) {
          repairFailures.push({
            code: error.code || "FORMAT_REPAIR_FAILED",
            message: String(error.message || error),
            details: error.details || null
          });
          break;
        }
      }
      if (!build.success) {
        const error = new Error("目标格式未能成功编译，所有文件已自动恢复。");
        error.code = "FORMAT_COMPILE_FAILED";
        error.details = { ...build, compileRepairAttempts, repairFailures };
        throw error;
      }
      job.status = "applied";
      job.build = { success: true, pages: build.pdf.pages, engine: build.engine, copiedAssets, skippedAssets: assetResult.skipped, integrity, compileRepairAttempts };
      await writeJob(job);
      await pruneFormatBackups(projectRoot).catch(() => {});
      return { job: publicJob(job), build, integrity };
    } catch (error) {
      await restoreBackup(projectRoot, backupRoot, sources, copiedAssets);
      await pruneFormatBackups(projectRoot).catch(() => {});
      throw error;
    }
  } catch (error) {
    job.status = error.code === "UNEXPECTED_LATEX_COMMANDS" ? "awaiting-command-approval" : "apply-failed";
    job.error = error.message;
    await writeJob(job);
    throw error;
  }
}

export function applyFormat(options) {
  return queueFormatApply(options.projectRoot, () => applyFormatUnlocked(options));
}

export async function latestFormatJob(projectRoot, mainTex) {
  await fs.mkdir(jobsRoot(), { recursive: true });
  const entries = await fs.readdir(jobsRoot(), { withFileTypes: true });
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const job = await readJob(entry.name);
      if (path.resolve(job.projectRoot || "") === path.resolve(projectRoot || "") && job.mainTex === mainTex) jobs.push(job);
    } catch {
      // Ignore incomplete task directories.
    }
  }
  jobs.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  return jobs[0] ? publicJob(jobs[0]) : null;
}
