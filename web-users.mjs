import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCRYPT_OPTIONS = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function usersFile() {
  const dataRoot = process.env.PAPERBRIDGE_WEB_DATA_ROOT || path.join(APP_ROOT, "web-data");
  return path.resolve(process.env.PAPERBRIDGE_WEB_USERS_FILE || path.join(dataRoot, "users.json"));
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._@+-]/g, "").slice(0, 254);
}

function userIdForUsername(username) {
  return crypto.createHash("sha256").update(username).digest("hex").slice(0, 24);
}

function scryptAsync(password, salt, keyLength = 64) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLength, SCRYPT_OPTIONS, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

export async function hashPassword(password) {
  const value = String(password || "");
  if (value.length < 10) throw new Error("密码至少需要 10 个字符。");
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(value, salt);
  return [
    "scrypt",
    SCRYPT_OPTIONS.N,
    SCRYPT_OPTIONS.r,
    SCRYPT_OPTIONS.p,
    salt.toString("base64url"),
    derived.toString("base64url")
  ].join("$");
}

export async function verifyPassword(password, encoded) {
  const parts = String(encoded || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltEncoded, hashEncoded] = parts;
  const salt = Buffer.from(saltEncoded, "base64url");
  const expected = Buffer.from(hashEncoded, "base64url");
  if (!salt.length || !expected.length) return false;
  const derived = await new Promise((resolve, reject) => {
    crypto.scrypt(String(password || ""), salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024
    }, (error, value) => error ? reject(error) : resolve(value));
  });
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

export async function readWebUsers(file = usersFile(), { allowMissing = false } = {}) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("用户文件必须是数组。");
    return parsed.filter((item) => item && item.enabled !== false && normalizeUsername(item.username));
  } catch (error) {
    if (error.code === "ENOENT") {
      if (allowMissing) return [];
      throw new Error(`找不到网页版用户文件：${file}。请先运行 npm run web:user -- add <用户名>。`);
    }
    throw error;
  }
}

export async function registerWebUser({ email, password }, file = usersFile(), maxUsers = 10) {
  const username = normalizeUsername(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) throw new Error("请输入有效的邮箱地址。");
  const users = await readWebUsers(file, { allowMissing: true });
  const existing = users.find((user) => normalizeUsername(user.email || user.username) === username);
  if (existing) return existing;
  if (users.length >= maxUsers) throw new Error("测试账号数量已达到上限，请联系管理员。");
  const now = new Date().toISOString();
  const user = {
    id: userIdForUsername(username),
    username,
    email: username,
    passwordHash: await hashPassword(password),
    enabled: true,
    createdAt: now,
    updatedAt: now
  };
  await writeWebUsers([...users, user], file);
  return user;
}

async function writeWebUsers(users, file = usersFile()) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(users, null, 2)}\n`, "utf8");
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function askPassword() {
  if (process.env.PAPERBRIDGE_WEB_PASSWORD) return process.env.PAPERBRIDGE_WEB_PASSWORD;
  const readline = createInterface({ input, output });
  try {
    return await readline.question("Password (at least 10 characters): ");
  } finally {
    readline.close();
  }
}

async function main() {
  const [command = "list", rawUsername = ""] = process.argv.slice(2);
  const file = usersFile();
  const users = await fs.readFile(file, "utf8")
    .then((value) => JSON.parse(value))
    .catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const username = normalizeUsername(rawUsername);
  if (command === "list") {
    for (const user of users) console.log(`${user.username}\t${user.enabled === false ? "disabled" : "enabled"}`);
    return;
  }
  if (!username) throw new Error("请提供邮箱地址。");
  if (command === "remove") {
    await writeWebUsers(users.filter((user) => normalizeUsername(user.username) !== username), file);
    console.log(`Removed ${username}`);
    return;
  }
  if (!["add", "set-password"].includes(command)) {
    throw new Error("用法：npm run web:user -- add <用户名> | set-password <用户名> | remove <用户名> | list");
  }
  const password = await askPassword();
  const existing = users.find((user) => normalizeUsername(user.username) === username);
  if (command === "add" && existing) throw new Error("该用户已经存在，请使用 set-password 修改密码。");
  const next = {
    ...(existing || {}),
    id: existing?.id || userIdForUsername(username),
    username,
    passwordHash: await hashPassword(password),
    enabled: true,
    updatedAt: new Date().toISOString(),
    createdAt: existing?.createdAt || new Date().toISOString()
  };
  const nextUsers = existing
    ? users.map((user) => normalizeUsername(user.username) === username ? next : user)
    : [...users, next];
  await writeWebUsers(nextUsers, file);
  console.log(`${command === "add" ? "Added" : "Updated"} ${username}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
