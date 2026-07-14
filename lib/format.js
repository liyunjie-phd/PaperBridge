import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import extract from "extract-zip";
import WordExtractor from "word-extractor";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { analyzeLatexCommands, cleanModelText, discoverTexFiles, resolveProjectFile } from "./latex.js";
import { callProvider, parseJsonResponse } from "./providers.js";
import { compileProject } from "./project.js";

const allowedUploads = new Set([".doc", ".docx", ".pdf", ".tex", ".zip"]);
const readableText = new Set([".tex", ".cls", ".sty", ".bst", ".bbx", ".cbx", ".lbx", ".bib", ".txt", ".md", ".cfg", ".def"]);
const templateAssets = new Set([".cls", ".sty", ".bst", ".bbx", ".cbx", ".lbx", ".cfg", ".def", ".ttf", ".otf", ".png", ".jpg", ".jpeg", ".pdf", ".eps"]);
const skippedDirectories = new Set([".git", "node_modules", "build", "out", "dist"]);

let runtime = { dataRoot: process.cwd(), callProvider };
const pendingFormatApprovals = new Map();

export function configureFormatRuntime(next = {}) {
  runtime = { ...runtime, ...next };
}

const jobsRoot = () => path.join(runtime.dataRoot, "format-jobs");

function jobRoot(jobId) {
  if (!/^[a-f0-9-]+$/i.test(String(jobId || ""))) throw new Error("无效的格式任务编号。");
  return path.join(jobsRoot(), jobId);
}

async function writeJob(job) {
  job.updatedAt = new Date().toISOString();
  await fs.mkdir(jobRoot(job.id), { recursive: true });
  await fs.writeFile(path.join(jobRoot(job.id), "job.json"), `${JSON.stringify(job, null, 2)}\n`, "utf8");
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
    build: job.build || null
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

async function buildMaterialContext(job, maxCharacters = 150_000) {
  let context = job.requirements ? `## User requirements\n${job.requirements}\n\n` : "";
  for (const item of job.extracts) {
    const text = await fs.readFile(path.join(jobRoot(job.id), item.file), "utf8");
    const block = `## Target material: ${item.name}\n${text}\n\n`;
    if (context.length + block.length > maxCharacters) {
      context += block.slice(0, Math.max(0, maxCharacters - context.length));
      break;
    }
    context += block;
  }
  return context;
}

async function readProjectSources(projectRoot, mainTex) {
  const files = await discoverTexFiles(projectRoot, mainTex);
  return Promise.all(files.map(async (file) => ({
    file,
    content: await fs.readFile(await resolveProjectFile(projectRoot, file), "utf8")
  })));
}

function buildCurrentContext(sources, maxCharacters = 170_000) {
  let context = "";
  for (const source of sources) {
    const block = `## Current file: ${source.file}\n${source.content}\n\n`;
    if (context.length + block.length > maxCharacters) {
      context += block.slice(0, Math.max(0, maxCharacters - context.length));
      break;
    }
    context += block;
  }
  return context;
}

function normalizeAnalysis(value, sourceFiles) {
  const differences = Array.isArray(value.differences) ? value.differences : [];
  return {
    targetName: String(value.targetName || "目标投稿格式"),
    summary: String(value.summary || "已完成格式差异分析。"),
    differences: differences.slice(0, 40).map((item, index) => ({
      id: String(item.id || `F${index + 1}`),
      category: String(item.category || "其他"),
      current: String(item.current || "未识别"),
      target: String(item.target || "未识别"),
      action: String(item.action || "需要调整"),
      risk: ["low", "medium", "high"].includes(item.risk) ? item.risk : "medium"
    })),
    affectedFiles: Array.isArray(value.affectedFiles)
      ? value.affectedFiles.filter((file) => sourceFiles.includes(file))
      : sourceFiles,
    warnings: Array.isArray(value.warnings) ? value.warnings.map(String).slice(0, 20) : []
  };
}

export async function analyzeFormat({ provider, projectRoot, mainTex, requirements, filePaths }) {
  const job = await prepareFormatJob(filePaths, requirements);
  try {
    job.projectRoot = path.resolve(projectRoot);
    job.mainTex = mainTex;
    const sources = await readProjectSources(projectRoot, mainTex);
    const response = await runtime.callProvider(provider, {
      system: `You are a LaTeX submission-format analyst. Compare the current manuscript with the target venue materials and user requirements. Analyze formatting only; do not propose rewriting research claims or prose. Cover document class, page geometry, columns, fonts, title and author block, abstract and keywords, heading hierarchy, citations and bibliography, tables, figures, appendices, blind-review rules, required declarations, and page limits. Return JSON only with this schema: {"targetName":"","summary":"","differences":[{"id":"F1","category":"","current":"","target":"","action":"","risk":"low|medium|high"}],"affectedFiles":["file.tex"],"warnings":[""]}.`,
      user: `${await buildMaterialContext(job)}\n\n# Current LaTeX project\n${buildCurrentContext(sources)}`,
      json: true,
      temperature: 0.1,
      maxTokens: 12_000
    });
    job.analysis = normalizeAnalysis(parseJsonResponse(response), sources.map((source) => source.file));
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
  const body = content.includes("\\begin{document}") ? content.split("\\begin{document}").slice(1).join("\\begin{document}") : content;
  return body
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

function extractLatexResponse(response) {
  const cleaned = cleanModelText(response);
  const match = cleaned.match(/<latex>\s*([\s\S]*?)\s*<\/latex>/i);
  if (!match?.[1]) throw new Error("AI 没有返回完整的 LaTeX 文件内容。");
  return match[1].replace(/^```(?:latex|tex)?\s*/i, "").replace(/\s*```$/, "").trimEnd() + "\n";
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
  const backupRoot = path.join(runtime.dataRoot, "format-backups", jobId);
  await fs.mkdir(backupRoot, { recursive: true });
  for (const source of sources) {
    const destination = path.join(backupRoot, source.file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, source.content, "utf8");
  }
  await fs.writeFile(path.join(backupRoot, "manifest.json"), `${JSON.stringify({ projectRoot, files: sources.map((source) => source.file) }, null, 2)}\n`, "utf8");
  return backupRoot;
}

async function restoreBackup(projectRoot, backupRoot, sources, copiedAssets) {
  for (const source of sources) {
    await fs.copyFile(path.join(backupRoot, source.file), await resolveProjectFile(projectRoot, source.file));
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

function inspectFormatCommands(sources, transformed) {
  const dangerousCommands = [];
  const unexpectedCommands = [];
  for (const source of sources) {
    const next = transformed.find((item) => item.file === source.file);
    if (!next) continue;
    const analysis = analyzeLatexCommands([source.content], next.content);
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

export async function applyFormat({ provider, projectRoot, mainTex, jobId, approvalToken = "" }) {
  const job = await readJob(jobId);
  if (!job.analysis) throw new Error("请先完成格式差异分析。");
  if (path.resolve(projectRoot) !== path.resolve(job.projectRoot || "") || mainTex !== job.mainTex) {
    throw new Error("该格式分析属于另一篇论文，请重新分析当前项目。");
  }
  const sources = await readProjectSources(projectRoot, mainTex);
  const targetContext = await buildMaterialContext(job, 100_000);
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
      pendingFormatApprovals.delete(String(approvalToken));
    } else {
      for (const source of sources) {
        const response = await runtime.callProvider(provider, {
          system: `You are a conservative LaTeX format migration engine. Change formatting and LaTeX structure only. Never rewrite, shorten, expand, translate, or paraphrase scholarly prose. Preserve every citation key, label, reference, equation, table value, numeric value, and \\includegraphics path. Preserve the existing file boundary and return the complete transformed version of the one requested file. The target support assets listed by the user will be copied to the project root. Output exactly one <latex>...</latex> block and no markdown fences.`,
          user: `# Approved format analysis\n${JSON.stringify(job.analysis, null, 2)}\n\n# Target requirements and materials\n${targetContext}\n\n# Support assets available at project root\n${assetNames.join("\n") || "None"}\n\n# File to transform: ${source.file}\n${source.content}`,
          temperature: 0,
          maxTokens: 32_000
        });
        transformed.push({ file: source.file, content: extractLatexResponse(response) });
      }

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
        await fs.writeFile(await resolveProjectFile(projectRoot, source.file), source.content, "utf8");
      }
      const assetResult = await copyTemplateAssets(job, projectRoot);
      copiedAssets.push(...assetResult.copied);
      const build = await compileProject(projectRoot, mainTex);
      if (!build.success) {
        const error = new Error("目标格式未能成功编译，所有文件已自动恢复。");
        error.code = "FORMAT_COMPILE_FAILED";
        error.details = build;
        throw error;
      }
      job.status = "applied";
      job.build = { success: true, pages: build.pdf.pages, engine: build.engine, copiedAssets, skippedAssets: assetResult.skipped, integrity };
      await writeJob(job);
      return { job: publicJob(job), build, integrity };
    } catch (error) {
      await restoreBackup(projectRoot, backupRoot, sources, copiedAssets);
      throw error;
    }
  } catch (error) {
    job.status = error.code === "UNEXPECTED_LATEX_COMMANDS" ? "awaiting-command-approval" : "apply-failed";
    job.error = error.message;
    await writeJob(job);
    throw error;
  }
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
