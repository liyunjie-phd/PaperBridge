import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { exec as execGit } from "dugite";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { discoverTexFiles, resolveProjectFile } from "./latex.js";

const execFileAsync = promisify(execFile);

let runtime = {
  askPassPath: "",
  getOverleafToken: () => "",
  getGitToken: () => "",
  getGitUsername: () => "",
  tectonicPath: ""
};

export function configureProjectRuntime(next = {}) {
  runtime = { ...runtime, ...next };
}

async function run(command, args, cwd, timeout = 120_000) {
  return execFileAsync(command, args, {
    cwd,
    timeout,
    windowsHide: true,
    maxBuffer: 12 * 1024 * 1024,
    encoding: "utf8"
  });
}

async function runText(command, args, cwd, timeout) {
  const result = await run(command, args, cwd, timeout);
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

async function commandAvailable(command) {
  try {
    await run(command, ["--version"], process.cwd(), 20_000);
    return true;
  } catch {
    return false;
  }
}

async function runGit(args, cwd, timeout = 120_000, token = "", username = "git") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const env = {
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      PAPERBRIDGE_GIT_TOKEN: token || "",
      PAPERBRIDGE_GIT_USERNAME: username || "git"
    };
    if (token && runtime.askPassPath) {
      env.GIT_ASKPASS = runtime.askPassPath;
      env.SSH_ASKPASS = runtime.askPassPath;
    }
    const gitArgs = token ? ["-c", "credential.helper=", ...args] : args;
    const result = await execGit(gitArgs, cwd, {
      env,
      signal: controller.signal,
      maxBuffer: 12 * 1024 * 1024
    });
    if (result.exitCode !== 0) {
      const message = `${result.stderr || ""}${result.stdout || ""}`.trim() || `Git failed with exit code ${result.exitCode}`;
      throw new Error(message);
    }
    return `${result.stdout || ""}${result.stderr || ""}`.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function runOverleafGit(args, cwd, timeout = 120_000, token = runtime.getOverleafToken()) {
  if (!String(token || "").trim()) {
    throw new Error("请在设置中填写 Overleaf Git Token。PaperBridge 会自动完成 Git 认证，无需输入密码。");
  }
  try {
    return await runGit(args, cwd, timeout, String(token).trim(), "git");
  } catch (error) {
    const accessError = describeOverleafGitError(error.message);
    if (accessError) throw new Error(accessError);
    if (/authentication failed|could not read password|access denied|invalid credentials/i.test(error.message)) {
      throw new Error("Overleaf Git Token 无效或已过期，请在设置中更新后重试。");
    }
    throw error;
  }
}

export function describeOverleafGitError(message) {
  const detail = String(message || "");
  if (/no git access|repository not found|project currently has no git access/i.test(detail)) {
    return [
      "Overleaf 拒绝了 Git 访问。可能原因是项目链接错误、项目不存在，或者项目所有者没有开通 Git 功能。",
      "Overleaf Git 是高级功能，通常需要个人订阅、团队订阅，或学校提供的 Overleaf Commons 权限。",
      "请在 Overleaf 项目菜单的 Integrations > Git 中确认是否能看到 Git 地址；如果没有该权限，可以下载项目 ZIP 后导入 PaperBridge。"
    ].join(" ");
  }
  return "";
}

async function runRepositoryGit(
  args,
  cwd,
  timeout = 120_000,
  token = runtime.getGitToken(),
  username = runtime.getGitUsername()
) {
  try {
    return await runGit(args, cwd, timeout, String(token || "").trim(), String(username || "git").trim() || "git");
  } catch (error) {
    if (/authentication failed|could not read password|access denied|invalid credentials|http basic: access denied/i.test(error.message)) {
      throw new Error("Git 仓库认证失败。请检查 HTTPS 仓库地址、Git 用户名和 Personal Access Token。");
    }
    throw error;
  }
}

async function overleafBranch(projectRoot) {
  try {
    const remoteHead = await runGit(["symbolic-ref", "--short", "refs/remotes/overleaf/HEAD"], projectRoot, 20_000, "");
    return remoteHead.replace(/^overleaf\//, "");
  } catch {
    for (const candidate of ["main", "master"]) {
      try {
        await runGit(["rev-parse", "--verify", `refs/remotes/overleaf/${candidate}`], projectRoot, 20_000, "");
        return candidate;
      } catch {
        // Try the next common Overleaf branch name.
      }
    }
    return "main";
  }
}

async function ensureGitIdentity(projectRoot) {
  try {
    await runGit(["config", "user.name"], projectRoot, 20_000, "");
  } catch {
    await runGit(["config", "user.name", os.userInfo().username || "PaperBridge User"], projectRoot, 20_000, "");
  }
  try {
    await runGit(["config", "user.email"], projectRoot, 20_000, "");
  } catch {
    const username = (os.userInfo().username || "user").replace(/[^a-z0-9._-]/gi, "-");
    await runGit(["config", "user.email", `${username}@paperbridge.local`], projectRoot, 20_000, "");
  }
}

export async function cloneOverleafProject(gitUrl, destination, token) {
  const parent = path.dirname(destination);
  await fs.mkdir(parent, { recursive: true });
  await runOverleafGit(["clone", "--origin", "overleaf", gitUrl, destination], parent, 180_000, token);
  await ensureGitIdentity(destination);
  await runGit(["config", "core.fileMode", "false"], destination, 20_000, "");
  return destination;
}

export async function cloneGitProject(gitUrl, destination, username = "", token = "") {
  const parent = path.dirname(destination);
  await fs.mkdir(parent, { recursive: true });
  await runRepositoryGit(["clone", "--origin", "origin", gitUrl, destination], parent, 180_000, token, username);
  await ensureGitIdentity(destination);
  await runGit(["config", "core.fileMode", "false"], destination, 20_000, "");
  return destination;
}

async function hasGitRepository(projectRoot) {
  return runGit(["rev-parse", "--git-dir"], projectRoot, 20_000, "").then(() => true).catch(() => false);
}

export async function connectGitRepository(projectRoot, gitUrl, username = "", token = "") {
  await runRepositoryGit(["ls-remote", gitUrl], projectRoot, 60_000, token, username);
  if (!await hasGitRepository(projectRoot)) {
    await runGit(["init", "-b", "main"], projectRoot, 30_000, "");
  }
  await ensureGitIdentity(projectRoot);
  await runGit(["config", "core.fileMode", "false"], projectRoot, 20_000, "");
  const exists = await runGit(["remote", "get-url", "paperbridge"], projectRoot, 20_000, "").then(() => true).catch(() => false);
  await runGit(exists
    ? ["remote", "set-url", "paperbridge", gitUrl]
    : ["remote", "add", "paperbridge", gitUrl], projectRoot, 20_000, "");
  return getGitStatus(projectRoot);
}

export async function configureGitLocalExcludes(projectRoot, mainTex = "") {
  const gitDirectory = (await runGit(["rev-parse", "--git-dir"], projectRoot, 20_000, "")).trim();
  const excludePath = path.resolve(projectRoot, gitDirectory, "info", "exclude");
  const startMarker = "# PaperBridge generated files";
  const endMarker = "# End PaperBridge generated files";
  let content = await fs.readFile(excludePath, "utf8").catch(() => "");
  const blockPattern = new RegExp(`${startMarker}[\\s\\S]*?${endMarker}\\r?\\n?`, "g");
  content = content.replace(blockPattern, "").trimEnd();
  const mainPdf = String(mainTex || "").replaceAll("\\", "/").replace(/\.tex$/i, ".pdf");
  const patterns = [
    "*.aux",
    "*.blg",
    "*.bcf",
    "*.fdb_latexmk",
    "*.fls",
    "*.lof",
    "*.log",
    "*.lot",
    "*.nav",
    "*.out",
    "*.run.xml",
    "*.snm",
    "*.synctex.gz",
    "*.toc",
    "*.xdv",
    ...(mainPdf ? [`/${mainPdf}`] : [])
  ];
  const block = [startMarker, ...patterns, endMarker].join("\n");
  await fs.mkdir(path.dirname(excludePath), { recursive: true });
  await fs.writeFile(excludePath, `${content ? `${content}\n` : ""}${block}\n`, "utf8");
}

export async function getDependencyStatus() {
  const latexmk = await commandAvailable("latexmk");
  const tectonic = Boolean(runtime.tectonicPath) && await fs.access(runtime.tectonicPath).then(() => true).catch(() => false);
  return {
    git: true,
    latexmk,
    tectonic,
    compiler: latexmk ? "latexmk" : tectonic ? "tectonic" : "missing"
  };
}

export async function getPdfInfo(projectRoot, mainTex) {
  const pdfPath = path.join(projectRoot, mainTex.replace(/\.tex$/i, ".pdf"));
  try {
    const stat = await fs.stat(pdfPath);
    const loadingTask = getDocument({ data: new Uint8Array(await fs.readFile(pdfPath)), disableWorker: true });
    const pdf = await loadingTask.promise;
    const pages = pdf.numPages;
    await loadingTask.destroy();
    return { exists: true, path: pdfPath, pages, size: stat.size, updatedAt: stat.mtime.toISOString() };
  } catch {
    return { exists: false, path: pdfPath, pages: 0, size: 0, updatedAt: null };
  }
}

export function collectBuildWarnings(log) {
  const warnings = [];
  const patterns = [
    /LaTeX Warning:.+/g,
    /Package \S+ Warning:.+/g,
    /Class \S+ Warning:.+/g,
    /Overfull \\hbox.+/g,
    /Underfull \\hbox.+/g,
    /Float too large.+/gi
  ];
  for (const pattern of patterns) {
    for (const match of log.matchAll(pattern)) warnings.push(match[0].trim());
  }
  return [...new Set(warnings)].slice(0, 80);
}

export function collectBuildErrors(log) {
  const errors = [];
  if (/Command \\algorithm already defined/.test(log)) {
    errors.push("算法环境重复定义：当前主 TeX 文件同时加载了会定义 algorithm 环境的宏包（常见为 algorithm 与 algorithm2e）。请确认主 TeX 文件与 Overleaf 的 Main document 一致，或仅保留实际使用的一套算法宏包。");
  }
  const patterns = [
    /LaTeX Error:.+/g,
    /Package \S+ Error:.+/g,
    /Class \S+ Error:.+/g,
    /^! (?!LaTeX Error:|Package \S+ Error:|Class \S+ Error:).+/gm,
    /^error:.+/gim,
    /Emergency stop\.?/gi,
    /Fatal error occurred.+/gi,
    /No pages of output\.?/gi
  ];
  for (const pattern of patterns) {
    for (const match of log.matchAll(pattern)) errors.push(match[0].trim());
  }
  return [...new Set(errors)].slice(0, 80);
}

export async function getFloatLayout(projectRoot, mainTex) {
  const labels = new Map();
  const files = await discoverTexFiles(projectRoot, mainTex);
  for (const file of files) {
    const content = await fs.readFile(await resolveProjectFile(projectRoot, file), "utf8");
    for (const match of content.matchAll(/\\begin\{(figure\*?|table\*?)\}([\s\S]*?)\\end\{\1\}/g)) {
      const type = match[1].startsWith("figure") ? "figure" : "table";
      for (const label of match[2].matchAll(/\\label\{([^}]+)\}/g)) {
        labels.set(label[1], { label: label[1], type, file });
      }
    }
  }

  const auxPath = path.join(projectRoot, mainTex.replace(/\.tex$/i, ".aux"));
  let aux = "";
  try {
    aux = await fs.readFile(auxPath, "utf8");
  } catch {
    return [];
  }
  for (const line of aux.split(/\r?\n/)) {
    const match = line.match(/\\newlabel\{([^}]+)\}\{\{.*?\}\{(\d+)\}/);
    if (!match || !labels.has(match[1])) continue;
    labels.get(match[1]).page = Number(match[2]);
  }
  return [...labels.values()]
    .filter((item) => item.page)
    .sort((a, b) => a.page - b.page || a.label.localeCompare(b.label));
}

async function cleanCompileArtifacts(projectRoot, mainTex, latexmkAvailable) {
  const normalizedMainTex = String(mainTex).replaceAll("\\", "/");
  const outputDirectory = path.dirname(String(mainTex).replaceAll("\\", "/"));
  const nestedOutput = outputDirectory !== ".";
  if (latexmkAvailable) {
    await runText(
      "latexmk",
      ["-C", ...(nestedOutput ? [`-outdir=${outputDirectory}`] : []), mainTex],
      projectRoot,
      60_000
    );
  }
  const generatedSuffixes = [
    ".aux", ".bbl", ".bcf", ".blg", ".brf", ".fdb_latexmk", ".fls",
    ".lof", ".log", ".lot", ".nav", ".out", ".run.xml", ".snm",
    ".spl", ".synctex.gz", ".toc", ".xdv"
  ];
  for (const file of await discoverTexFiles(projectRoot, mainTex)) {
    const stem = file.replace(/\.tex$/i, "");
    const suffixes = file === normalizedMainTex ? [...generatedSuffixes, ".pdf"] : generatedSuffixes;
    for (const suffix of suffixes) {
      const lexicalRoot = path.resolve(projectRoot);
      const target = path.resolve(lexicalRoot, `${stem}${suffix}`);
      const relative = path.relative(lexicalRoot, target);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Refusing to clean a LaTeX artifact outside the project root.");
      }
      try {
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink()) throw new Error("Symbolic links cannot be cleaned by PaperBridge.");
        const [realRoot, realTarget] = await Promise.all([fs.realpath(lexicalRoot), fs.realpath(target)]);
        const realRelative = path.relative(realRoot, realTarget);
        if (!realRelative || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
          throw new Error("Refusing to clean a LaTeX artifact outside the project root.");
        }
        await fs.rm(realTarget, { force: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
}

export async function compileProject(projectRoot, mainTex, { clean = false } = {}) {
  await resolveProjectFile(projectRoot, mainTex);
  const outputDirectory = path.dirname(String(mainTex).replaceAll("\\", "/"));
  const nestedOutput = outputDirectory !== ".";
  let output = "";
  let success = true;
  let engine = "latexmk";
  try {
    const latexmkAvailable = await commandAvailable("latexmk");
    if (clean) await cleanCompileArtifacts(projectRoot, mainTex, latexmkAvailable);
    if (latexmkAvailable) {
      output = await runText(
        "latexmk",
        [
          "-pdf",
          "-interaction=nonstopmode",
          "-halt-on-error",
          "-file-line-error",
          ...(nestedOutput ? [`-outdir=${outputDirectory}`] : []),
          mainTex
        ],
        projectRoot,
        180_000
      );
    } else if (runtime.tectonicPath && await fs.access(runtime.tectonicPath).then(() => true).catch(() => false)) {
      engine = "tectonic";
      output = await runText(
        runtime.tectonicPath,
        [
          "--keep-logs",
          "--keep-intermediates",
          "--print",
          ...(nestedOutput ? ["--outdir", outputDirectory] : []),
          mainTex
        ],
        projectRoot,
        240_000
      );
    } else {
      throw new Error("No LaTeX compiler is available. Reinstall PaperBridge or install TeX Live/MiKTeX.");
    }
  } catch (error) {
    success = false;
    output = `${error.stdout || ""}\n${error.stderr || ""}`.trim() || error.message;
  }

  const logPath = path.join(projectRoot, mainTex.replace(/\.tex$/i, ".log"));
  let log = output;
  try {
    log = await fs.readFile(logPath, "utf8");
  } catch {
    // Command output is enough when no log was produced.
  }
  const pdf = await getPdfInfo(projectRoot, mainTex);
  const errors = collectBuildErrors(log);
  const previewAvailable = success && pdf.exists && errors.length === 0;
  const floatLayout = previewAvailable ? await getFloatLayout(projectRoot, mainTex) : [];
  return {
    success: previewAvailable,
    previewAvailable,
    pdf,
    floatLayout,
    warnings: collectBuildWarnings(log),
    errors,
    engine,
    log: output.split(/\r?\n/).slice(-160).join("\n")
  };
}

async function selectedRemote(projectRoot) {
  for (const [name, provider] of [["overleaf", "overleaf"], ["paperbridge", "git"], ["origin", "git"]]) {
    try {
      const url = await runGit(["remote", "get-url", name], projectRoot, 20_000, "");
      return { name, provider, url };
    } catch {
      // Try the next supported remote name.
    }
  }
  return null;
}

function displayRemoteUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}

async function repositoryBranch(projectRoot, remoteName, preferred = "") {
  try {
    const remoteHead = await runGit(["symbolic-ref", "--short", `refs/remotes/${remoteName}/HEAD`], projectRoot, 20_000, "");
    return remoteHead.replace(new RegExp(`^${remoteName}/`), "");
  } catch {
    for (const candidate of [...new Set([preferred, "main", "master"].filter(Boolean))]) {
      try {
        await runGit(["rev-parse", "--verify", `refs/remotes/${remoteName}/${candidate}`], projectRoot, 20_000, "");
        return candidate;
      } catch {
        // Try the next likely branch name.
      }
    }
    return preferred || "main";
  }
}

export async function getGitStatus(projectRoot) {
  try {
    const branch = await runGit(["branch", "--show-current"], projectRoot, 20_000, "");
    const tracked = await runGit(["status", "--porcelain", "--untracked-files=no"], projectRoot, 20_000, "");
    const untracked = await runGit(["ls-files", "--others", "--exclude-standard"], projectRoot, 20_000, "");
    const untrackedFiles = untracked ? untracked.split(/\r?\n/).filter(Boolean) : [];
    const remote = await selectedRemote(projectRoot);
    const overleaf = remote?.provider === "overleaf";
    const includeUntracked = remote?.provider === "git";
    let ahead = 0;
    let behind = 0;
    if (remote) try {
      const remoteBranch = overleaf
        ? await overleafBranch(projectRoot)
        : await repositoryBranch(projectRoot, remote.name, branch);
      const counts = await runGit(["rev-list", "--left-right", "--count", `HEAD...${remote.name}/${remoteBranch}`], projectRoot, 20_000, "");
      [ahead, behind] = counts.split(/\s+/).map(Number);
    } catch {
      // New repositories may not have a remote branch until their first push.
    }
    return {
      available: true,
      overleaf,
      provider: remote?.provider || "none",
      remoteName: remote?.name || "",
      remoteUrl: remote ? displayRemoteUrl(remote.url) : "",
      branch,
      dirty: Boolean(tracked) || (includeUntracked && untrackedFiles.length > 0),
      changedFiles: [
        ...(tracked ? tracked.split(/\r?\n/).filter(Boolean) : []),
        ...(includeUntracked ? untrackedFiles.map((file) => `?? ${file}`) : [])
      ],
      untrackedCount: untrackedFiles.length,
      ahead,
      behind
    };
  } catch {
    return {
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
    };
  }
}

export async function pullOverleaf(projectRoot) {
  const status = await getGitStatus(projectRoot);
  if (!status.available) throw new Error("The selected project is not a Git repository.");
  if (!status.overleaf) throw new Error("The selected project does not have an Overleaf remote.");
  if (status.dirty) throw new Error("Commit or discard local tracked changes before pulling from Overleaf.");
  const remoteBranch = await overleafBranch(projectRoot);
  await runOverleafGit(["pull", "--ff-only", "overleaf", remoteBranch], projectRoot, 120_000);
  return getGitStatus(projectRoot);
}

export async function pushOverleaf(projectRoot, message) {
  const remoteBranch = await overleafBranch(projectRoot);
  await runOverleafGit(["fetch", "overleaf", remoteBranch], projectRoot, 120_000);
  const remoteOnly = Number(await runGit(["rev-list", "--count", `HEAD..overleaf/${remoteBranch}`], projectRoot, 20_000, ""));
  if (remoteOnly > 0) throw new Error("Overleaf has newer changes. Pull them before pushing.");

  await ensureGitIdentity(projectRoot);
  await runGit(["add", "-u"], projectRoot, 20_000, "");
  let hasChanges = true;
  try {
    await runGit(["diff", "--cached", "--quiet"], projectRoot, 20_000, "");
    hasChanges = false;
  } catch {
    hasChanges = true;
  }
  if (!hasChanges) return { pushed: false, status: await getGitStatus(projectRoot) };

  await runGit(["commit", "-m", message || "Update bilingual paper draft"], projectRoot, 60_000, "");
  await runOverleafGit(["push", "overleaf", `HEAD:${remoteBranch}`], projectRoot, 120_000);
  return { pushed: true, status: await getGitStatus(projectRoot) };
}

export async function pullGitRepository(projectRoot) {
  const status = await getGitStatus(projectRoot);
  if (!status.available) throw new Error("当前论文文件夹不是 Git 仓库。");
  if (status.provider !== "git" || !status.remoteName) throw new Error("当前论文没有连接 GitHub 或 GitLab 仓库。");
  if (status.dirty) throw new Error("拉取前请先推送或处理本地改动，避免覆盖尚未保存的文件。");
  await runRepositoryGit(["fetch", status.remoteName], projectRoot, 120_000);
  const remoteBranch = await repositoryBranch(projectRoot, status.remoteName, status.branch);
  const hasRemoteBranch = await runGit(
    ["rev-parse", "--verify", `refs/remotes/${status.remoteName}/${remoteBranch}`],
    projectRoot,
    20_000,
    ""
  ).then(() => true).catch(() => false);
  if (!hasRemoteBranch) throw new Error("远端仓库还没有可拉取的分支，请先完成首次推送。");
  try {
    await runRepositoryGit(["pull", "--ff-only", status.remoteName, remoteBranch], projectRoot, 120_000);
  } catch (error) {
    if (/not possible to fast-forward|divergent|unrelated histories/i.test(error.message)) {
      throw new Error("本地与远端提交历史已经分叉，PaperBridge 不会自动合并。请先使用 Git 客户端处理冲突。");
    }
    throw error;
  }
  return getGitStatus(projectRoot);
}

const gitUploadExtensions = new Set([
  ".bbx",
  ".bib",
  ".bst",
  ".cbx",
  ".cfg",
  ".cls",
  ".def",
  ".eps",
  ".jpeg",
  ".jpg",
  ".lbx",
  ".pdf",
  ".png",
  ".sty",
  ".svg",
  ".tex"
]);

function splitNullList(value) {
  return String(value || "").split("\0").filter((item) => item.length > 0);
}

function recommendedGitFile(file) {
  const normalized = file.replaceAll("\\", "/");
  return path.basename(normalized).toLowerCase() === ".latexmkrc"
    || gitUploadExtensions.has(path.extname(normalized).toLowerCase());
}

export async function getGitPushPreview(projectRoot) {
  const status = await getGitStatus(projectRoot);
  if (!status.available || status.provider !== "git" || !status.remoteName) {
    return { required: false, files: [] };
  }
  const [unstaged, staged, untracked, hasLocalHead, upstream] = await Promise.all([
    runGit(["diff", "--name-only", "-z"], projectRoot, 20_000, ""),
    runGit(["diff", "--cached", "--name-only", "-z"], projectRoot, 20_000, ""),
    runGit(["ls-files", "--others", "--exclude-standard", "-z"], projectRoot, 20_000, ""),
    runGit(["rev-parse", "--verify", "HEAD"], projectRoot, 20_000, "").then(() => true).catch(() => false),
    runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], projectRoot, 20_000, "")
      .catch(() => "")
  ]);
  const hasSelectedUpstream = upstream.startsWith(`${status.remoteName}/`);
  const required = !hasLocalHead || !hasSelectedUpstream;
  const untrackedFiles = new Set(splitNullList(untracked));
  const committedFiles = required && hasLocalHead
    ? new Set(splitNullList(await runGit(["ls-tree", "-r", "--name-only", "-z", "HEAD"], projectRoot, 20_000, "")))
    : new Set();
  const files = [...new Set([
    ...committedFiles,
    ...splitNullList(unstaged),
    ...splitNullList(staged),
    ...untrackedFiles
  ])].sort().map((file) => ({
    file,
    committed: committedFiles.has(file),
    tracked: !untrackedFiles.has(file),
    recommended: committedFiles.has(file) || recommendedGitFile(file)
  }));
  return { required, files };
}

export async function pushGitRepository(projectRoot, message, options = {}) {
  const status = await getGitStatus(projectRoot);
  if (!status.available) throw new Error("当前论文文件夹不是 Git 仓库。");
  if (status.provider !== "git" || !status.remoteName) throw new Error("当前论文没有连接 GitHub 或 GitLab 仓库。");
  await runRepositoryGit(["fetch", status.remoteName], projectRoot, 120_000);
  const remoteBranch = await repositoryBranch(projectRoot, status.remoteName, status.branch || "main");
  const remoteRef = `refs/remotes/${status.remoteName}/${remoteBranch}`;
  const hasRemoteBranch = await runGit(["rev-parse", "--verify", remoteRef], projectRoot, 20_000, "")
    .then(() => true).catch(() => false);
  let hasLocalHead = await runGit(["rev-parse", "--verify", "HEAD"], projectRoot, 20_000, "")
    .then(() => true).catch(() => false);

  if (hasRemoteBranch) {
    if (!hasLocalHead) {
      throw new Error("远端仓库已经有内容，不能用本地 ZIP 或文件夹直接覆盖。请改用“Git 仓库”方式克隆后再修改。");
    }
    const related = await runGit(["merge-base", "HEAD", remoteRef], projectRoot, 20_000, "")
      .then(() => true).catch(() => false);
    if (!related) {
      throw new Error("本地项目与远端仓库没有共同提交历史，PaperBridge 已拒绝覆盖远端内容。请使用空仓库，或先克隆远端仓库。");
    }
    const remoteOnly = Number(await runGit(["rev-list", "--count", `HEAD..${remoteRef}`], projectRoot, 20_000, ""));
    if (remoteOnly > 0) throw new Error("远端仓库有更新，请先拉取后再推送。");
  }

  await ensureGitIdentity(projectRoot);
  const preview = await getGitPushPreview(projectRoot);
  if (preview.required) {
    if (options.confirmed !== true) {
      const error = new Error("首次推送前需要确认上传文件。");
      error.status = 409;
      error.code = "GIT_PUSH_CONFIRMATION_REQUIRED";
      error.details = preview;
      throw error;
    }
    const available = new Set(preview.files.map((item) => item.file));
    const selected = [...new Set((options.files || []).map(String))].filter((file) => available.has(file));
    if (!selected.length) throw new Error("请至少选择一个需要上传的论文文件。");
    const missingCommitted = preview.files
      .filter((item) => item.committed && !selected.includes(item.file))
      .map((item) => item.file);
    if (missingCommitted.length) {
      const error = new Error("已有 Git 提交中的文件会随历史记录完整推送，不能从首次推送中排除。");
      error.code = "COMMITTED_FILES_REQUIRED";
      error.details = { files: missingCommitted };
      throw error;
    }
    const alreadyStaged = splitNullList(await runGit(["diff", "--cached", "--name-only", "-z"], projectRoot, 20_000, ""));
    const unexpectedStaged = alreadyStaged.filter((file) => !selected.includes(file));
    if (unexpectedStaged.length) {
      const error = new Error("Git 中已有未确认的暂存文件，请先使用 Git 客户端处理后重试。");
      error.code = "UNCONFIRMED_STAGED_FILES";
      error.details = { files: unexpectedStaged };
      throw error;
    }
    for (let offset = 0; offset < selected.length; offset += 80) {
      await runGit(["add", "--all", "--", ...selected.slice(offset, offset + 80)], projectRoot, 30_000, "");
    }
  } else {
    await runGit(["add", "--all"], projectRoot, 30_000, "");
  }
  const hasChanges = await runGit(["diff", "--cached", "--quiet"], projectRoot, 20_000, "")
    .then(() => false).catch(() => true);
  if (hasChanges) {
    await runGit(["commit", "-m", message || "Update paper with PaperBridge"], projectRoot, 60_000, "");
    hasLocalHead = true;
  }
  if (!hasLocalHead) throw new Error("没有可提交的论文文件。");

  const hasUnpushedCommits = !hasRemoteBranch || Number(
    await runGit(["rev-list", "--count", `${remoteRef}..HEAD`], projectRoot, 20_000, "")
  ) > 0;
  if (!hasUnpushedCommits) return { pushed: false, status: await getGitStatus(projectRoot) };

  await runRepositoryGit(["push", "-u", status.remoteName, `HEAD:${remoteBranch}`], projectRoot, 120_000);
  return { pushed: true, status: await getGitStatus(projectRoot) };
}

export async function pullProject(projectRoot) {
  const status = await getGitStatus(projectRoot);
  return status.overleaf ? pullOverleaf(projectRoot) : pullGitRepository(projectRoot);
}

export async function pushProject(projectRoot, message, options = {}) {
  const status = await getGitStatus(projectRoot);
  return status.overleaf ? pushOverleaf(projectRoot, message) : pushGitRepository(projectRoot, message, options);
}
