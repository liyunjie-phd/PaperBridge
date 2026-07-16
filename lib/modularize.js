import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { discoverTexFiles, inspectBibliographyFiles, resolveProjectFile } from "./latex.js";
import { compileProject } from "./project.js";

function fingerprint(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function readBracedArgument(content, start) {
  const open = content.indexOf("{", start);
  if (open < 0) return "";
  let depth = 0;
  for (let index = open; index < content.length; index += 1) {
    if (content[index] === "\\") {
      index += 1;
      continue;
    }
    if (content[index] === "{") depth += 1;
    if (content[index] === "}") {
      depth -= 1;
      if (depth === 0) return content.slice(open + 1, index);
    }
  }
  return "";
}

function plainSectionTitle(value) {
  return String(value || "")
    .replace(/\\(?:texorpdfstring|textbf|textit|emph)\s*\{([^{}]*)\}(?:\{[^{}]*\})?/g, "$1")
    .replace(/\\[A-Za-z@]+\*?/g, " ")
    .replace(/[{}~]/g, " ")
    .replace(/\\&/g, " and ")
    .replace(/\s+/g, " ")
    .trim();
}

function sectionSlug(title, index) {
  const aliases = new Map([
    ["related works", "related_work"],
    ["literature review", "related_work"],
    ["conclusions", "conclusion"],
    ["experimental evaluation", "evaluation"]
  ]);
  const normalized = plainSectionTitle(title).toLowerCase();
  const slug = aliases.get(normalized) || normalized
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return slug || `section_${String(index + 1).padStart(2, "0")}`;
}

function uniqueSectionFile(title, index, reserved, directory) {
  const base = sectionSlug(title, index);
  const located = (name) => directory === "." ? name : path.posix.join(directory, name);
  let candidate = located(`${base}.tex`);
  let suffix = 2;
  while (reserved.has(candidate.toLowerCase())) {
    candidate = located(`${base}_${suffix}.tex`);
    suffix += 1;
  }
  reserved.add(candidate.toLowerCase());
  return candidate;
}

function documentBounds(content) {
  const beginMatch = /\\begin\s*\{document\}/.exec(content);
  if (!beginMatch) return null;
  const endPattern = /\\end\s*\{document\}/g;
  let endMatch = null;
  endPattern.lastIndex = beginMatch.index + beginMatch[0].length;
  for (const match of content.matchAll(endPattern)) endMatch = match;
  if (!endMatch) return null;
  return {
    bodyStart: beginMatch.index + beginMatch[0].length,
    bodyEnd: endMatch.index
  };
}

function sectionStarts(content, bounds) {
  const starts = [];
  const pattern = /^[ \t]*\\section\*?(?=\s*(?:\[[^\]\r\n]*\]\s*)?\{)/gm;
  for (const match of content.matchAll(pattern)) {
    if (match.index <= bounds.bodyStart || match.index >= bounds.bodyEnd) continue;
    starts.push({ start: match.index, title: plainSectionTitle(readBracedArgument(content, match.index)) });
  }
  return starts;
}

function bibliographyTailStart(content, start, end) {
  const tail = content.slice(start, end);
  const match = /^[ \t]*\\(?:bibliographystyle|bibliography|printbibliography)\b/m.exec(tail);
  return match ? start + match.index : end;
}

export function buildModularizationPlan(content, mainTex, existingFiles = []) {
  const bounds = documentBounds(content);
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  if (!bounds) {
    return { eligible: false, mode: "unsupported", reason: "主文件缺少完整的 document 环境。", mainTex, sections: [] };
  }
  const starts = sectionStarts(content, bounds);
  if (!starts.length) {
    const modular = /\\(?:input|include)\s*\{[^}]+\}/.test(content.slice(bounds.bodyStart, bounds.bodyEnd));
    return {
      eligible: false,
      mode: modular ? "modular" : "unsupported",
      reason: modular ? "当前主文件已经使用 input/include 管理章节。" : "主文件中没有可拆分的顶层 section。",
      mainTex,
      sections: []
    };
  }

  const reserved = new Set(existingFiles.map((file) => String(file).replaceAll("\\", "/").toLowerCase()));
  const normalizedMain = String(mainTex).replaceAll("\\", "/");
  const mainDirectory = path.posix.dirname(normalizedMain);
  reserved.add(normalizedMain.toLowerCase());
  const tailStart = bibliographyTailStart(content, starts.at(-1).start, bounds.bodyEnd);
  const sections = starts.map((item, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].start : tailStart;
    const sectionContent = content.slice(item.start, end).trim();
    return {
      index,
      title: item.title || `Section ${index + 1}`,
      file: uniqueSectionFile(item.title, index, reserved, mainDirectory),
      startLine: content.slice(0, item.start).split(/\r?\n/).length,
      endLine: content.slice(0, end).split(/\r?\n/).length,
      characters: sectionContent.length,
      content: `${sectionContent}${eol}`
    };
  });
  const prefix = content.slice(0, starts[0].start).trimEnd();
  const suffix = content.slice(tailStart).trimStart();
  const inputs = sections.map((section) => {
    const relative = mainDirectory === "." ? section.file : path.posix.relative(mainDirectory, section.file);
    return `\\input{${relative.replace(/\.tex$/i, "")}}`;
  }).join(eol);
  const mainContent = `${prefix}${eol}${eol}${inputs}${suffix ? `${eol}${eol}${suffix}` : eol}`;
  return {
    eligible: true,
    mode: "monolithic",
    reason: "",
    mainTex,
    eol,
    mainContent,
    mainBeforeCharacters: content.length,
    mainAfterCharacters: mainContent.length,
    sections
  };
}

export async function previewProjectModularization(projectRoot, mainTex) {
  const root = path.resolve(projectRoot);
  const mainPath = await resolveProjectFile(root, mainTex);
  const mainDirectory = path.posix.dirname(String(mainTex).replaceAll("\\", "/"));
  const [content, entries, bibliography, texFiles] = await Promise.all([
    fs.readFile(mainPath, "utf8"),
    fs.readdir(path.dirname(mainPath), { withFileTypes: true }),
    inspectBibliographyFiles(root, mainTex),
    discoverTexFiles(root, mainTex)
  ]);
  const existingFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => mainDirectory === "." ? entry.name : path.posix.join(mainDirectory, entry.name));
  const plan = buildModularizationPlan(content, mainTex, existingFiles);
  const { mainContent: _mainContent, sections, ...publicPlan } = plan;
  const bibliographyBlocked = bibliography.inline || bibliography.missing.length > 0;
  const bibliographyReason = bibliography.inline
    ? "检测到内嵌 thebibliography 或 filecontents 文献。请先迁移为独立 .bib 文件，PaperBridge 不会进行有损自动转换。"
    : bibliography.missing.length
      ? `主文件引用的 Bib 文件不存在：${bibliography.missing.join("、")}`
      : "";
  const localFiles = sections.length ? sections.map((section) => section.file) : texFiles.filter((file) => file !== mainTex);
  return {
    ...publicPlan,
    eligible: publicPlan.eligible && !bibliographyBlocked,
    mode: bibliographyBlocked ? "bibliography-required" : publicPlan.mode,
    reason: bibliographyReason || publicPlan.reason,
    fingerprint: fingerprint(JSON.stringify([path.resolve(root), mainTex, content, existingFiles.sort()])),
    sections: sections.map(({ content: _content, ...section }) => section),
    bibliography,
    workflow: {
      global: { file: mainTex, responsibilities: ["单双栏", "字体与字号", "页边距", "宏包和 Bib 调用"] },
      local: { files: localFiles, responsibilities: ["图片", "表格", "公式", "章节内容"] },
      references: { files: bibliography.files, responsibilities: ["文献条目", "作者与题名", "DOI 和出版信息"] }
    }
  };
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

function assertNewProjectFile(projectRoot, file) {
  const normalized = String(file).replaceAll("\\", "/");
  if (!/^[a-z0-9_/-]+\.tex$/i.test(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`不安全的章节文件名：${file}`);
  }
  const target = path.resolve(projectRoot, normalized);
  const relative = path.relative(path.resolve(projectRoot), target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`章节文件超出项目目录：${file}`);
  return target;
}

export async function applyProjectModularization({
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
  const preview = await previewProjectModularization(root, mainTex);
  if (!preview.eligible) throw new Error(preview.reason);
  if (!expectedFingerprint || preview.fingerprint !== expectedFingerprint) {
    const error = new Error("主 TeX 文件在预览后发生了变化，请重新预览章节拆分。");
    error.code = "SOURCE_CHANGED";
    throw error;
  }
  const mainDirectory = path.posix.dirname(String(mainTex).replaceAll("\\", "/"));
  const plan = buildModularizationPlan(original, mainTex, (await fs.readdir(path.dirname(mainPath), { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => mainDirectory === "." ? entry.name : path.posix.join(mainDirectory, entry.name)));
  const created = [];
  await fs.mkdir(backupRoot, { recursive: true });
  await fs.writeFile(path.join(backupRoot, path.basename(mainTex)), original, "utf8");
  await fs.writeFile(path.join(backupRoot, "manifest.json"), `${JSON.stringify({
    mainTex,
    createdFiles: plan.sections.map((section) => section.file),
    createdAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");

  try {
    for (const section of plan.sections) {
      const target = assertNewProjectFile(root, section.file);
      await fs.access(target).then(() => {
        throw new Error(`章节文件已存在，拒绝覆盖：${section.file}`);
      }).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      await atomicReplace(target, section.content);
      created.push(section.file);
    }
    await atomicReplace(mainPath, plan.mainContent);
    const build = await compile(root, mainTex);
    if (!build.success) {
      const error = new Error("章节拆分后的论文未能成功编译，所有文件已自动恢复。");
      error.code = "MODULARIZATION_COMPILE_FAILED";
      error.details = build;
      throw error;
    }
    await afterApply({ plan, build });
    return {
      mainTex,
      sections: plan.sections.map(({ content: _content, ...section }) => section),
      workflow: preview.workflow,
      backupRoot,
      build
    };
  } catch (error) {
    await atomicReplace(mainPath, original).catch(() => {});
    await Promise.all(created.map((file) => fs.rm(assertNewProjectFile(root, file), { force: true })));
    throw error;
  }
}
