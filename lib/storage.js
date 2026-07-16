import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const STORAGE_MARKER = ".paperbridge-storage";

const ownedSettingsEntries = [
  "config.local.json",
  "config.local.json.bak",
  "data",
  "source-backups",
  "structure-backups",
  "bibliography-backups",
  "format-jobs",
  "format-backups"
];

export function storageDirectories(storageRoot) {
  const root = path.resolve(String(storageRoot || ""));
  return {
    storageRoot: root,
    dataRoot: path.join(root, "Settings"),
    projectsRoot: path.join(root, "Projects")
  };
}

export function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function remapManagedProject(projectRoot, oldProjectsRoot, newProjectsRoot) {
  if (!projectRoot) return "";
  const resolvedProject = path.resolve(projectRoot);
  const resolvedOldRoot = path.resolve(oldProjectsRoot);
  if (!isPathInside(resolvedOldRoot, resolvedProject)) return resolvedProject;
  return path.join(path.resolve(newProjectsRoot), path.relative(resolvedOldRoot, resolvedProject));
}

function assertSafeStorageRoot(targetRoot, sourceDataRoot, sourceProjectsRoot) {
  if (!path.isAbsolute(targetRoot)) throw new Error("数据保存位置必须是完整的绝对路径。");
  if (targetRoot === path.parse(targetRoot).root) throw new Error("不能直接把磁盘根目录作为 PaperBridge 数据目录。");
  const protectedRoots = [sourceDataRoot, sourceProjectsRoot].filter(Boolean).map((value) => path.resolve(value));
  for (const protectedRoot of protectedRoots) {
    if (targetRoot === protectedRoot || isPathInside(protectedRoot, targetRoot) || isPathInside(targetRoot, protectedRoot)) {
      throw new Error("新的数据目录不能与当前设置目录或项目目录互相包含。");
    }
  }
}

async function directoryIsEmpty(target) {
  const entries = await fs.readdir(target).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return entries === null || entries.length === 0;
}

async function copyIfPresent(source, destination) {
  const stat = await fs.lstat(source).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return;
  if (stat.isSymbolicLink()) throw new Error(`数据迁移已停止：不允许复制符号链接 ${source}`);
  await fs.cp(source, destination, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
}

async function buildManifest(root, directory = root, entries = []) {
  const children = await fs.readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  children.sort((left, right) => left.name.localeCompare(right.name));
  for (const child of children) {
    const absolute = path.join(directory, child.name);
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    if (child.isSymbolicLink()) throw new Error(`数据迁移已停止：不允许复制符号链接 ${absolute}`);
    if (child.isDirectory()) {
      entries.push({ path: `${relative}/`, size: 0 });
      await buildManifest(root, absolute, entries);
    } else if (child.isFile()) {
      entries.push({ path: relative, size: (await fs.stat(absolute)).size });
    } else {
      throw new Error(`数据迁移已停止：无法处理 ${absolute}`);
    }
  }
  return entries;
}

async function settingsManifest(dataRoot) {
  const entries = [];
  for (const name of ownedSettingsEntries) {
    const source = path.join(dataRoot, name);
    const stat = await fs.lstat(source).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error(`数据迁移已停止：不允许复制符号链接 ${source}`);
    if (stat.isDirectory()) {
      entries.push({ path: `${name}/`, size: 0 });
      await buildManifest(dataRoot, source, entries);
    } else if (stat.isFile()) {
      entries.push({ path: name, size: stat.size });
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function assertSafeLegacyRemoval(target) {
  const resolved = path.resolve(target);
  const unsafe = new Set([path.parse(resolved).root.toLowerCase(), os.homedir().toLowerCase()]);
  if (unsafe.has(resolved.toLowerCase())) throw new Error(`拒绝删除不安全的旧目录：${resolved}`);
}

export async function stageStorageMigration({
  sourceDataRoot,
  sourceProjectsRoot,
  targetStorageRoot,
  currentProjectRoot = ""
}) {
  if (!path.isAbsolute(String(targetStorageRoot || ""))) {
    throw new Error("数据保存位置必须是完整的绝对路径。");
  }
  const target = storageDirectories(targetStorageRoot);
  assertSafeStorageRoot(target.storageRoot, sourceDataRoot, sourceProjectsRoot);
  if (!await directoryIsEmpty(target.storageRoot)) {
    throw new Error("新的数据保存位置必须是空文件夹，请新建或选择一个空文件夹。");
  }

  const sourceSettingsManifest = await settingsManifest(sourceDataRoot);
  const sourceProjectsManifest = await buildManifest(sourceProjectsRoot);
  try {
    await fs.mkdir(target.dataRoot, { recursive: true });
    for (const name of ownedSettingsEntries) {
      await copyIfPresent(path.join(sourceDataRoot, name), path.join(target.dataRoot, name));
    }
    const sourceProjectsStat = await fs.stat(sourceProjectsRoot).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (sourceProjectsStat) await copyIfPresent(sourceProjectsRoot, target.projectsRoot);
    else await fs.mkdir(target.projectsRoot, { recursive: true });
    await fs.writeFile(path.join(target.storageRoot, STORAGE_MARKER), "PaperBridge storage v1", "utf8");

    const copiedSettingsManifest = await settingsManifest(target.dataRoot);
    const copiedProjectsManifest = await buildManifest(target.projectsRoot);
    if (JSON.stringify(sourceSettingsManifest) !== JSON.stringify(copiedSettingsManifest)
      || JSON.stringify(sourceProjectsManifest) !== JSON.stringify(copiedProjectsManifest)) {
      throw new Error("复制后的文件清单与原目录不一致，PaperBridge 已保留原数据。");
    }
  } catch (error) {
    await fs.rm(target.storageRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return {
    ...target,
    projectRoot: remapManagedProject(currentProjectRoot, sourceProjectsRoot, target.projectsRoot),
    settingsEntries: sourceSettingsManifest.length,
    projectEntries: sourceProjectsManifest.length
  };
}

export async function removeLegacyStorage(sourceDataRoot, sourceProjectsRoot) {
  assertSafeLegacyRemoval(sourceDataRoot);
  assertSafeLegacyRemoval(sourceProjectsRoot);
  for (const name of ownedSettingsEntries) {
    await fs.rm(path.join(sourceDataRoot, name), { recursive: true, force: true });
  }
  await fs.rm(path.join(sourceDataRoot, "git-askpass.cmd"), { force: true });
  await fs.rm(sourceProjectsRoot, { recursive: true, force: true });
}
