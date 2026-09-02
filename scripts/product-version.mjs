import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_FILE = path.join(ROOT, "product-versions.json");
const WINDOWS_PACKAGE = path.join(ROOT, "package.json");
const WINDOWS_LOCK = path.join(ROOT, "package-lock.json");
const PLUGIN_PACKAGE = path.join(ROOT, "pblatex-vscode", "package.json");

const PRODUCTS = ["windows", "macos", "plugin"];
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function readVersions() {
  const versions = await readJson(VERSION_FILE);
  for (const product of PRODUCTS) {
    const entry = versions?.[product];
    if (!entry || !SEMVER.test(String(entry.version || ""))) {
      throw new Error(`product-versions.json 中的 ${product} 版本号无效。`);
    }
    if (!/^[a-z0-9-]+$/.test(String(entry.tagPrefix || ""))) {
      throw new Error(`product-versions.json 中的 ${product} tagPrefix 无效。`);
    }
  }
  return versions;
}

function updateJsonText(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

async function check() {
  const versions = await readVersions();
  const windowsPackage = await readJson(WINDOWS_PACKAGE);
  const pluginPackage = await readJson(PLUGIN_PACKAGE);
  const mismatches = [];
  if (String(windowsPackage.version) !== String(versions.windows.version)) {
    mismatches.push(`Windows: package.json=${windowsPackage.version}, product-versions.json=${versions.windows.version}`);
  }
  if (String(pluginPackage.version) !== String(versions.plugin.version)) {
    mismatches.push(`PBLaTex: pblatex-vscode/package.json=${pluginPackage.version}, product-versions.json=${versions.plugin.version}`);
  }
  if (mismatches.length) {
    throw new Error(`产品线版本不一致：\n${mismatches.map((item) => `- ${item}`).join("\n")}`);
  }
  for (const product of PRODUCTS) {
    const entry = versions[product];
    console.log(`${product.padEnd(7)} ${entry.version}  (${entry.tagPrefix}${entry.version})`);
  }
}

async function setVersion(product, version) {
  if (!PRODUCTS.includes(product)) throw new Error(`未知产品线：${product}。可选：${PRODUCTS.join(", ")}`);
  if (!SEMVER.test(String(version || ""))) throw new Error("版本号必须是类似 0.4.3 的 SemVer 格式。");
  const versions = await readVersions();
  versions[product].version = version;
  await fs.writeFile(VERSION_FILE, updateJsonText(versions), "utf8");

  if (product === "windows") {
    const packageJson = await readJson(WINDOWS_PACKAGE);
    packageJson.version = version;
    await fs.writeFile(WINDOWS_PACKAGE, updateJsonText(packageJson), "utf8");
    const lock = await readJson(WINDOWS_LOCK);
    lock.version = version;
    if (lock.packages?.[""]) lock.packages[""].version = version;
    await fs.writeFile(WINDOWS_LOCK, updateJsonText(lock), "utf8");
  } else if (product === "plugin") {
    const packageJson = await readJson(PLUGIN_PACKAGE);
    packageJson.version = version;
    await fs.writeFile(PLUGIN_PACKAGE, updateJsonText(packageJson), "utf8");
  }
  console.log(`${product} 已更新为 ${version}。`);
}

async function checkTag(product, tag) {
  if (!PRODUCTS.includes(product)) throw new Error(`未知产品线：${product}。可选：${PRODUCTS.join(", ")}`);
  const versions = await readVersions();
  const expected = `${versions[product].tagPrefix}${versions[product].version}`;
  if (String(tag || "") !== expected) {
    throw new Error(`${product} 的 release tag 应为 ${expected}，实际收到 ${tag || "空值"}。`);
  }
  console.log(`${product} release tag 校验通过：${expected}`);
}

const [command = "check", product, version] = process.argv.slice(2);
try {
  if (command === "check") await check();
  else if (command === "set") await setVersion(product, version);
  else if (command === "check-tag") await checkTag(product, version);
  else if (command === "show") {
    const versions = await readVersions();
    console.log(JSON.stringify(versions, null, 2));
  } else {
    throw new Error("用法：node scripts/product-version.mjs [check|show|set <product> <version>|check-tag <product> <tag>]");
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
