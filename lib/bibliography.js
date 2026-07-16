import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { discoverTexFiles, resolveProjectFile } from "./latex.js";
import { compileProject } from "./project.js";

const THEBIBLIOGRAPHY_PATTERN = /\\begin\s*\{thebibliography\}\s*\{[^{}]*\}([\s\S]*?)\\end\s*\{thebibliography\}/g;
const FILECONTENTS_PATTERN = /\\begin\s*\{filecontents\*?\}\s*\{([^{}]+\.bib)\}([\s\S]*?)\\end\s*\{filecontents\*?\}/gi;
const BIBITEM_PATTERN = /\\bibitem(?:\s*\[([^\]]*)\])?\s*\{([^{}]+)\}/g;
const BIBLIOGRAPHY_MARKER = "% PAPERBRIDGE_BIBLIOGRAPHY";

function fingerprint(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function stripLatexComments(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|[^\\])%.*$/, "$1").trimEnd())
    .join("\n")
    .trim();
}

function normalizeBibPath(value) {
  const normalized = path.posix.normalize(String(value || "").trim().replaceAll("\\", "/")).replace(/^\.\//, "");
  if (!normalized.toLowerCase().endsWith(".bib")
    || normalized.startsWith("../")
    || path.posix.isAbsolute(normalized)
    || !/^[a-z0-9._/-]+\.bib$/i.test(normalized)) {
    throw new Error(`不安全的 Bib 文件名：${value}`);
  }
  return normalized;
}

function parseBibitems(body) {
  const matches = [...body.matchAll(BIBITEM_PATTERN)];
  if (!matches.length) throw new Error("thebibliography 中没有可迁移的 bibitem 条目。");
  return matches.map((match, index) => {
    const key = match[2].trim();
    if (!/^[a-z0-9_:.+/-]+$/i.test(key)) throw new Error(`无法安全迁移引用键：${key}`);
    const text = stripLatexComments(body.slice(match.index + match[0].length, matches[index + 1]?.index ?? body.length));
    if (!text) throw new Error(`参考文献 ${key} 没有可迁移的内容。`);
    return { key, label: String(match[1] || "").trim(), text };
  });
}

function collectCitedKeys(content) {
  const keys = [];
  for (const match of content.matchAll(/\\cite\w*(?:\s*\[[^\]]*\]){0,2}\s*\{([^{}]+)\}/g)) {
    keys.push(...match[1].split(",").map((key) => key.trim()).filter(Boolean));
  }
  return new Set(keys);
}

function inferBibliographyStyle(content) {
  const existing = /\\bibliographystyle\s*\{([^{}]+)\}/.exec(content)?.[1]?.trim();
  if (existing) return existing;
  if (/\\documentclass(?:\[[^\]]*\])?\s*\{IEEEtran\}/i.test(content)) return "IEEEtran";
  if (/\\documentclass(?:\[[^\]]*\])?\s*\{acmart\}/i.test(content)) return "ACM-Reference-Format";
  return "plain";
}

function uniqueGeneratedBib(mainTex, existingFiles) {
  const directory = path.posix.dirname(String(mainTex).replaceAll("\\", "/"));
  const located = (name) => directory === "." ? name : path.posix.join(directory, name);
  const reserved = new Set(existingFiles.map((file) => String(file).replaceAll("\\", "/").toLowerCase()));
  let candidate = located("references.bib");
  let suffix = 2;
  while (reserved.has(candidate.toLowerCase())) {
    candidate = located(`references_${suffix}.bib`);
    suffix += 1;
  }
  return candidate;
}

function renderOpaqueBibEntry(entry) {
  return [
    `@misc{${entry.key},`,
    `  note = {{${entry.text}}}`,
    "}"
  ].join("\n");
}

function bibliographyReference(file) {
  return file.replace(/\.bib$/i, "");
}

function normalizeBibReference(value) {
  const prepared = String(value || "").trim();
  return normalizeBibPath(prepared.toLowerCase().endsWith(".bib") ? prepared : `${prepared}.bib`);
}

function appendBibliographyTargets(content, files, uncitedKeys, style, markerPresent) {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const nocite = uncitedKeys.length ? `\\nocite{${uncitedKeys.join(",")}}` : "";
  const biblatex = /\\(?:addbibresource|printbibliography)\b|\\usepackage(?:\[[^\]]*\])?\s*\{biblatex\}/.test(content);
  let next = content;

  if (biblatex) {
    const existing = new Set([...next.matchAll(/\\addbibresource(?:\[[^\]]*\])?\s*\{([^{}]+)\}/g)]
      .map((match) => normalizeBibReference(match[1]).toLowerCase()));
    const additions = files.filter((file) => !existing.has(file.toLowerCase())).map((file) => `\\addbibresource{${file}}`);
    if (additions.length) next = next.replace(/\\begin\s*\{document\}/, `${additions.join(eol)}${eol}\\begin{document}`);
    const replacement = [nocite, /\\printbibliography\b/.test(next) ? "" : "\\printbibliography"].filter(Boolean).join(eol);
    return next.replace(BIBLIOGRAPHY_MARKER, replacement);
  }

  const bibliographyPattern = /\\bibliography\s*\{([^{}]+)\}/;
  const bibliographyMatch = bibliographyPattern.exec(next);
  if (bibliographyMatch) {
    const referenced = bibliographyMatch[1].split(",").map((item) => item.trim()).filter(Boolean);
    const known = new Set(referenced.map((item) => normalizeBibReference(item).toLowerCase()));
    for (const file of files) {
      if (!known.has(file.toLowerCase())) referenced.push(bibliographyReference(file));
    }
    const replacement = [nocite, `\\bibliography{${referenced.join(",")}}`].filter(Boolean).join(eol);
    next = next.replace(bibliographyPattern, replacement);
    return next.replace(BIBLIOGRAPHY_MARKER, "");
  }

  const commands = [
    /\\bibliographystyle\s*\{[^{}]+\}/.test(next) ? "" : `\\bibliographystyle{${style}}`,
    nocite,
    `\\bibliography{${files.map(bibliographyReference).join(",")}}`
  ].filter(Boolean).join(eol);
  if (markerPresent) return next.replace(BIBLIOGRAPHY_MARKER, commands);
  return next.replace(/\\end\s*\{document\}/, `${commands}${eol}\\end{document}`);
}

export function buildBibliographyMigrationPlan(content, mainTex, existingFiles = []) {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const extractedFiles = [];
  const entries = [];
  const seenKeys = new Set();
  let markerPresent = false;

  let mainContent = content.replace(FILECONTENTS_PATTERN, (_full, file, body) => {
    const normalized = normalizeBibPath(file);
    if (existingFiles.some((item) => String(item).replaceAll("\\", "/").toLowerCase() === normalized.toLowerCase())) {
      throw new Error(`内嵌 Bib 的目标文件已经存在，拒绝覆盖：${normalized}`);
    }
    if (extractedFiles.some((item) => item.file.toLowerCase() === normalized.toLowerCase())) {
      throw new Error(`检测到重复的内嵌 Bib 文件：${normalized}`);
    }
    const bibContent = String(body || "").trim();
    if (!bibContent) throw new Error(`内嵌 Bib 文件为空：${normalized}`);
    extractedFiles.push({ file: normalized, content: `${bibContent}${eol}`, source: "filecontents", entries: [] });
    return "";
  });

  mainContent = mainContent.replace(THEBIBLIOGRAPHY_PATTERN, (_full, body) => {
    for (const entry of parseBibitems(body)) {
      if (seenKeys.has(entry.key)) throw new Error(`检测到重复引用键：${entry.key}`);
      seenKeys.add(entry.key);
      entries.push(entry);
    }
    if (!markerPresent) {
      markerPresent = true;
      return BIBLIOGRAPHY_MARKER;
    }
    return "";
  });

  if (!extractedFiles.length && !entries.length) {
    return { eligible: false, mode: "none", reason: "主文件中没有可迁移的内嵌参考文献。", mainTex, files: [], entries: [] };
  }
  if (entries.length) {
    const file = uniqueGeneratedBib(mainTex, [...existingFiles, ...extractedFiles.map((item) => item.file)]);
    extractedFiles.push({
      file,
      content: `${entries.map(renderOpaqueBibEntry).join(`${eol}${eol}`)}${eol}`,
      source: "thebibliography",
      entries: entries.map((entry) => entry.key)
    });
  }

  const cited = collectCitedKeys(content);
  const uncitedKeys = entries.map((entry) => entry.key).filter((key) => !cited.has(key));
  const style = inferBibliographyStyle(content);
  mainContent = appendBibliographyTargets(
    mainContent,
    extractedFiles.map((item) => item.file),
    uncitedKeys,
    style,
    markerPresent
  );
  const warnings = entries.some((entry) => entry.label)
    ? ["检测到自定义 bibitem 标签；迁移后编号或作者年份标签将由 bibliography style 重新生成。"]
    : [];
  return {
    eligible: true,
    mode: "inline",
    reason: "",
    mainTex,
    mainContent,
    style,
    files: extractedFiles,
    entries,
    uncitedKeys,
    warnings
  };
}

async function projectDirectoryFiles(projectRoot, mainTex) {
  const mainPath = await resolveProjectFile(projectRoot, mainTex);
  const directory = path.posix.dirname(String(mainTex).replaceAll("\\", "/"));
  return (await fs.readdir(path.dirname(mainPath), { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => directory === "." ? entry.name : path.posix.join(directory, entry.name));
}

export async function previewProjectBibliographyMigration(projectRoot, mainTex) {
  const root = path.resolve(projectRoot);
  const texFiles = await discoverTexFiles(root, mainTex);
  const inlineFiles = [];
  for (const file of texFiles) {
    const content = await fs.readFile(await resolveProjectFile(root, file), "utf8");
    if (THEBIBLIOGRAPHY_PATTERN.test(content) || FILECONTENTS_PATTERN.test(content)) inlineFiles.push(file);
    THEBIBLIOGRAPHY_PATTERN.lastIndex = 0;
    FILECONTENTS_PATTERN.lastIndex = 0;
  }
  if (!inlineFiles.includes(mainTex)) {
    return {
      eligible: false,
      mode: inlineFiles.length ? "included-file" : "none",
      reason: inlineFiles.length
        ? `内嵌参考文献位于章节文件中，请先在 TeX 编辑器中处理：${inlineFiles.join("、")}`
        : "主文件中没有可迁移的内嵌参考文献。",
      mainTex,
      files: [],
      entries: []
    };
  }
  try {
    const mainPath = await resolveProjectFile(root, mainTex);
    const content = await fs.readFile(mainPath, "utf8");
    const existingFiles = await projectDirectoryFiles(root, mainTex);
    const plan = buildBibliographyMigrationPlan(content, mainTex, existingFiles);
    return {
      eligible: plan.eligible,
      mode: plan.mode,
      reason: plan.reason,
      mainTex,
      style: plan.style,
      files: plan.files.map((file) => ({ file: file.file, source: file.source, entries: file.entries.length })),
      entries: plan.entries.map((entry) => ({ key: entry.key, label: entry.label })),
      uncitedKeys: plan.uncitedKeys,
      warnings: plan.warnings,
      fingerprint: fingerprint(JSON.stringify([path.resolve(root), mainTex, content, existingFiles.sort()]))
    };
  } catch (error) {
    return { eligible: false, mode: "unsupported", reason: error.message, mainTex, files: [], entries: [] };
  }
}

async function atomicReplace(target, content) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content, "utf8");
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function assertNewBibFile(projectRoot, file) {
  const normalized = normalizeBibPath(file);
  const root = path.resolve(projectRoot);
  const target = path.resolve(root, normalized);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Bib 文件超出项目目录：${file}`);
  const [realRoot, realParent] = await Promise.all([fs.realpath(root), fs.realpath(path.dirname(target))]);
  const realRelative = path.relative(realRoot, realParent);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) throw new Error(`Bib 文件超出项目目录：${file}`);
  await fs.lstat(target).then(() => {
    throw new Error(`Bib 文件已经存在，拒绝覆盖：${file}`);
  }).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  return target;
}

export async function applyProjectBibliographyMigration({
  projectRoot,
  mainTex,
  expectedFingerprint,
  backupRoot,
  compile = compileProject,
  afterApply = async () => {}
}) {
  const root = path.resolve(projectRoot);
  const mainPath = await resolveProjectFile(root, mainTex);
  const original = await fs.readFile(mainPath, "utf8");
  const existingFiles = await projectDirectoryFiles(root, mainTex);
  const preview = await previewProjectBibliographyMigration(root, mainTex);
  if (!preview.eligible) throw new Error(preview.reason);
  if (!expectedFingerprint || preview.fingerprint !== expectedFingerprint) {
    const error = new Error("主 TeX 文件在预览后发生了变化，请重新检查参考文献迁移。");
    error.code = "SOURCE_CHANGED";
    throw error;
  }
  const plan = buildBibliographyMigrationPlan(original, mainTex, existingFiles);
  const created = [];
  await fs.mkdir(backupRoot, { recursive: true });
  await fs.writeFile(path.join(backupRoot, path.basename(mainTex)), original, "utf8");
  await fs.writeFile(path.join(backupRoot, "manifest.json"), `${JSON.stringify({
    mainTex,
    createdFiles: plan.files.map((file) => file.file),
    citationKeys: plan.entries.map((entry) => entry.key),
    createdAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");

  try {
    for (const file of plan.files) {
      const target = await assertNewBibFile(root, file.file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await atomicReplace(target, file.content);
      created.push(file.file);
    }
    await atomicReplace(mainPath, plan.mainContent);
    const build = await compile(root, mainTex);
    if (!build.success) {
      const error = new Error("参考文献迁移后未能成功编译，原文件已自动恢复。");
      error.code = "BIBLIOGRAPHY_MIGRATION_COMPILE_FAILED";
      error.details = build;
      throw error;
    }
    await afterApply({ plan, build });
    return {
      mainTex,
      files: plan.files.map((file) => ({ file: file.file, source: file.source, entries: file.entries.length })),
      entries: plan.entries.map((entry) => entry.key),
      warnings: plan.warnings,
      backupRoot,
      build
    };
  } catch (error) {
    await atomicReplace(mainPath, original).catch(() => {});
    await Promise.all(created.map((file) => fs.rm(path.resolve(root, file), { force: true })));
    throw error;
  }
}
