import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exec as execGit } from "dugite";
import {
  configureProjectRuntime,
  getGitRemoteConfiguration,
  removeGitRemote,
  testGitRemoteConnection,
  upsertGitRemote
} from "../lib/project.js";
import { startServer, stopServer } from "../server.js";

async function git(args, cwd) {
  const result = await execGit(args, cwd, { maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.exitCode, 0, `${result.stderr}\n${result.stdout}`);
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

async function createPaper(projectRoot, mainTex = "main.tex") {
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(
    path.join(projectRoot, mainTex),
    "\\documentclass{article}\n\\begin{document}\nProject Git management test.\n\\end{document}\n",
    "utf8"
  );
}

test("project Git management keeps defaults per project and never exposes credential tokens", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-project-git-"));
  const firstProject = path.join(root, "first");
  const secondProject = path.join(root, "second");
  try {
    await createPaper(firstProject);
    await createPaper(secondProject, "paper.tex");
    for (const projectRoot of [firstProject, secondProject]) {
      await git(["init"], projectRoot);
      await git(["remote", "add", "github", "https://github.com/example/paper.git"], projectRoot);
      await git(["remote", "add", "gitlab", "https://gitlab.com/example/paper.git"], projectRoot);
      await git(["remote", "add", "overleaf", "https://git.overleaf.com/1234567890abcdef12345678"], projectRoot);
    }

    const server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data"),
      projectsRoot: path.join(root, "projects"),
      encryptSecret: (value) => Buffer.from(value, "utf8").toString("base64"),
      decryptSecret: (value) => Buffer.from(value, "base64").toString("utf8")
    });
    const request = (url, { method = "GET", body } = {}) => fetch(`${server.url}${url}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const post = (url, body) => request(url, { method: "POST", body });

    let response = await post("/api/config", {
      translation: { model: "deepseek-v4-flash", apiKey: "translation-key" },
      format: { model: "deepseek-v4-pro", apiKey: "format-key" }
    });
    assert.equal(response.ok, true);

    response = await post("/api/setup", {
      source: { mode: "local", localPath: firstProject, name: "第一篇论文" },
      preserveProviders: true
    });
    assert.equal(response.ok, true, response.ok ? "" : await response.text());
    response = await post("/api/setup", {
      source: { mode: "local", localPath: secondProject },
      preserveProviders: true
    });
    assert.equal(response.ok, true, response.ok ? "" : await response.text());
    let project = await response.json();
    assert.equal(project.config.recentProjects.find((item) => item.projectRoot === firstProject)?.name, "第一篇论文");

    response = await post("/api/project/name", {
      projectRoot: secondProject,
      mainTex: "paper.tex",
      name: "第二篇论文"
    });
    assert.equal(response.ok, true, response.ok ? "" : await response.text());
    assert.equal((await response.json()).name, "第二篇论文");

    response = await post("/api/project/open", { projectRoot: secondProject, mainTex: "paper.tex" });
    assert.equal(response.ok, true, response.ok ? "" : await response.text());
    project = await response.json();
    assert.equal(project.config.projectName, "第二篇论文");

    response = await post("/api/git/credentials", {
      projectRoot: firstProject,
      name: "共享 GitHub",
      provider: "git",
      username: "paper-author",
      token: "shared-secret-token",
      scope: "shared"
    });
    assert.equal(response.ok, true);
    let management = await response.json();
    const shared = management.credentialProfiles.find((profile) => profile.name === "共享 GitHub");
    assert.ok(shared?.id);
    assert.equal(shared.hasToken, true);
    assert.equal("token" in shared, false);
    assert.doesNotMatch(JSON.stringify(management), /shared-secret-token/);
    const storedConfig = await fs.readFile(path.join(root, "data", "config.local.json"), "utf8");
    assert.doesNotMatch(storedConfig, /shared-secret-token/);
    assert.match(storedConfig, /enc:v1:/);

    response = await post("/api/git/credentials", {
      projectRoot: firstProject,
      name: "仅第一篇论文",
      provider: "overleaf",
      token: "project-only-secret",
      scope: "project"
    });
    assert.equal(response.ok, true);
    management = await response.json();
    assert.ok(management.credentialProfiles.some((profile) => profile.name === "仅第一篇论文"));
    assert.doesNotMatch(JSON.stringify(management), /project-only-secret/);

    response = await request(`/api/projects/git?projectRoot=${encodeURIComponent(secondProject)}`);
    assert.equal(response.ok, true);
    const secondManagement = await response.json();
    assert.ok(secondManagement.credentialProfiles.some((profile) => profile.id === shared.id));
    assert.ok(!secondManagement.credentialProfiles.some((profile) => profile.name === "仅第一篇论文"));

    response = await post("/api/projects/git/default", { projectRoot: firstProject, remoteName: "overleaf" });
    assert.equal(response.ok, true);
    management = await response.json();
    assert.equal(management.defaultRemote, "overleaf");
    assert.equal(management.remotes.find((remote) => remote.name === "github")?.label, "GitHub");
    assert.equal(management.remotes.find((remote) => remote.name === "gitlab")?.label, "GitLab");
    assert.equal(management.remotes.find((remote) => remote.name === "overleaf")?.label, "Overleaf");

    response = await post("/api/project/open", { projectRoot: firstProject, mainTex: "main.tex" });
    assert.equal(response.ok, true);
    project = await response.json();
    assert.equal(project.git.remoteName, "overleaf");
    assert.equal(project.config.recentProjects.find((item) => item.projectRoot === firstProject)?.git.defaultRemote, "overleaf");

    response = await request("/api/projects/git/remote", {
      method: "DELETE",
      body: { projectRoot: firstProject, remoteName: "gitlab" }
    });
    assert.equal(response.ok, true);
    management = await response.json();
    assert.ok(!management.remotes.some((remote) => remote.name === "gitlab"));

    response = await request("/api/git/credentials", {
      method: "DELETE",
      body: { projectRoot: firstProject, id: shared.id }
    });
    assert.equal(response.ok, true);
    management = await response.json();
    assert.ok(!management.credentialProfiles.some((profile) => profile.id === shared.id));
  } finally {
    await stopServer();
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Git remote helpers test before adding, support rename, and remove cleanly", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-git-remote-helper-"));
  const projectRoot = path.join(root, "paper");
  const firstRemote = path.join(root, "first.git");
  const secondRemote = path.join(root, "second.git");
  try {
    await createPaper(projectRoot);
    await git(["init", "--bare", firstRemote], root);
    await git(["init", "--bare", secondRemote], root);
    configureProjectRuntime({ getGitToken: () => "", getGitUsername: () => "" });

    await testGitRemoteConnection(projectRoot, firstRemote, "git", {});
    let status = await upsertGitRemote(projectRoot, {
      provider: "git",
      name: "origin",
      url: firstRemote,
      credential: {}
    });
    assert.equal(status.available, true);
    assert.equal(status.remotes[0].name, "origin");

    status = await upsertGitRemote(projectRoot, {
      provider: "git",
      originalName: "origin",
      name: "archive",
      url: secondRemote,
      credential: {}
    });
    assert.ok(status.remotes.some((remote) => remote.name === "archive"));
    assert.ok(!status.remotes.some((remote) => remote.name === "origin"));
    assert.equal(await git(["remote", "get-url", "archive"], projectRoot), secondRemote);

    status = await removeGitRemote(projectRoot, "archive");
    assert.equal(status.remotes.length, 0);
    assert.equal((await getGitRemoteConfiguration(projectRoot)).remoteName, "");
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("project Git management controls are wired into the visible UI", async () => {
  const [html, app, styles] = await Promise.all([
    fs.readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    fs.readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../public/styles.css", import.meta.url), "utf8")
  ]);
  for (const id of [
    "gitManagerDialog",
    "gitRemoteForm",
    "gitCredentialForm",
    "addGitRemoteButton",
    "addGitCredentialButton"
  ]) assert.match(html, new RegExp(`id=["']${id}["']`));
  assert.match(app, /project-git-manage-button/);
  assert.match(app, /\/api\/projects\/git\/remote/);
  assert.match(app, /\/api\/git\/credentials/);
  assert.match(styles, /\.git-manager-dialog/);
  assert.match(styles, /\.git-service-badge\.overleaf/);
});
