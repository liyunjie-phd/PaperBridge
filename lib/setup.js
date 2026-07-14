import fs from "node:fs/promises";
import path from "node:path";
import extract from "extract-zip";
import { cloneGitProject, cloneOverleafProject } from "./project.js";

const skippedDirectories = new Set([".git", "node_modules", "build", "out", "dist"]);

function projectSlug(value) {
  const slug = String(value || "paper")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-z0-9\u4e00-\u9fff_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 54);
  return slug || "paper";
}

async function uniqueDestination(projectsRoot, name) {
  await fs.mkdir(projectsRoot, { recursive: true });
  const base = projectSlug(name);
  for (let index = 0; index < 1000; index += 1) {
    const candidate = path.join(projectsRoot, index ? `${base}-${index + 1}` : base);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error("无法创建新的论文目录，请清理 PaperBridge Projects 文件夹后重试。");
}

async function removeFailedImport(destination, projectsRoot) {
  const root = path.resolve(projectsRoot);
  const target = path.resolve(destination);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("拒绝清理 PaperBridge 项目目录之外的路径。");
  }
  await fs.rm(target, { recursive: true, force: true });
}

async function collectTexFiles(root, directory = root, files = []) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".latexmkrc") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) await collectTexFiles(root, absolute, files);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".tex")) {
      files.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  }
  return files;
}

export async function detectMainTex(projectRoot) {
  const files = await collectTexFiles(projectRoot);
  if (!files.length) throw new Error("没有在该项目中找到 .tex 文件。");
  const candidates = [];
  for (const file of files) {
    const content = await fs.readFile(path.join(projectRoot, file), "utf8");
    if (/\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/.test(content)) candidates.push(file);
  }
  const ranked = (candidates.length ? candidates : files).sort((left, right) => {
    const leftMain = path.basename(left).toLowerCase() === "main.tex" ? 0 : 1;
    const rightMain = path.basename(right).toLowerCase() === "main.tex" ? 0 : 1;
    return leftMain - rightMain || left.split("/").length - right.split("/").length || left.localeCompare(right);
  });
  return ranked[0];
}

export function normalizeOverleafGitUrl(value) {
  const raw = String(value || "").trim().replace(/^git\s+clone\s+/i, "").replace(/^['"]|['"]$/g, "");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("请输入有效的 Overleaf 项目链接。");
  }
  const projectMatch = url.pathname.match(/\/project\/([a-z0-9]+)/i);
  if (projectMatch && /(^|\.)overleaf\.com$/i.test(url.hostname)) {
    return `https://git@git.overleaf.com/${projectMatch[1]}`;
  }
  if (projectMatch) return `https://git@${url.host}/git/${projectMatch[1]}`;
  if (/^git\.overleaf\.com$/i.test(url.hostname)) {
    url.username = "git";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  }
  if (/\/git\/[a-z0-9]+\/?$/i.test(url.pathname)) {
    url.username = "git";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  }
  throw new Error("该链接不是可识别的 Overleaf 项目或 Git 链接。");
}

export function normalizeGitRepositoryUrl(value) {
  const raw = String(value || "").trim().replace(/^git\s+clone\s+/i, "").replace(/^['"]|['"]$/g, "");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("请输入有效的 GitHub 或 GitLab HTTPS 仓库地址。");
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || !url.pathname.replace(/\//g, "")) {
    throw new Error("目前只支持 GitHub、GitLab 等服务的 HTTPS 仓库地址。");
  }
  if (/overleaf\.com$/i.test(url.hostname)) {
    throw new Error("Overleaf 项目请使用 Overleaf 来源，不要作为普通 Git 仓库导入。");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export async function openLocalProject(projectPath) {
  const projectRoot = path.resolve(String(projectPath || ""));
  const stat = await fs.stat(projectRoot).catch(() => null);
  if (!stat?.isDirectory()) throw new Error("选择的论文文件夹不存在。");
  return { projectRoot, mainTex: await detectMainTex(projectRoot) };
}

export async function importZipProject(zipPath, projectsRoot) {
  const absoluteZip = path.resolve(String(zipPath || ""));
  if (path.extname(absoluteZip).toLowerCase() !== ".zip") throw new Error("请选择从 Overleaf 下载的 ZIP 文件。");
  await fs.access(absoluteZip);
  const destination = await uniqueDestination(projectsRoot, path.basename(absoluteZip, ".zip"));
  await fs.mkdir(destination, { recursive: true });
  try {
    await extract(absoluteZip, { dir: destination });
    let projectRoot = destination;
    const entries = await fs.readdir(destination, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
    const rootTex = entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".tex"));
    if (!rootTex && directories.length === 1) projectRoot = path.join(destination, directories[0].name);
    return { projectRoot, mainTex: await detectMainTex(projectRoot) };
  } catch (error) {
    await removeFailedImport(destination, projectsRoot);
    throw error;
  }
}

export async function importOverleafProject(projectUrl, token, projectsRoot) {
  if (!String(token || "").trim()) throw new Error("请输入 Overleaf Git 令牌。");
  const gitUrl = normalizeOverleafGitUrl(projectUrl);
  const projectId = gitUrl.match(/([a-z0-9]+)\/?$/i)?.[1] || "overleaf-paper";
  const destination = await uniqueDestination(projectsRoot, `overleaf-${projectId}`);
  try {
    await cloneOverleafProject(gitUrl, destination, String(token).trim());
    return { projectRoot: destination, mainTex: await detectMainTex(destination), gitUrl };
  } catch (error) {
    await removeFailedImport(destination, projectsRoot);
    throw error;
  }
}

export async function importGitProject(repositoryUrl, username, token, projectsRoot) {
  const gitUrl = normalizeGitRepositoryUrl(repositoryUrl);
  const repositoryName = decodeURIComponent(path.basename(new URL(gitUrl).pathname).replace(/\.git$/i, "")) || "git-paper";
  const destination = await uniqueDestination(projectsRoot, repositoryName);
  try {
    await cloneGitProject(gitUrl, destination, String(username || "").trim(), String(token || "").trim());
    return { projectRoot: destination, mainTex: await detectMainTex(destination), gitUrl };
  } catch (error) {
    await removeFailedImport(destination, projectsRoot);
    throw error;
  }
}
