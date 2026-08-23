import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveEmbeddedGitDir } from "dugite";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { discoverTexFiles, resolveProjectFile } from "./latex.js";

const execFileAsync = promisify(execFile);
const commandAvailability = new Map();
let gitRuntimePromise = null;

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
  if (!commandAvailability.has(command)) {
    commandAvailability.set(command, run(command, ["--version"], process.cwd(), 20_000)
      .then(() => true)
      .catch(() => false));
  }
  return commandAvailability.get(command);
}

function gitExecutableForRoot(root) {
  return process.platform === "win32"
    ? path.join(root, "cmd", "git.exe")
    : path.join(root, "bin", "git");
}

function gitEnvironmentForRoot(root) {
  if (process.platform === "win32") {
    const mingw = process.arch === "arm64" ? "clangarm64" : process.arch === "x64" ? "mingw64" : "mingw32";
    return {
      PATH: [
        path.join(root, mingw, "bin"),
        path.join(root, mingw, "usr", "bin"),
        process.env.PATH || ""
      ].filter(Boolean).join(path.delimiter),
      GIT_EXEC_PATH: path.join(root, mingw, "libexec", "git-core")
    };
  }
  return {
    PATH: [path.join(root, "bin"), process.env.PATH || ""].filter(Boolean).join(path.delimiter),
    GIT_EXEC_PATH: path.join(root, "libexec", "git-core")
  };
}

async function gitRuntimeFromRoot(root, source) {
  if (!root) return null;
  const resolvedRoot = path.resolve(root);
  const executable = gitExecutableForRoot(resolvedRoot);
  const extraEnv = gitEnvironmentForRoot(resolvedRoot);
  try {
    const result = await execFileAsync(executable, ["--version"], {
      env: { ...process.env, ...extraEnv },
      timeout: 20_000,
      windowsHide: true,
      encoding: "utf8"
    });
    return {
      available: true,
      source,
      root: resolvedRoot,
      executable,
      extraEnv,
      version: `${result.stdout || ""}${result.stderr || ""}`.trim()
    };
  } catch {
    return null;
  }
}

async function gitRuntimeFromPath(candidate, source) {
  const value = String(candidate || "").trim().replace(/^"|"$/g, "");
  if (!value) return null;
  const absolute = path.resolve(value);
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat) return null;
  if (stat.isDirectory()) return gitRuntimeFromRoot(absolute, source);
  const parent = path.dirname(absolute);
  const folder = path.basename(parent).toLowerCase();
  if (folder === "cmd" || folder === "bin") {
    const rootRuntime = await gitRuntimeFromRoot(path.dirname(parent), source);
    if (rootRuntime) return rootRuntime;
  }
  try {
    const result = await execFileAsync(absolute, ["--version"], {
      timeout: 20_000,
      windowsHide: true,
      encoding: "utf8"
    });
    return {
      available: true,
      source,
      root: parent,
      executable: absolute,
      extraEnv: {},
      version: `${result.stdout || ""}${result.stderr || ""}`.trim()
    };
  } catch {
    return null;
  }
}

async function systemGitCandidates() {
  const candidates = [];
  if (process.platform === "win32") {
    const where = await runText("where.exe", ["git"], process.cwd(), 20_000).catch(() => "");
    candidates.push(...where.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    candidates.push(
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Git") : "",
      process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Git") : "",
      process.env.LocalAppData ? path.join(process.env.LocalAppData, "Programs", "Git") : ""
    );
  } else {
    const which = await runText("which", ["git"], process.cwd(), 20_000).catch(() => "");
    candidates.push(...which.split(/\r?\n/).map((line) => line.trim()).filter(Boolean), "/usr", "/usr/local");
  }
  return [...new Set(candidates.filter(Boolean))];
}

async function resolveGitRuntime() {
  if (!gitRuntimePromise) {
    gitRuntimePromise = (async () => {
      const configured = await gitRuntimeFromPath(process.env.PAPERBRIDGE_GIT_PATH, "configured");
      if (configured) return configured;

      const bundled = await gitRuntimeFromRoot(resolveEmbeddedGitDir(), "bundled");
      if (bundled) return bundled;

      for (const candidate of await systemGitCandidates()) {
        const system = await gitRuntimeFromPath(candidate, "system");
        if (system) return system;
      }
      return { available: false, source: "missing", root: "", executable: "", extraEnv: {}, version: "" };
    })();
  }
  return gitRuntimePromise;
}

async function requireGitRuntime() {
  const git = await resolveGitRuntime();
  if (git.available) return git;
  const error = new Error([
    "未检测到可用的 Git。精简版 PaperBridge 不内置 Git；如果需要使用 Overleaf Git、GitHub、GitLab 或推送/拉取功能，请先安装 Git for Windows。",
    "安装后重新打开 PaperBridge，或将 PAPERBRIDGE_GIT_PATH 指向 Git 安装目录。ZIP、本地文件夹导入和 LaTeX 编译不受影响。"
  ].join(" "));
  error.code = "GIT_NOT_FOUND";
  throw error;
}

async function runGit(args, cwd, timeout = 120_000, token = "", username = "git") {
  const git = await requireGitRuntime();
  try {
    const env = {
      ...git.extraEnv,
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      PAPERBRIDGE_GIT_TOKEN: token || "",
      PAPERBRIDGE_GIT_USERNAME: username || "git"
    };
    if (token && runtime.askPassPath) {
      env.GIT_ASKPASS = runtime.askPassPath;
      env.SSH_ASKPASS = runtime.askPassPath;
    }
    // The bundled Windows Git can select Schannel by default. On some Windows
    // installations that backend fails before authentication with
    // SEC_E_NO_CREDENTIALS, even though the same repository works with the
    // system Git. Use Git's bundled OpenSSL backend for that runtime only.
    const transportArgs = process.platform === "win32" && git.source === "bundled"
      ? ["-c", "http.sslBackend=openssl"]
      : [];
    const gitArgs = [
      ...transportArgs,
      ...(token ? ["-c", "credential.helper="] : []),
      ...args
    ];
    const result = await execFileAsync(git.executable, gitArgs, {
      cwd,
      env: { ...process.env, ...env },
      timeout,
      windowsHide: true,
      maxBuffer: 12 * 1024 * 1024,
      encoding: "utf8"
    });
    return `${result.stdout || ""}${result.stderr || ""}`.trim();
  } catch (error) {
    const detail = `${error.stderr || ""}${error.stdout || ""}`.trim();
    throw new Error(detail || error.message || "Git 执行失败。");
  }
}

async function runOverleafGit(args, cwd, timeout = 120_000, token) {
  const selectedToken = token === undefined ? runtime.getOverleafToken(cwd, "overleaf") : token;
  if (!String(selectedToken || "").trim()) {
    throw new Error("请在设置中填写 Overleaf Git Token。PaperBridge 会自动完成 Git 认证，无需输入密码。");
  }
  try {
    return await runGit(args, cwd, timeout, String(selectedToken).trim(), "git");
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
  token,
  username
) {
  const remoteName = ["fetch", "pull", "push"].includes(args[0])
    ? String(args.slice(1).find((argument) => !String(argument).startsWith("-")) || "")
    : "";
  const selectedToken = token === undefined ? runtime.getGitToken(cwd, remoteName) : token;
  const selectedUsername = username === undefined ? runtime.getGitUsername(cwd, remoteName) : username;
  try {
    return await runGit(
      args,
      cwd,
      timeout,
      String(selectedToken || "").trim(),
      String(selectedUsername || "git").trim() || "git"
    );
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
  return getGitStatus(projectRoot, "paperbridge");
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
  const git = await resolveGitRuntime();
  return {
    git: git.available,
    gitSource: git.source,
    gitPath: git.executable,
    gitVersion: git.version,
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

export async function compileProject(projectRoot, mainTex, { clean = false, fast = false } = {}) {
  await resolveProjectFile(projectRoot, mainTex);
  const outputDirectory = path.dirname(String(mainTex).replaceAll("\\", "/"));
  const nestedOutput = outputDirectory !== ".";
  const artifactStem = path.join(projectRoot, mainTex.replace(/\.tex$/i, ""));
  const previousPdf = await getPdfInfo(projectRoot, mainTex);
  let output = "";
  let commandSucceeded = true;
  let engine = "latexmk";
  let mode = "full";
  try {
    const latexmkAvailable = await commandAvailable("latexmk");
    if (clean) await cleanCompileArtifacts(projectRoot, mainTex, latexmkAvailable);
    if (latexmkAvailable) {
      output = await runText(
        "latexmk",
        [
          "-pdf",
          "-interaction=nonstopmode",
          "-file-line-error",
          ...(nestedOutput ? [`-outdir=${outputDirectory}`] : []),
          mainTex
        ],
        projectRoot,
        180_000
      );
    } else if (runtime.tectonicPath && await fs.access(runtime.tectonicPath).then(() => true).catch(() => false)) {
      engine = "tectonic";
      const fastArtifactsReady = fast && await Promise.all([
        fs.access(`${artifactStem}.pdf`).then(() => true).catch(() => false),
        fs.access(`${artifactStem}.aux`).then(() => true).catch(() => false)
      ]).then((items) => items.every(Boolean));
      if (fastArtifactsReady) mode = "fast";
      output = await runText(
        runtime.tectonicPath,
        [
          "--keep-logs",
          "--keep-intermediates",
          ...(fastArtifactsReady ? ["--pass", "tex", "--reruns", "1"] : []),
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
    commandSucceeded = false;
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
  const pdfChanged = pdf.exists && (
    !previousPdf.exists
    || previousPdf.updatedAt !== pdf.updatedAt
    || previousPdf.size !== pdf.size
  );
  const previewAvailable = pdf.exists && (commandSucceeded || errors.length === 0 || pdfChanged);
  const buildSucceeded = commandSucceeded && previewAvailable && errors.length === 0;
  const floatLayout = previewAvailable ? await getFloatLayout(projectRoot, mainTex) : [];
  return {
    success: buildSucceeded,
    previewAvailable,
    recoverable: !buildSucceeded && previewAvailable,
    pdf,
    floatLayout,
    warnings: collectBuildWarnings(log),
    errors,
    engine,
    mode,
    log: output.split(/\r?\n/).slice(-160).join("\n")
  };
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

function remoteProvider(name, url) {
  return name === "overleaf" || /(^|[.@/])git\.overleaf\.com(?=[:/]|$)/i.test(String(url || ""))
    ? "overleaf"
    : "git";
}

function remoteServiceLabel(provider, url) {
  if (provider === "overleaf") return "Overleaf";
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("github")) return "GitHub";
    if (host.includes("gitlab")) return "GitLab";
  } catch {
    // Local remotes used for testing have no HTTP host.
  }
  return "Git 远端";
}

function remoteRepositoryLabel(url, name) {
  try {
    const parsed = new URL(url);
    const repositoryPath = decodeURIComponent(parsed.pathname).replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    if (repositoryPath) return repositoryPath;
  } catch {
    const repository = path.basename(String(url || "").replace(/[\\/]+$/, "")).replace(/\.git$/i, "");
    if (repository) return repository;
  }
  return name;
}

async function listGitRemotes(projectRoot) {
  const names = (await runGit(["remote"], projectRoot, 20_000, ""))
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
  const remotes = [];
  for (const name of names) {
    const url = await runGit(["remote", "get-url", name], projectRoot, 20_000, "").catch(() => "");
    if (!url) continue;
    const provider = remoteProvider(name, url);
    remotes.push({
      name,
      provider,
      url,
      displayUrl: displayRemoteUrl(url),
      label: remoteServiceLabel(provider, url),
      repository: remoteRepositoryLabel(url, name)
    });
  }
  const priority = (remote) => remote.name === "overleaf" ? 0 : remote.name === "paperbridge" ? 1 : remote.name === "origin" ? 2 : 3;
  return remotes.sort((left, right) => priority(left) - priority(right) || left.name.localeCompare(right.name));
}

export async function getGitRemoteConfiguration(projectRoot, preferredRemoteName = "") {
  try {
    if (!await hasGitRepository(projectRoot)) {
      return { available: false, remoteName: "", remotes: [] };
    }
    const { remote, remotes } = await selectedRemote(projectRoot, preferredRemoteName);
    return {
      available: true,
      remoteName: remote?.name || "",
      provider: remote?.provider || "none",
      remoteLabel: remote?.label || "",
      remoteRepository: remote?.repository || "",
      remotes: remotes.map(({ name, provider, displayUrl: url, label, repository }) => ({
        name,
        provider,
        url,
        label,
        repository
      }))
    };
  } catch {
    return { available: false, remoteName: "", remotes: [] };
  }
}

function normalizedRemoteName(value) {
  const name = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error("远端名称只能包含字母、数字、点、短横线和下划线。");
  }
  return name;
}

async function gitRemoteExists(projectRoot, name) {
  return runGit(["remote", "get-url", name], projectRoot, 20_000, "")
    .then(() => true)
    .catch(() => false);
}

export async function testGitRemoteConnection(projectRoot, url, provider, credential = {}) {
  const remoteUrl = String(url || "").trim();
  if (!remoteUrl) throw new Error("请填写远端仓库地址。");
  if (provider === "overleaf") {
    await runOverleafGit(["ls-remote", remoteUrl], projectRoot, 60_000, credential.token);
  } else {
    await runRepositoryGit(
      ["ls-remote", remoteUrl],
      projectRoot,
      60_000,
      credential.token,
      credential.username
    );
  }
  return { ok: true };
}

export async function upsertGitRemote(projectRoot, options = {}) {
  const name = normalizedRemoteName(options.name);
  const originalName = options.originalName ? normalizedRemoteName(options.originalName) : "";
  const url = String(options.url || "").trim();
  const provider = options.provider === "overleaf" ? "overleaf" : "git";
  await testGitRemoteConnection(projectRoot, url, provider, options.credential || {});
  if (!await hasGitRepository(projectRoot)) {
    await runGit(["init", "-b", "main"], projectRoot, 30_000, "");
  }
  await ensureGitIdentity(projectRoot);
  await runGit(["config", "core.fileMode", "false"], projectRoot, 20_000, "");
  if (originalName && originalName !== name) {
    if (!await gitRemoteExists(projectRoot, originalName)) throw new Error("需要修改的 Git 远端不存在。");
    if (await gitRemoteExists(projectRoot, name)) throw new Error(`Git 远端 ${name} 已经存在。`);
    await runGit(["remote", "rename", originalName, name], projectRoot, 20_000, "");
  }
  if (await gitRemoteExists(projectRoot, name)) {
    await runGit(["remote", "set-url", name, url], projectRoot, 20_000, "");
  } else {
    await runGit(["remote", "add", name, url], projectRoot, 20_000, "");
  }
  return getGitRemoteConfiguration(projectRoot, name);
}

export async function removeGitRemote(projectRoot, name) {
  const normalized = normalizedRemoteName(name);
  if (!await hasGitRepository(projectRoot) || !await gitRemoteExists(projectRoot, normalized)) {
    throw new Error("需要删除的 Git 远端不存在。");
  }
  await runGit(["remote", "remove", normalized], projectRoot, 20_000, "");
  return getGitRemoteConfiguration(projectRoot);
}

async function selectedRemote(projectRoot, preferredName = "") {
  const remotes = await listGitRemotes(projectRoot);
  return {
    remote: remotes.find((item) => item.name === preferredName) || remotes[0] || null,
    remotes
  };
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

export async function getGitStatus(projectRoot, preferredRemoteName = "") {
  try {
    const branch = await runGit(["branch", "--show-current"], projectRoot, 20_000, "");
    const tracked = await runGit(["status", "--porcelain", "--untracked-files=no"], projectRoot, 20_000, "");
    const untracked = await runGit(["ls-files", "--others", "--exclude-standard"], projectRoot, 20_000, "");
    const untrackedFiles = untracked ? untracked.split(/\r?\n/).filter(Boolean) : [];
    const { remote, remotes } = await selectedRemote(projectRoot, preferredRemoteName);
    const overleaf = remote?.provider === "overleaf";
    const visibleUntrackedFiles = remote?.provider === "overleaf"
      ? untrackedFiles.filter(recommendedGitFile)
      : untrackedFiles;
    const includeUntracked = remote?.provider === "git" || remote?.provider === "overleaf";
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
      remoteUrl: remote?.displayUrl || "",
      remoteLabel: remote?.label || "",
      remoteRepository: remote?.repository || "",
      remotes: remotes.map(({ name, provider, displayUrl: url, label, repository }) => ({ name, provider, url, label, repository })),
      branch,
      dirty: Boolean(tracked) || (includeUntracked && visibleUntrackedFiles.length > 0),
      changedFiles: [
        ...(tracked ? tracked.split(/\r?\n/).filter(Boolean) : []),
        ...(includeUntracked ? visibleUntrackedFiles.map((file) => `?? ${file}`) : [])
      ],
      untrackedCount: visibleUntrackedFiles.length,
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
      remoteLabel: "",
      remoteRepository: "",
      remotes: [],
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
  const status = await getGitStatus(projectRoot, "overleaf");
  if (!status.available) throw new Error("当前论文文件夹不是 Git 仓库。");
  if (!status.overleaf) throw new Error("当前论文没有连接 Overleaf Git。");
  const localTimeHints = await collectLocalFileTimeHints(projectRoot, status.changedFiles);
  await ensureGitIdentity(projectRoot);
  if (status.dirty) await commitOverleafWorkingTree(projectRoot, "Save local PaperBridge changes before pulling Overleaf");
  const remoteBranch = await overleafBranch(projectRoot);
  await fetchOverleafBranch(projectRoot, remoteBranch);
  const remoteRef = `overleaf/${remoteBranch}`;
  const remoteOnly = Number(await runGit(["rev-list", "--count", `HEAD..${remoteRef}`], projectRoot, 20_000, ""));
  if (remoteOnly > 0) {
    await mergeRemoteKeepingNewest(projectRoot, "pull", remoteRef, "Overleaf", localTimeHints, "overleaf");
  }
  return getGitStatus(projectRoot, "overleaf");
}

export async function pushOverleaf(projectRoot, message) {
  const status = await getGitStatus(projectRoot, "overleaf");
  const localTimeHints = await collectLocalFileTimeHints(projectRoot, status.changedFiles);
  const remoteBranch = await overleafBranch(projectRoot);
  await ensureGitIdentity(projectRoot);
  await commitOverleafWorkingTree(projectRoot, message || "Update bilingual paper draft");

  await fetchOverleafBranch(projectRoot, remoteBranch);
  const remoteRef = `overleaf/${remoteBranch}`;
  const remoteOnly = Number(await runGit(["rev-list", "--count", `HEAD..${remoteRef}`], projectRoot, 20_000, ""));
  if (remoteOnly > 0) {
    await mergeRemoteKeepingNewest(projectRoot, "push", remoteRef, "Overleaf", localTimeHints, "overleaf");
  }
  const hasUnpushedCommits = Number(await runGit(["rev-list", "--count", `${remoteRef}..HEAD`], projectRoot, 20_000, "")) > 0;
  if (!hasUnpushedCommits) return { pushed: false, status: await getGitStatus(projectRoot, "overleaf") };
  await runOverleafGit(["push", "overleaf", `HEAD:${remoteBranch}`], projectRoot, 120_000);
  return { pushed: true, status: await getGitStatus(projectRoot, "overleaf") };
}

export async function pullGitRepository(projectRoot, remoteName = "") {
  const status = await getGitStatus(projectRoot, remoteName);
  if (!status.available) throw new Error("当前论文文件夹不是 Git 仓库。");
  if (status.provider !== "git" || !status.remoteName) throw new Error("当前论文没有连接 GitHub 或 GitLab 仓库。");
  const localTimeHints = await collectLocalFileTimeHints(projectRoot, status.changedFiles);
  await ensureGitIdentity(projectRoot);
  if (status.dirty) await commitRepositoryWorkingTree(projectRoot, "Save local PaperBridge changes before pulling remote");
  await runRepositoryGit(["fetch", status.remoteName], projectRoot, 120_000);
  const remoteBranch = await repositoryBranch(projectRoot, status.remoteName, status.branch);
  const hasRemoteBranch = await runGit(
    ["rev-parse", "--verify", `refs/remotes/${status.remoteName}/${remoteBranch}`],
    projectRoot,
    20_000,
    ""
  ).then(() => true).catch(() => false);
  if (!hasRemoteBranch) throw new Error("远端仓库还没有可拉取的分支，请先完成首次推送。");
  const remoteRef = `${status.remoteName}/${remoteBranch}`;
  const related = await runGit(["merge-base", "HEAD", remoteRef], projectRoot, 20_000, "")
    .then(() => true).catch(() => false);
  if (!related) {
    throw new Error("本地项目与远端仓库没有共同提交历史，PaperBridge 已拒绝自动合并。请使用空仓库，或先克隆远端仓库。");
  }
  const remoteOnly = Number(await runGit(["rev-list", "--count", `HEAD..${remoteRef}`], projectRoot, 20_000, ""));
  if (remoteOnly > 0) {
    await mergeRemoteKeepingNewest(
      projectRoot,
      "pull",
      remoteRef,
      status.remoteLabel || "远端仓库",
      localTimeHints,
      status.remoteName
    );
  }
  return getGitStatus(projectRoot, status.remoteName);
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

async function stageRecommendedUntrackedFiles(projectRoot) {
  const untracked = splitNullList(await runGit(["ls-files", "--others", "--exclude-standard", "-z"], projectRoot, 20_000, ""));
  const files = untracked.filter(recommendedGitFile);
  for (let offset = 0; offset < files.length; offset += 80) {
    await runGit(["add", "--", ...files.slice(offset, offset + 80)], projectRoot, 30_000, "");
  }
  return files;
}

async function fetchOverleafBranch(projectRoot, remoteBranch) {
  await runOverleafGit(["fetch", "overleaf", `+${remoteBranch}:refs/remotes/overleaf/${remoteBranch}`], projectRoot, 120_000);
}

async function commitOverleafWorkingTree(projectRoot, message) {
  await runGit(["add", "-u"], projectRoot, 20_000, "");
  await stageRecommendedUntrackedFiles(projectRoot);
  const hasChanges = await runGit(["diff", "--cached", "--quiet"], projectRoot, 20_000, "")
    .then(() => false).catch(() => true);
  if (hasChanges) {
    await runGit(["commit", "-m", message || "Update bilingual paper draft"], projectRoot, 60_000, "");
  }
  return hasChanges;
}

async function commitRepositoryWorkingTree(projectRoot, message) {
  await runGit(["add", "--all"], projectRoot, 30_000, "");
  const hasChanges = await runGit(["diff", "--cached", "--quiet"], projectRoot, 20_000, "")
    .then(() => false).catch(() => true);
  if (hasChanges) {
    await runGit(["commit", "-m", message || "Update paper with PaperBridge"], projectRoot, 60_000, "");
  }
  return hasChanges;
}

function changedFileFromStatusLine(line) {
  const text = String(line || "");
  const candidate = text.replace(/^[ MADRCU?!]{1,2}\s+/, "").trim();
  if (!candidate) return "";
  const renamed = candidate.includes(" -> ") ? candidate.split(" -> ").at(-1) : candidate;
  return String(renamed || "").replaceAll("\\", "/");
}

async function collectLocalFileTimeHints(projectRoot, changedFiles = []) {
  const hints = new Map();
  for (const entry of changedFiles) {
    const file = changedFileFromStatusLine(entry);
    if (!file || hints.has(file)) continue;
    try {
      const absolutePath = await resolveProjectFile(projectRoot, file);
      const stat = await fs.stat(absolutePath);
      if (Number.isFinite(stat.mtimeMs)) hints.set(file, stat.mtimeMs);
    } catch {
      // Deleted files fall back to the last local Git commit timestamp.
    }
  }
  return hints;
}

function conflictSnippet(value) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (!text) return "（文件不存在或内容为空）";
  return text.length > 900 ? `${text.slice(0, 900)}\n...` : text;
}

async function fileAtRef(projectRoot, ref, file) {
  return runGit(["show", `${ref}:${file}`], projectRoot, 20_000, "").catch(() => "");
}

async function fileAuthorTimeAtRef(projectRoot, ref, file) {
  const output = await runGit(["log", "-1", "--format=%at", ref, "--", file], projectRoot, 20_000, "")
    .catch(() => "");
  const timestamp = Number(String(output || "").split(/\r?\n/).find(Boolean));
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp * 1000 : null;
}

function gitTimeIso(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : "";
}

function chooseNewestSide(localUpdatedAt, remoteUpdatedAt) {
  if (!Number.isFinite(localUpdatedAt) || !Number.isFinite(remoteUpdatedAt)) return "";
  const delta = localUpdatedAt - remoteUpdatedAt;
  if (Math.abs(delta) <= 1000) return "";
  return delta > 0 ? "local" : "remote";
}

async function newestConflictChoice(projectRoot, remoteRef, file, localTimeHints = new Map()) {
  const [localCommitTime, remoteCommitTime] = await Promise.all([
    fileAuthorTimeAtRef(projectRoot, "HEAD", file),
    fileAuthorTimeAtRef(projectRoot, remoteRef, file)
  ]);
  const localUpdatedAt = localTimeHints.get(file) || localCommitTime;
  const remoteUpdatedAt = remoteCommitTime;
  const choice = chooseNewestSide(localUpdatedAt, remoteUpdatedAt);
  return {
    file,
    choice,
    localUpdatedAt: gitTimeIso(localUpdatedAt),
    remoteUpdatedAt: gitTimeIso(remoteUpdatedAt)
  };
}

function conflictMarkerSnippet(value) {
  const lines = String(value || "").replace(/\r\n/g, "\n").split("\n");
  const chunks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith("<<<<<<<")) continue;
    const start = Math.max(0, index - 3);
    let end = index;
    while (end < lines.length && !lines[end].startsWith(">>>>>>>")) end += 1;
    end = Math.min(lines.length - 1, end + 3);
    chunks.push(lines.slice(start, end + 1).join("\n"));
    index = end;
    if (chunks.join("\n\n").length > 1400) break;
  }
  const text = chunks.join("\n\n");
  return text ? conflictSnippet(text) : "";
}

async function workingTreeConflictSnippet(projectRoot, file) {
  try {
    const absolutePath = await resolveProjectFile(projectRoot, file);
    const content = await fs.readFile(absolutePath, "utf8");
    return conflictMarkerSnippet(content);
  } catch {
    return "";
  }
}

async function gitConflictFileDetails(projectRoot, remoteRef, file, timeInfo = null) {
  const [local, remote, diffSnippet] = await Promise.all([
    fileAtRef(projectRoot, "HEAD", file),
    fileAtRef(projectRoot, remoteRef, file),
    workingTreeConflictSnippet(projectRoot, file)
  ]);
  return {
    file,
    localBytes: Buffer.byteLength(local || "", "utf8"),
    remoteBytes: Buffer.byteLength(remote || "", "utf8"),
    localSnippet: conflictSnippet(local),
    remoteSnippet: conflictSnippet(remote),
    diffSnippet,
    localUpdatedAt: timeInfo?.localUpdatedAt || "",
    remoteUpdatedAt: timeInfo?.remoteUpdatedAt || "",
    suggestedChoice: timeInfo?.choice || ""
  };
}

async function gitConflictPreview(projectRoot, operation, remoteRef, remoteLabel = "远端", files = null, autoResolvedFiles = []) {
  const rawFiles = files || splitNullList(await runGit(["diff", "--name-only", "--diff-filter=U", "-z"], projectRoot, 20_000, ""));
  const conflictFiles = rawFiles.map((item) => (typeof item === "string" ? { file: item } : item));
  const timeMap = new Map(conflictFiles.map((item) => [item.file, item]));
  return {
    operation,
    remoteLabel,
    autoResolvedFiles,
    files: await Promise.all(conflictFiles.map((item) => gitConflictFileDetails(projectRoot, remoteRef, item.file, timeMap.get(item.file))))
  };
}

async function resolveConflictsByNewestTime(projectRoot, remoteRef, localTimeHints = new Map()) {
  const conflictFiles = splitNullList(await runGit(["diff", "--name-only", "--diff-filter=U", "-z"], projectRoot, 20_000, ""));
  const autoResolvedFiles = [];
  const manualFiles = [];
  for (const file of conflictFiles) {
    const decision = await newestConflictChoice(projectRoot, remoteRef, file, localTimeHints);
    if (!decision.choice) {
      manualFiles.push(decision);
      continue;
    }
    await checkoutConflictSide(projectRoot, decision.choice === "remote" ? "--theirs" : "--ours", file);
    autoResolvedFiles.push(decision);
  }
  return { conflictFiles, autoResolvedFiles, manualFiles };
}

async function mergeRemoteKeepingNewest(
  projectRoot,
  operation,
  remoteRef,
  remoteLabel,
  localTimeHints = new Map(),
  remoteName = ""
) {
  try {
    await runGit(["merge", "--no-edit", remoteRef], projectRoot, 120_000, "");
    return { autoResolvedFiles: [] };
  } catch (originalError) {
    const resolved = await resolveConflictsByNewestTime(projectRoot, remoteRef, localTimeHints);
    if (!resolved.conflictFiles.length) {
      await runGit(["merge", "--abort"], projectRoot, 20_000, "").catch(() => {});
      throw originalError;
    }
    if (resolved.manualFiles.length) {
      const details = await gitConflictPreview(
        projectRoot,
        operation,
        remoteRef,
        remoteLabel,
        resolved.manualFiles,
        resolved.autoResolvedFiles
      );
      await runGit(["merge", "--abort"], projectRoot, 20_000, "").catch(() => {});
      const error = new Error(`${remoteLabel} 与本地修改存在冲突，PaperBridge 无法根据更新时间判断，请逐个选择保留本地版本还是 ${remoteLabel} 版本。`);
      error.status = 409;
      error.code = "GIT_SYNC_CONFLICT";
      error.details = {
        ...details,
        remoteName,
        originalError: originalError.message
      };
      throw error;
    }
    await runGit(["commit", "-m", `Merge ${remoteLabel} changes, keeping newest file versions`], projectRoot, 60_000, "");
    return { autoResolvedFiles: resolved.autoResolvedFiles };
  }
}

async function gitSyncRemoteContext(projectRoot, status) {
  if (status.overleaf) {
    const remoteBranch = await overleafBranch(projectRoot);
    await fetchOverleafBranch(projectRoot, remoteBranch);
    return {
      provider: "overleaf",
      remoteName: "overleaf",
      remoteBranch,
      remoteRef: `overleaf/${remoteBranch}`,
      remoteLabel: "Overleaf"
    };
  }
  if (status.provider === "git" && status.remoteName) {
    await runRepositoryGit(["fetch", status.remoteName], projectRoot, 120_000);
    const remoteBranch = await repositoryBranch(projectRoot, status.remoteName, status.branch || "main");
    return {
      provider: "git",
      remoteName: status.remoteName,
      remoteBranch,
      remoteRef: `${status.remoteName}/${remoteBranch}`,
      remoteLabel: status.remoteLabel || "远端仓库"
    };
  }
  throw new Error("当前论文没有连接可同步的 Git 远端仓库。");
}

async function throwGitSyncConflict(projectRoot, operation, remoteRef, remoteLabel, originalError) {
  const details = await gitConflictPreview(projectRoot, operation, remoteRef, remoteLabel);
  await runGit(["merge", "--abort"], projectRoot, 20_000, "").catch(() => {});
  const error = new Error(`${remoteLabel} 与本地修改存在冲突，请逐个选择保留本地版本还是 ${remoteLabel} 版本。`);
  error.status = 409;
  error.code = "GIT_SYNC_CONFLICT";
  error.details = {
    ...details,
    originalError: originalError.message
  };
  throw error;
}

async function checkoutConflictSide(projectRoot, side, file) {
  try {
    await runGit(["checkout", side, "--", file], projectRoot, 20_000, "");
  } catch (error) {
    if (/does not have (their|our) version|path .* does not have/i.test(error.message)) {
      await runGit(["rm", "-f", "--", file], projectRoot, 20_000, "");
      return;
    }
    throw error;
  }
  await runGit(["add", "--all", "--", file], projectRoot, 20_000, "");
}

export async function resolveGitSyncConflict(projectRoot, operation, choices = [], message = "", remoteName = "") {
  const status = await getGitStatus(projectRoot, remoteName);
  if (!status.available) throw new Error("当前论文文件夹不是 Git 仓库。");
  if (!status.overleaf && (status.provider !== "git" || !status.remoteName)) {
    throw new Error("当前论文没有连接可同步的 Git 远端仓库。");
  }
  const normalizedOperation = operation === "push" ? "push" : "pull";
  const localTimeHints = await collectLocalFileTimeHints(projectRoot, status.changedFiles);
  await ensureGitIdentity(projectRoot);
  if (status.overleaf) {
    await commitOverleafWorkingTree(projectRoot, message || "Save local PaperBridge changes before resolving conflict");
  } else {
    await commitRepositoryWorkingTree(projectRoot, message || "Save local PaperBridge changes before resolving conflict");
  }
  const remote = await gitSyncRemoteContext(projectRoot, status);
  const choiceMap = new Map((choices || []).map((item) => [
    String(item.file || ""),
    item.choice === "remote" ? "remote" : "local"
  ]));

  let mergeStarted = false;
  try {
    await runGit(["merge", "--no-edit", remote.remoteRef], projectRoot, 120_000, "");
  } catch {
    mergeStarted = true;
    const resolved = await resolveConflictsByNewestTime(projectRoot, remote.remoteRef, localTimeHints);
    const manualFiles = resolved.manualFiles.map((item) => item.file);
    const missing = manualFiles.filter((file) => !choiceMap.has(file));
    if (missing.length) {
      const error = new Error(`请为每个冲突文件选择保留本地版本或 ${remote.remoteLabel} 版本。`);
      error.status = 409;
      error.code = "GIT_SYNC_CONFLICT";
      error.details = await gitConflictPreview(
        projectRoot,
        normalizedOperation,
        remote.remoteRef,
        remote.remoteLabel,
        resolved.manualFiles,
        resolved.autoResolvedFiles
      );
      throw error;
    }
    for (const file of manualFiles) {
      await checkoutConflictSide(projectRoot, choiceMap.get(file) === "remote" ? "--theirs" : "--ours", file);
    }
    await runGit(["commit", "-m", "Resolve Git conflict with PaperBridge choices"], projectRoot, 60_000, "");
    mergeStarted = false;
  } finally {
    if (mergeStarted) await runGit(["merge", "--abort"], projectRoot, 20_000, "").catch(() => {});
  }

  if (normalizedOperation === "push") {
    const hasUnpushedCommits = Number(await runGit(["rev-list", "--count", `${remote.remoteRef}..HEAD`], projectRoot, 20_000, "")) > 0;
    if (hasUnpushedCommits) {
      if (remote.provider === "overleaf") {
        await runOverleafGit(["push", "overleaf", `HEAD:${remote.remoteBranch}`], projectRoot, 120_000);
      } else {
        await runRepositoryGit(["push", "-u", remote.remoteName, `HEAD:${remote.remoteBranch}`], projectRoot, 120_000);
      }
    }
    return { resolved: true, pushed: hasUnpushedCommits, status: await getGitStatus(projectRoot, status.remoteName) };
  }
  return { resolved: true, pushed: false, status: await getGitStatus(projectRoot, status.remoteName) };
}

export async function getGitPushPreview(projectRoot, remoteName = "") {
  const status = await getGitStatus(projectRoot, remoteName);
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
  const status = await getGitStatus(projectRoot, String(options.remoteName || ""));
  if (!status.available) throw new Error("当前论文文件夹不是 Git 仓库。");
  if (status.provider !== "git" || !status.remoteName) throw new Error("当前论文没有连接 GitHub 或 GitLab 仓库。");
  const localTimeHints = await collectLocalFileTimeHints(projectRoot, status.changedFiles);
  await runRepositoryGit(["fetch", status.remoteName], projectRoot, 120_000);
  const remoteBranch = await repositoryBranch(projectRoot, status.remoteName, status.branch || "main");
  const remoteRef = `${status.remoteName}/${remoteBranch}`;
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
  }

  await ensureGitIdentity(projectRoot);
  const preview = await getGitPushPreview(projectRoot, status.remoteName);
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
  if (hasRemoteBranch) {
    const remoteOnly = Number(await runGit(["rev-list", "--count", `HEAD..${remoteRef}`], projectRoot, 20_000, ""));
    if (remoteOnly > 0) {
      await mergeRemoteKeepingNewest(
        projectRoot,
        "push",
        remoteRef,
        status.remoteLabel || "远端仓库",
        localTimeHints,
        status.remoteName
      );
    }
  }

  const hasUnpushedCommits = !hasRemoteBranch || Number(
    await runGit(["rev-list", "--count", `${remoteRef}..HEAD`], projectRoot, 20_000, "")
  ) > 0;
  if (!hasUnpushedCommits) return { pushed: false, status: await getGitStatus(projectRoot, status.remoteName) };

  await runRepositoryGit(["push", "-u", status.remoteName, `HEAD:${remoteBranch}`], projectRoot, 120_000);
  return { pushed: true, status: await getGitStatus(projectRoot, status.remoteName) };
}

export async function pullProject(projectRoot, remoteName = "") {
  const status = await getGitStatus(projectRoot, remoteName);
  return status.overleaf ? pullOverleaf(projectRoot) : pullGitRepository(projectRoot, status.remoteName);
}

export async function pushProject(projectRoot, message, options = {}) {
  const status = await getGitStatus(projectRoot, String(options.remoteName || ""));
  return status.overleaf
    ? pushOverleaf(projectRoot, message)
    : pushGitRepository(projectRoot, message, { ...options, remoteName: status.remoteName });
}
