import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer, stopServer } from "../server.js";

test("switching projects preserves saved AI and Overleaf credentials", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-switch-"));
  const firstProject = path.join(root, "first");
  const secondProject = path.join(root, "second");
  try {
    await fs.mkdir(firstProject);
    await fs.mkdir(secondProject);
    await fs.writeFile(path.join(firstProject, "main.tex"), "\\documentclass{article}\n\\begin{document}First\\end{document}\n", "utf8");
    await fs.writeFile(path.join(secondProject, "paper.tex"), "\\documentclass{article}\n\\begin{document}Second\\end{document}\n", "utf8");
    const server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data"),
      projectsRoot: path.join(root, "projects")
    });
    const request = (url, body) => fetch(`${server.url}${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    let response = await request("/api/config", {
      overleafToken: "saved-overleaf-token",
      gitUsername: "saved-git-user",
      gitToken: "saved-git-token",
      autoCompile: true,
      translation: { model: "deepseek-v4-flash", apiKey: "translation-key" },
      review: { model: "deepseek-v4-pro", apiKey: "review-key" }
    });
    assert.equal(response.ok, true);

    response = await request("/api/setup", {
      source: { mode: "local", localPath: firstProject },
      preserveProviders: true
    });
    assert.equal(response.ok, true);
    let project = await response.json();
    assert.equal(project.config.recentProjects[0].projectRoot, firstProject);
    assert.equal(project.config.recentProjects[0].mainTex, "main.tex");

    response = await request("/api/setup", {
      source: { mode: "local", localPath: secondProject },
      preserveProviders: true
    });
    assert.equal(response.ok, true);
    project = await response.json();
    assert.equal(project.config.projectRoot, secondProject);
    assert.equal(project.config.mainTex, "paper.tex");
    assert.equal(project.config.recentProjects[0].projectRoot, secondProject);
    assert.equal(project.config.recentProjects[1].projectRoot, firstProject);
    assert.equal(project.config.hasOverleafToken, true);
    assert.equal(project.config.gitUsername, "saved-git-user");
    assert.equal(project.config.hasGitToken, true);
    assert.equal(project.config.autoCompile, true);
    assert.equal(project.config.translation.model, "deepseek-v4-flash");
    assert.equal(project.config.translation.hasApiKey, true);
    assert.equal(project.config.format.model, "deepseek-v4-pro");
    assert.equal(project.config.format.hasApiKey, true);
    assert.equal("review" in project.config, false);

    response = await request("/api/project/open", {
      projectRoot: firstProject,
      mainTex: "main.tex"
    });
    assert.equal(response.ok, true);
    project = await response.json();
    assert.equal(project.config.projectRoot, firstProject);
    assert.equal(project.config.recentProjects[0].projectRoot, firstProject);
    assert.equal(project.config.recentProjects[1].projectRoot, secondProject);
  } finally {
    await stopServer();
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("failed Overleaf setup still stores a newly entered token", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-overleaf-token-"));
  try {
    const dataRoot = path.join(root, "data");
    const server = await startServer({
      port: 0,
      dataRoot,
      projectsRoot: path.join(root, "projects")
    });
    const request = (url, body) => fetch(`${server.url}${url}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    let response = await request("/api/config", {
      overleafToken: "old-token",
      translation: { model: "deepseek-v4-flash", apiKey: "translation-key" },
      review: { model: "deepseek-v4-pro", apiKey: "review-key" }
    });
    assert.equal(response.ok, true);

    response = await request("/api/setup", {
      source: { mode: "overleaf", projectUrl: "not an overleaf url", token: "new-token" },
      preserveProviders: true
    });
    assert.equal(response.ok, false);

    const stored = JSON.parse(await fs.readFile(path.join(dataRoot, "config.local.json"), "utf8"));
    assert.equal(stored.overleafToken, "new-token");
  } finally {
    await stopServer();
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("setup opens a new project without AI, Overleaf, or Git credentials", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-no-credentials-"));
  try {
    const server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data"),
      projectsRoot: path.join(root, "projects")
    });
    const response = await fetch(`${server.url}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: { mode: "new", name: "Credential Free Paper" } })
    });
    assert.equal(response.ok, true);
    const project = await response.json();
    assert.equal(project.config.mainTex, "main.tex");
    assert.equal(project.config.translation.hasApiKey, false);
    assert.equal(project.config.format.hasApiKey, false);
    assert.equal(project.git.available, false);
    assert.match(await fs.readFile(path.join(project.config.projectRoot, "main.tex"), "utf8"), /\\begin\{document\}/);
  } finally {
    await stopServer();
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("initial setup UI defaults to a new project and marks AI configuration optional", async () => {
  const html = await fs.readFile(path.join(process.cwd(), "public", "index.html"), "utf8");
  const app = await fs.readFile(path.join(process.cwd(), "public", "app.js"), "utf8");
  assert.match(html, /name="setupSource" value="new" checked/);
  assert.match(html, /配置 AI（可选）/);
  assert.doesNotMatch(html, /id="setupStorageRoot"[^>]*required/);
  assert.match(app, /AI 和远端连接可以稍后配置/);
});
