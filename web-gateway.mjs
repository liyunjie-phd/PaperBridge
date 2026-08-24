import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readWebUsers, registerWebUser, verifyPassword } from "./web-users.mjs";

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function parseCookies(header = "") {
  return Object.fromEntries(String(header).split(";").map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function cookie(name, value, options = {}) {
  const attributes = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax"];
  if (options.httpOnly) attributes.push("HttpOnly");
  if (options.secure) attributes.push("Secure");
  if (options.maxAge !== undefined) attributes.push(`Max-Age=${options.maxAge}`);
  return attributes.join("; ");
}

function safeTextEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function userRoots(dataRoot, user) {
  const id = String(user.id || "").replace(/[^a-zA-Z0-9_-]/g, "_");
  const root = path.join(path.resolve(dataRoot), "users", id);
  return {
    root,
    settings: path.join(root, "Settings"),
    projects: path.join(root, "Projects"),
    uploads: path.join(root, "Uploads")
  };
}

function readRequestBody(request, limit = 1_048_576) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("请求内容过大。"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function json(res, status, payload, headers = {}) {
  const content = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": content.length, ...headers });
  res.end(content);
}

function html(res, status, content, headers = {}) {
  const body = Buffer.from(content);
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length, ...headers });
  res.end(body);
}

const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PaperBridge 登录</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#eef4f1;font:16px system-ui,"Microsoft YaHei",sans-serif;color:#173a31}
main{width:min(380px,calc(100vw - 40px));padding:32px;background:#fff;border:1px solid #d7e5df;border-radius:18px;box-shadow:0 12px 36px #174f3b18}h1{margin:0 0 8px;font-size:25px}p{color:#60786f;font-size:14px;line-height:1.6}label{display:block;margin:18px 0 6px;font-size:14px;font-weight:600}input{box-sizing:border-box;width:100%;padding:11px 12px;border:1px solid #c8d9d2;border-radius:9px;font-size:16px}button{width:100%;margin-top:22px;padding:12px;border:0;border-radius:9px;background:#176b52;color:#fff;font-size:16px;cursor:pointer}#message{min-height:22px;margin-top:14px;color:#b33b36;font-size:14px}</style></head>
<body><main><h1>PaperBridge</h1><p>请输入邮箱和密码登录。首次使用需要填写管理员提供的邀请码；每个账号拥有独立的论文项目、配置和编译空间。</p>
<form id="login"><label for="email">邮箱</label><input id="email" type="email" autocomplete="username" required>
<label for="password">密码</label><input id="password" type="password" autocomplete="current-password" required>
<label for="inviteCode">邀请码（首次注册必填）</label><input id="inviteCode" autocomplete="one-time-code" placeholder="已有账号可留空">
<button>登录 / 注册</button><div id="message" role="alert"></div></form></main>
<script>document.querySelector('#login').addEventListener('submit',async(e)=>{e.preventDefault();const m=document.querySelector('#message');m.textContent='登录中…';try{const r=await fetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.querySelector('#email').value,password:document.querySelector('#password').value,inviteCode:document.querySelector('#inviteCode').value})});const p=await r.json();if(!r.ok)throw new Error(p.error||'登录失败');location.href='/';}catch(err){m.textContent=err.message;}});</script></body></html>`;

function waitForPort(port, timeoutMs = 15_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - started >= timeoutMs) reject(new Error("PaperBridge 用户服务启动超时。"));
        else setTimeout(attempt, 120);
      });
    };
    attempt();
  });
}

export function createWebGateway(options = {}) {
  const dataRoot = path.resolve(options.dataRoot || process.env.PAPERBRIDGE_WEB_DATA_ROOT || path.join(APP_ROOT, "web-data"));
  const usersFile = path.resolve(options.usersFile || process.env.PAPERBRIDGE_WEB_USERS_FILE || path.join(dataRoot, "users.json"));
  const host = options.host || process.env.PAPERBRIDGE_WEB_HOST || "127.0.0.1";
  const port = Number(options.port ?? process.env.PAPERBRIDGE_WEB_PORT ?? 8080);
  const backendBasePort = Number(options.backendBasePort || process.env.PAPERBRIDGE_WEB_BACKEND_BASE_PORT || 4700);
  const cookieSecure = options.cookieSecure ?? process.env.PAPERBRIDGE_WEB_COOKIE_SECURE === "1";
  const inviteCode = String(options.inviteCode ?? process.env.PAPERBRIDGE_WEB_INVITE_CODE ?? "").trim();
  const maxUsers = Math.max(1, Number(options.maxUsers ?? process.env.PAPERBRIDGE_WEB_MAX_USERS ?? 10));
  const sessionTtlMs = Number(options.sessionTtlMs || 24 * 60 * 60 * 1000);
  const sessions = new Map();
  const backends = new Map();
  const loginAttempts = new Map();
  let nextBackendOffset = 0;
  let server;
  let listeningPort = port;

  async function authenticated(request) {
    const token = parseCookies(request.headers.cookie).pb_session;
    const session = token ? sessions.get(token) : null;
    if (!session || session.expiresAt <= Date.now()) {
      if (token) sessions.delete(token);
      return null;
    }
    session.expiresAt = Date.now() + sessionTtlMs;
    return session;
  }

  async function findUser(username) {
    const normalized = String(username || "").trim().toLowerCase();
    const users = await readWebUsers(usersFile, { allowMissing: true });
    return users.find((user) => String(user.email || user.username || "").toLowerCase() === normalized) || null;
  }

  async function ensureBackend(user) {
    const existing = backends.get(user.id);
    if (existing) return existing;
    const roots = userRoots(dataRoot, user);
    const backendPort = backendBasePort + nextBackendOffset++;
    const child = spawn(process.execPath, [path.join(APP_ROOT, "server.js")], {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        PAPERBRIDGE_WEB_MODE: "1",
        PAPERBRIDGE_HOST: "127.0.0.1",
        PAPERBRIDGE_PORT: String(backendPort),
        PAPERBRIDGE_DATA_ROOT: roots.settings,
        PAPERBRIDGE_PROJECTS_ROOT: roots.projects,
        PAPERBRIDGE_WEB_UPLOADS_ROOT: roots.uploads
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk) => process.stdout.write(`[PaperBridge ${user.username}] ${chunk}`));
    child.stderr.on("data", (chunk) => process.stderr.write(`[PaperBridge ${user.username}] ${chunk}`));
    const entry = { child, port: backendPort, roots };
    backends.set(user.id, entry);
    child.once("exit", () => {
      if (backends.get(user.id)?.child === child) backends.delete(user.id);
    });
    try {
      await waitForPort(backendPort);
      return entry;
    } catch (error) {
      child.kill();
      backends.delete(user.id);
      throw error;
    }
  }

  function requireCsrf(request) {
    if (SAFE_METHODS.has(request.method)) return true;
    const cookies = parseCookies(request.headers.cookie);
    return Boolean(cookies.pb_csrf && request.headers["x-paperbridge-csrf"] === cookies.pb_csrf);
  }

  async function proxy(request, response, session) {
    const backend = await ensureBackend(session.user);
    const headers = { ...request.headers, host: `127.0.0.1:${backend.port}`, "x-paperbridge-user": session.user.id };
    delete headers.cookie;
    const proxyRequest = http.request({ host: "127.0.0.1", port: backend.port, method: request.method, path: request.url, headers }, (proxyResponse) => {
      response.writeHead(proxyResponse.statusCode || 502, proxyResponse.headers);
      proxyResponse.pipe(response);
    });
    proxyRequest.once("error", (error) => {
      if (!response.headersSent) json(response, 502, { error: `用户服务不可用：${error.message}` });
      else response.destroy(error);
    });
    request.pipe(proxyRequest);
  }

  async function handle(request, response) {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "same-origin");
    const parsed = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (parsed.pathname === "/healthz") return json(response, 200, { ok: true, users: sessions.size });
    if (parsed.pathname === "/login" && request.method === "GET") return html(response, 200, LOGIN_PAGE);
    if (parsed.pathname === "/auth/login" && request.method === "POST") {
      const body = JSON.parse((await readRequestBody(request)).toString("utf8") || "{}");
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json(response, 400, { error: "请输入有效的邮箱地址。" });
      }
      const attemptKey = `${request.socket.remoteAddress || "unknown"}:${email}`;
      const attempt = loginAttempts.get(attemptKey);
      if (attempt && attempt.count >= 5 && Date.now() - attempt.startedAt < 10 * 60 * 1000) {
        return json(response, 429, { error: "登录失败次数过多，请 10 分钟后重试。" }, { "Retry-After": "600" });
      }
      let user = await findUser(email);
      if (!user && (!inviteCode || !safeTextEqual(body.inviteCode, inviteCode))) {
        return json(response, 403, { error: "首次注册需要有效的邀请码。" });
      }
      if (!user) {
        try {
          user = await registerWebUser({ email, password: body.password }, usersFile, maxUsers);
        } catch (error) {
          return json(response, 400, { error: error.message });
        }
      } else if (!(await verifyPassword(body.password, user.passwordHash))) {
        const current = attempt && Date.now() - attempt.startedAt < 10 * 60 * 1000
          ? attempt
          : { count: 0, startedAt: Date.now() };
        current.count += 1;
        loginAttempts.set(attemptKey, current);
        return json(response, 401, { error: "邮箱或密码错误。" });
      }
      loginAttempts.delete(attemptKey);
      const token = crypto.randomBytes(32).toString("base64url");
      const csrf = crypto.randomBytes(24).toString("base64url");
      sessions.set(token, { user, csrf, expiresAt: Date.now() + sessionTtlMs });
      return json(response, 200, { ok: true, username: user.email || user.username }, {
        "Set-Cookie": [cookie("pb_session", token, { httpOnly: true, secure: cookieSecure }), cookie("pb_csrf", csrf, { secure: cookieSecure })]
      });
    }
    if (parsed.pathname === "/auth/logout") {
      const token = parseCookies(request.headers.cookie).pb_session;
      if (token) sessions.delete(token);
      return request.method === "GET"
        ? (response.writeHead(302, { Location: "/login", "Set-Cookie": [cookie("pb_session", "", { httpOnly: true, secure: cookieSecure, maxAge: 0 }), cookie("pb_csrf", "", { secure: cookieSecure, maxAge: 0 })] }), response.end())
        : json(response, 200, { ok: true }, { "Set-Cookie": [cookie("pb_session", "", { httpOnly: true, secure: cookieSecure, maxAge: 0 }), cookie("pb_csrf", "", { secure: cookieSecure, maxAge: 0 })] });
    }
    const session = await authenticated(request);
    if (!session) {
      if (parsed.pathname.startsWith("/api/")) return json(response, 401, { error: "请先登录。", code: "AUTH_REQUIRED" });
      response.writeHead(302, { Location: "/login" });
      return response.end();
    }
    if (parsed.pathname === "/api/web/session" && request.method === "GET") {
      return json(response, 200, { authenticated: true, username: session.user.username, userId: session.user.id });
    }
    if (!requireCsrf(request)) return json(response, 403, { error: "请求校验失败，请刷新页面后重试。", code: "CSRF_FAILED" });
    if (parsed.pathname === "/api/web/upload" && request.method === "POST") {
      const name = path.basename(parsed.searchParams.get("name") || "paper.zip");
      if (!name.toLowerCase().endsWith(".zip")) return json(response, 400, { error: "只允许上传 ZIP 文件。" });
      const backend = await ensureBackend(session.user);
      const uploads = backend.roots.uploads;
      const filePath = path.join(uploads, `${crypto.randomUUID()}.zip`);
      const body = await readRequestBody(request, 100 * 1024 * 1024);
      await fs.mkdir(uploads, { recursive: true });
      await fs.writeFile(filePath, body, { flag: "wx" });
      return json(response, 200, { ok: true, name, path: filePath });
    }
    return proxy(request, response, session);
  }

  return {
    async start() {
      if (server) return { server, port: listeningPort, url: `http://${host}:${listeningPort}` };
      if (!inviteCode) await readWebUsers(usersFile);
      server = http.createServer((request, response) => {
        handle(request, response).catch((error) => json(response, error.statusCode || 500, { error: error.message || "请求失败" }));
      });
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
      listeningPort = server.address().port;
      return { server, port: listeningPort, url: `http://${host}:${listeningPort}` };
    },
    async stop() {
      for (const backend of backends.values()) backend.child.kill();
      backends.clear();
      sessions.clear();
      if (server) await new Promise((resolve) => server.close(resolve));
      server = null;
    },
    userRoots: (user) => userRoots(dataRoot, user)
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const gateway = createWebGateway();
  gateway.start().then(({ url }) => console.log(`PaperBridge Web running at ${url}`)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
