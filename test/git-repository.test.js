import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exec as execGit } from "dugite";
import {
  configureGitLocalExcludes,
  configureProjectRuntime,
  connectGitRepository,
  getGitStatus,
  getGitPushPreview,
  pullProject,
  pushGitRepository,
  pushProject,
  resolveGitSyncConflict
} from "../lib/project.js";

async function git(args, cwd) {
  const result = await execGit(args, cwd, { maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.exitCode, 0, `${result.stderr}\n${result.stdout}`);
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

test("a local paper can connect and push to an empty Git repository", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-git-repository-"));
  const projectRoot = path.join(root, "paper");
  const remoteRoot = path.join(root, "remote.git");
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(
      path.join(projectRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nA complete paper paragraph contains enough words for testing.\n\\end{document}\n",
      "utf8"
    );
    await git(["init", "--bare", remoteRoot], root);
    configureProjectRuntime({ getGitUsername: () => "", getGitToken: () => "" });

    await connectGitRepository(projectRoot, remoteRoot);
    await configureGitLocalExcludes(projectRoot, "main.tex");
    await fs.writeFile(path.join(projectRoot, "main.pdf"), "compiled output", "utf8");
    await fs.writeFile(path.join(projectRoot, "main.aux"), "temporary output", "utf8");
    await fs.writeFile(path.join(projectRoot, "notes.txt"), "private working notes", "utf8");
    let status = await getGitStatus(projectRoot);
    assert.equal(status.available, true);
    assert.equal(status.provider, "git");
    assert.equal(status.remoteName, "paperbridge");
    assert.equal(status.dirty, true);

    const preview = await getGitPushPreview(projectRoot);
    assert.equal(preview.required, true);
    assert.equal(preview.files.find((item) => item.file === "main.tex")?.recommended, true);
    assert.equal(preview.files.find((item) => item.file === "notes.txt")?.recommended, false);
    assert.equal(preview.files.some((item) => item.file === "main.pdf"), false);

    const pushed = await pushGitRepository(projectRoot, "Initial paper import", {
      confirmed: true,
      files: ["main.tex"]
    });
    assert.equal(pushed.pushed, true);
    assert.match(await git(["show", "main:main.tex"], remoteRoot), /complete paper paragraph/);
    const pdfResult = await execGit(["show", "main:main.pdf"], remoteRoot, { maxBuffer: 4 * 1024 * 1024 });
    assert.notEqual(pdfResult.exitCode, 0);
    const notesResult = await execGit(["show", "main:notes.txt"], remoteRoot, { maxBuffer: 4 * 1024 * 1024 });
    assert.notEqual(notesResult.exitCode, 0);
    status = await getGitStatus(projectRoot);
    assert.equal(status.dirty, true);
    assert.ok(status.changedFiles.some((file) => file.includes("notes.txt")));
    assert.equal(status.ahead, 0);
    assert.equal(status.behind, 0);
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Overleaf push stages new paper files without requiring a local compile", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-overleaf-push-"));
  const seedRoot = path.join(root, "seed");
  const projectRoot = path.join(root, "paper");
  const remoteRoot = path.join(root, "overleaf.git");
  try {
    await fs.mkdir(seedRoot);
    await git(["init", "--bare", remoteRoot], root);
    await git(["init"], seedRoot);
    await git(["config", "user.name", "PaperBridge Test"], seedRoot);
    await git(["config", "user.email", "test@paperbridge.local"], seedRoot);
    await fs.writeFile(
      path.join(seedRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nOriginal Overleaf paragraph.\n\\end{document}\n",
      "utf8"
    );
    await git(["add", "main.tex"], seedRoot);
    await git(["commit", "-m", "Initial Overleaf paper"], seedRoot);
    await git(["branch", "-M", "main"], seedRoot);
    await git(["remote", "add", "overleaf", remoteRoot], seedRoot);
    await git(["push", "-u", "overleaf", "main"], seedRoot);
    await git(["symbolic-ref", "HEAD", "refs/heads/main"], remoteRoot);

    configureProjectRuntime({ getOverleafToken: () => "test-overleaf-token" });
    await git(["clone", "--origin", "overleaf", remoteRoot, projectRoot], root);
    await git(["config", "user.name", "PaperBridge Test"], projectRoot);
    await git(["config", "user.email", "test@paperbridge.local"], projectRoot);
    await fs.writeFile(
      path.join(projectRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nOriginal Overleaf paragraph.\n\\input{section}\n\\end{document}\n",
      "utf8"
    );
    await fs.writeFile(path.join(projectRoot, "section.tex"), "A new pushed section paragraph.\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "notes.txt"), "private notes should not be auto-staged for Overleaf.\n", "utf8");

    let status = await getGitStatus(projectRoot);
    assert.equal(status.overleaf, true);
    assert.equal(status.dirty, true);
    assert.ok(status.changedFiles.some((file) => file.includes("main.tex")));
    assert.ok(status.changedFiles.some((file) => file.includes("section.tex")));
    assert.ok(!status.changedFiles.some((file) => file.includes("notes.txt")));

    const pushed = await pushProject(projectRoot, "Update Overleaf paper");
    assert.equal(pushed.pushed, true);
    assert.match(await git(["show", "main:section.tex"], remoteRoot), /new pushed section/);
    const notesResult = await execGit(["show", "main:notes.txt"], remoteRoot, { maxBuffer: 4 * 1024 * 1024 });
    assert.notEqual(notesResult.exitCode, 0);
    status = await getGitStatus(projectRoot);
    assert.equal(status.dirty, false);
    assert.equal(status.ahead, 0);
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Overleaf push rebases newer remote changes before pushing local edits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-overleaf-rebase-"));
  const seedRoot = path.join(root, "seed");
  const projectRoot = path.join(root, "paper");
  const remoteRoot = path.join(root, "overleaf.git");
  try {
    await fs.mkdir(seedRoot);
    await git(["init", "--bare", remoteRoot], root);
    await git(["init"], seedRoot);
    await git(["config", "user.name", "PaperBridge Test"], seedRoot);
    await git(["config", "user.email", "test@paperbridge.local"], seedRoot);
    await fs.writeFile(
      path.join(seedRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nOriginal Overleaf paragraph.\n\\end{document}\n",
      "utf8"
    );
    await git(["add", "main.tex"], seedRoot);
    await git(["commit", "-m", "Initial Overleaf paper"], seedRoot);
    await git(["branch", "-M", "main"], seedRoot);
    await git(["remote", "add", "overleaf", remoteRoot], seedRoot);
    await git(["push", "-u", "overleaf", "main"], seedRoot);
    await git(["symbolic-ref", "HEAD", "refs/heads/main"], remoteRoot);

    configureProjectRuntime({ getOverleafToken: () => "test-overleaf-token" });
    await git(["clone", "--origin", "overleaf", remoteRoot, projectRoot], root);
    await git(["config", "user.name", "PaperBridge Test"], projectRoot);
    await git(["config", "user.email", "test@paperbridge.local"], projectRoot);

    await fs.writeFile(path.join(seedRoot, "remote.tex"), "A newer Overleaf-side paragraph.\n", "utf8");
    await git(["add", "remote.tex"], seedRoot);
    await git(["commit", "-m", "Edit on Overleaf"], seedRoot);
    await git(["push", "overleaf", "main"], seedRoot);

    await fs.writeFile(
      path.join(projectRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nOriginal Overleaf paragraph.\n\\input{local}\n\\end{document}\n",
      "utf8"
    );
    await fs.writeFile(path.join(projectRoot, "local.tex"), "A local PaperBridge paragraph.\n", "utf8");

    const pushed = await pushProject(projectRoot, "Update local PaperBridge paper");
    assert.equal(pushed.pushed, true);
    assert.match(await git(["show", "main:remote.tex"], remoteRoot), /Overleaf-side paragraph/);
    assert.match(await git(["show", "main:local.tex"], remoteRoot), /local PaperBridge paragraph/);
    assert.match(await git(["show", "main:main.tex"], remoteRoot), /\\input\{local\}/);
    const status = await getGitStatus(projectRoot);
    assert.equal(status.dirty, false);
    assert.equal(status.ahead, 0);
    assert.equal(status.behind, 0);
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Overleaf pull keeps the newer remote version without a manual conflict loop", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-overleaf-pull-newer-remote-"));
  const seedRoot = path.join(root, "seed");
  const projectRoot = path.join(root, "paper");
  const remoteRoot = path.join(root, "overleaf.git");
  try {
    await fs.mkdir(seedRoot);
    await git(["init", "--bare", remoteRoot], root);
    await git(["init"], seedRoot);
    await git(["config", "user.name", "PaperBridge Test"], seedRoot);
    await git(["config", "user.email", "test@paperbridge.local"], seedRoot);
    await fs.writeFile(
      path.join(seedRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nOriginal paragraph.\n\\end{document}\n",
      "utf8"
    );
    await git(["add", "main.tex"], seedRoot);
    await git(["commit", "--date=2026-01-01T00:00:00+0000", "-m", "Initial Overleaf paper"], seedRoot);
    await git(["branch", "-M", "main"], seedRoot);
    await git(["remote", "add", "overleaf", remoteRoot], seedRoot);
    await git(["push", "-u", "overleaf", "main"], seedRoot);
    await git(["symbolic-ref", "HEAD", "refs/heads/main"], remoteRoot);

    configureProjectRuntime({ getOverleafToken: () => "test-overleaf-token" });
    await git(["clone", "--origin", "overleaf", remoteRoot, projectRoot], root);
    await git(["config", "user.name", "PaperBridge Test"], projectRoot);
    await git(["config", "user.email", "test@paperbridge.local"], projectRoot);

    await fs.writeFile(
      path.join(projectRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nOlder local paragraph.\n\\end{document}\n",
      "utf8"
    );
    await git(["add", "main.tex"], projectRoot);
    await git(["commit", "--date=2026-01-02T00:00:00+0000", "-m", "Older local edit"], projectRoot);

    await fs.writeFile(
      path.join(seedRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nNewer Overleaf paragraph.\n\\end{document}\n",
      "utf8"
    );
    await git(["add", "main.tex"], seedRoot);
    await git(["commit", "--date=2026-01-03T00:00:00+0000", "-m", "Newer Overleaf edit"], seedRoot);
    await git(["push", "overleaf", "main"], seedRoot);

    const status = await pullProject(projectRoot);
    assert.equal(status.dirty, false);
    assert.equal(status.behind, 0);
    assert.match(await fs.readFile(path.join(projectRoot, "main.tex"), "utf8"), /Newer Overleaf paragraph/);
    assert.doesNotMatch(await fs.readFile(path.join(projectRoot, "main.tex"), "utf8"), /<<<<<<< HEAD/);
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Overleaf push keeps the newer local version before uploading", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-overleaf-push-newer-local-"));
  const seedRoot = path.join(root, "seed");
  const projectRoot = path.join(root, "paper");
  const remoteRoot = path.join(root, "overleaf.git");
  try {
    await fs.mkdir(seedRoot);
    await git(["init", "--bare", remoteRoot], root);
    await git(["init"], seedRoot);
    await git(["config", "user.name", "PaperBridge Test"], seedRoot);
    await git(["config", "user.email", "test@paperbridge.local"], seedRoot);
    await fs.writeFile(
      path.join(seedRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nOriginal paragraph.\n\\end{document}\n",
      "utf8"
    );
    await git(["add", "main.tex"], seedRoot);
    await git(["commit", "--date=2026-01-01T00:00:00+0000", "-m", "Initial Overleaf paper"], seedRoot);
    await git(["branch", "-M", "main"], seedRoot);
    await git(["remote", "add", "overleaf", remoteRoot], seedRoot);
    await git(["push", "-u", "overleaf", "main"], seedRoot);
    await git(["symbolic-ref", "HEAD", "refs/heads/main"], remoteRoot);

    configureProjectRuntime({ getOverleafToken: () => "test-overleaf-token" });
    await git(["clone", "--origin", "overleaf", remoteRoot, projectRoot], root);
    await git(["config", "user.name", "PaperBridge Test"], projectRoot);
    await git(["config", "user.email", "test@paperbridge.local"], projectRoot);

    await fs.writeFile(
      path.join(seedRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nOlder Overleaf paragraph.\n\\end{document}\n",
      "utf8"
    );
    await git(["add", "main.tex"], seedRoot);
    await git(["commit", "--date=2026-01-02T00:00:00+0000", "-m", "Older Overleaf edit"], seedRoot);
    await git(["push", "overleaf", "main"], seedRoot);

    await fs.writeFile(
      path.join(projectRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nNewer local paragraph.\n\\end{document}\n",
      "utf8"
    );
    await git(["add", "main.tex"], projectRoot);
    await git(["commit", "--date=2026-01-03T00:00:00+0000", "-m", "Newer local edit"], projectRoot);

    const pushed = await pushProject(projectRoot, "Upload newest local paper");
    assert.equal(pushed.pushed, true);
    assert.match(await git(["show", "main:main.tex"], remoteRoot), /Newer local paragraph/);
    assert.doesNotMatch(await git(["show", "main:main.tex"], remoteRoot), /<<<<<<< HEAD/);
    const status = await getGitStatus(projectRoot);
    assert.equal(status.dirty, false);
    assert.equal(status.ahead, 0);
    assert.equal(status.behind, 0);
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Overleaf pull reports conflicting files and resolves with the selected remote version", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-overleaf-pull-conflict-"));
  const seedRoot = path.join(root, "seed");
  const projectRoot = path.join(root, "paper");
  const remoteRoot = path.join(root, "overleaf.git");
  try {
    await fs.mkdir(seedRoot);
    await git(["init", "--bare", remoteRoot], root);
    await git(["init"], seedRoot);
    await git(["config", "user.name", "PaperBridge Test"], seedRoot);
    await git(["config", "user.email", "test@paperbridge.local"], seedRoot);
    await fs.writeFile(
      path.join(seedRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nOriginal Overleaf paragraph.\n\\end{document}\n",
      "utf8"
    );
    await git(["add", "main.tex"], seedRoot);
    await git(["commit", "-m", "Initial Overleaf paper"], seedRoot);
    await git(["branch", "-M", "main"], seedRoot);
    await git(["remote", "add", "overleaf", remoteRoot], seedRoot);
    await git(["push", "-u", "overleaf", "main"], seedRoot);
    await git(["symbolic-ref", "HEAD", "refs/heads/main"], remoteRoot);

    configureProjectRuntime({ getOverleafToken: () => "test-overleaf-token" });
    await git(["clone", "--origin", "overleaf", remoteRoot, projectRoot], root);
    await git(["config", "user.name", "PaperBridge Test"], projectRoot);
    await git(["config", "user.email", "test@paperbridge.local"], projectRoot);

    await fs.writeFile(
      path.join(seedRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nRemote Overleaf paragraph.\n\\end{document}\n",
      "utf8"
    );
    await git(["add", "main.tex"], seedRoot);
    await git(["commit", "--date=2026-01-02T00:00:00+0000", "-m", "Edit same paragraph on Overleaf"], seedRoot);
    await git(["push", "overleaf", "main"], seedRoot);

    await fs.writeFile(
      path.join(projectRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nLocal PaperBridge paragraph.\n\\end{document}\n",
      "utf8"
    );
    await git(["add", "main.tex"], projectRoot);
    await git(["commit", "--date=2026-01-02T00:00:00+0000", "-m", "Edit same paragraph locally"], projectRoot);

    await assert.rejects(
      () => pullProject(projectRoot),
      (error) => {
        assert.equal(error.code, "GIT_SYNC_CONFLICT");
        assert.equal(error.status, 409);
        assert.equal(error.details.operation, "pull");
        assert.equal(error.details.files[0].file, "main.tex");
        assert.match(error.details.files[0].localSnippet, /Local PaperBridge paragraph/);
        assert.match(error.details.files[0].remoteSnippet, /Remote Overleaf paragraph/);
        assert.match(error.details.files[0].diffSnippet, /<<<<<<< HEAD/);
        return true;
      }
    );

    const resolved = await resolveGitSyncConflict(projectRoot, "pull", [
      { file: "main.tex", choice: "remote" }
    ]);
    assert.equal(resolved.resolved, true);
    assert.equal(resolved.pushed, false);
    assert.match(await fs.readFile(path.join(projectRoot, "main.tex"), "utf8"), /Remote Overleaf paragraph/);
    assert.doesNotMatch(await fs.readFile(path.join(projectRoot, "main.tex"), "utf8"), /<<<<<<< HEAD/);
    const status = await getGitStatus(projectRoot);
    assert.equal(status.dirty, false);
    assert.equal(status.behind, 0);
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Overleaf push reports conflicting files and resolves with the selected local version", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-overleaf-push-conflict-"));
  const seedRoot = path.join(root, "seed");
  const projectRoot = path.join(root, "paper");
  const remoteRoot = path.join(root, "overleaf.git");
  try {
    await fs.mkdir(seedRoot);
    await git(["init", "--bare", remoteRoot], root);
    await git(["init"], seedRoot);
    await git(["config", "user.name", "PaperBridge Test"], seedRoot);
    await git(["config", "user.email", "test@paperbridge.local"], seedRoot);
    await fs.writeFile(
      path.join(seedRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nOriginal Overleaf paragraph.\n\\end{document}\n",
      "utf8"
    );
    await git(["add", "main.tex"], seedRoot);
    await git(["commit", "-m", "Initial Overleaf paper"], seedRoot);
    await git(["branch", "-M", "main"], seedRoot);
    await git(["remote", "add", "overleaf", remoteRoot], seedRoot);
    await git(["push", "-u", "overleaf", "main"], seedRoot);
    await git(["symbolic-ref", "HEAD", "refs/heads/main"], remoteRoot);

    configureProjectRuntime({ getOverleafToken: () => "test-overleaf-token" });
    await git(["clone", "--origin", "overleaf", remoteRoot, projectRoot], root);
    await git(["config", "user.name", "PaperBridge Test"], projectRoot);
    await git(["config", "user.email", "test@paperbridge.local"], projectRoot);

    await fs.writeFile(
      path.join(seedRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nRemote Overleaf paragraph.\n\\end{document}\n",
      "utf8"
    );
    await git(["add", "main.tex"], seedRoot);
    await git(["commit", "--date=2026-01-02T00:00:00+0000", "-m", "Edit same paragraph on Overleaf"], seedRoot);
    await git(["push", "overleaf", "main"], seedRoot);

    await fs.writeFile(
      path.join(projectRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nLocal PaperBridge paragraph.\n\\end{document}\n",
      "utf8"
    );
    await git(["add", "main.tex"], projectRoot);
    await git(["commit", "--date=2026-01-02T00:00:00+0000", "-m", "Edit same paragraph locally"], projectRoot);

    await assert.rejects(
      () => pushProject(projectRoot, "Update same paragraph locally"),
      (error) => {
        assert.equal(error.code, "GIT_SYNC_CONFLICT");
        assert.equal(error.status, 409);
        assert.equal(error.details.operation, "push");
        assert.equal(error.details.files[0].file, "main.tex");
        assert.match(error.details.files[0].localSnippet, /Local PaperBridge paragraph/);
        assert.match(error.details.files[0].remoteSnippet, /Remote Overleaf paragraph/);
        return true;
      }
    );

    const resolved = await resolveGitSyncConflict(projectRoot, "push", [
      { file: "main.tex", choice: "local" }
    ]);
    assert.equal(resolved.resolved, true);
    assert.equal(resolved.pushed, true);
    assert.match(await git(["show", "main:main.tex"], remoteRoot), /Local PaperBridge paragraph/);
    assert.doesNotMatch(await git(["show", "main:main.tex"], remoteRoot), /<<<<<<< HEAD/);
    const status = await getGitStatus(projectRoot);
    assert.equal(status.dirty, false);
    assert.equal(status.ahead, 0);
    assert.equal(status.behind, 0);
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Git repository push merges remote changes instead of asking for pull first", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-git-push-newer-local-"));
  const seedRoot = path.join(root, "seed");
  const projectRoot = path.join(root, "paper");
  const remoteRoot = path.join(root, "remote.git");
  try {
    await fs.mkdir(seedRoot);
    await git(["init", "--bare", remoteRoot], root);
    await git(["init"], seedRoot);
    await git(["config", "user.name", "PaperBridge Test"], seedRoot);
    await git(["config", "user.email", "test@paperbridge.local"], seedRoot);
    await fs.writeFile(
      path.join(seedRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nOriginal paragraph.\n\\end{document}\n",
      "utf8"
    );
    await git(["add", "main.tex"], seedRoot);
    await git(["commit", "--date=2026-01-01T00:00:00+0000", "-m", "Initial paper"], seedRoot);
    await git(["branch", "-M", "main"], seedRoot);
    await git(["remote", "add", "paperbridge", remoteRoot], seedRoot);
    await git(["push", "-u", "paperbridge", "main"], seedRoot);
    await git(["symbolic-ref", "HEAD", "refs/heads/main"], remoteRoot);

    configureProjectRuntime({ getGitUsername: () => "", getGitToken: () => "" });
    await git(["clone", "--origin", "paperbridge", remoteRoot, projectRoot], root);
    await git(["config", "user.name", "PaperBridge Test"], projectRoot);
    await git(["config", "user.email", "test@paperbridge.local"], projectRoot);

    await fs.writeFile(
      path.join(seedRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nOlder remote paragraph.\n\\end{document}\n",
      "utf8"
    );
    await git(["add", "main.tex"], seedRoot);
    await git(["commit", "--date=2026-01-02T00:00:00+0000", "-m", "Older remote edit"], seedRoot);
    await git(["push", "paperbridge", "main"], seedRoot);

    await fs.writeFile(
      path.join(projectRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nNewer local paragraph.\n\\end{document}\n",
      "utf8"
    );

    const pushed = await pushGitRepository(projectRoot, "Upload newest local paper");
    assert.equal(pushed.pushed, true);
    assert.match(await git(["show", "main:main.tex"], remoteRoot), /Newer local paragraph/);
    assert.doesNotMatch(await git(["show", "main:main.tex"], remoteRoot), /<<<<<<< HEAD/);
    const status = await getGitStatus(projectRoot);
    assert.equal(status.dirty, false);
    assert.equal(status.ahead, 0);
    assert.equal(status.behind, 0);
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Git repository pull saves dirty local edits and keeps the newer remote file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-git-pull-newer-remote-"));
  const seedRoot = path.join(root, "seed");
  const projectRoot = path.join(root, "paper");
  const remoteRoot = path.join(root, "remote.git");
  try {
    await fs.mkdir(seedRoot);
    await git(["init", "--bare", remoteRoot], root);
    await git(["init"], seedRoot);
    await git(["config", "user.name", "PaperBridge Test"], seedRoot);
    await git(["config", "user.email", "test@paperbridge.local"], seedRoot);
    await fs.writeFile(
      path.join(seedRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nOriginal paragraph.\n\\end{document}\n",
      "utf8"
    );
    await git(["add", "main.tex"], seedRoot);
    await git(["commit", "--date=2026-01-01T00:00:00+0000", "-m", "Initial paper"], seedRoot);
    await git(["branch", "-M", "main"], seedRoot);
    await git(["remote", "add", "paperbridge", remoteRoot], seedRoot);
    await git(["push", "-u", "paperbridge", "main"], seedRoot);
    await git(["symbolic-ref", "HEAD", "refs/heads/main"], remoteRoot);

    configureProjectRuntime({ getGitUsername: () => "", getGitToken: () => "" });
    await git(["clone", "--origin", "paperbridge", remoteRoot, projectRoot], root);
    await git(["config", "user.name", "PaperBridge Test"], projectRoot);
    await git(["config", "user.email", "test@paperbridge.local"], projectRoot);

    await fs.writeFile(
      path.join(seedRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nNewer remote paragraph.\n\\end{document}\n",
      "utf8"
    );
    await git(["add", "main.tex"], seedRoot);
    await git(["commit", "--date=2026-01-03T00:00:00+0000", "-m", "Newer remote edit"], seedRoot);
    await git(["push", "paperbridge", "main"], seedRoot);

    const localPath = path.join(projectRoot, "main.tex");
    await fs.writeFile(
      localPath,
      "\\documentclass{article}\n\\begin{document}\nOlder dirty local paragraph.\n\\end{document}\n",
      "utf8"
    );
    const olderLocalTime = new Date("2026-01-02T00:00:00Z");
    await fs.utimes(localPath, olderLocalTime, olderLocalTime);

    const status = await pullProject(projectRoot);
    assert.equal(status.dirty, false);
    assert.equal(status.behind, 0);
    assert.match(await fs.readFile(localPath, "utf8"), /Newer remote paragraph/);
    assert.doesNotMatch(await fs.readFile(localPath, "utf8"), /<<<<<<< HEAD/);
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("projects with Overleaf and GitHub remotes expose an explicit selectable target", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-multiple-remotes-"));
  try {
    await git(["init"], root);
    await git(["config", "user.name", "PaperBridge Test"], root);
    await git(["config", "user.email", "test@paperbridge.local"], root);
    await fs.writeFile(path.join(root, "main.tex"), "\\documentclass{article}\n", "utf8");
    await git(["add", "main.tex"], root);
    await git(["commit", "-m", "Initial paper"], root);
    await git(["remote", "add", "overleaf", "https://git.overleaf.com/1234567890abcdef"], root);
    await git(["remote", "add", "paperbridge", "https://github.com/example/paper.git"], root);

    const defaultStatus = await getGitStatus(root);
    assert.equal(defaultStatus.remoteName, "overleaf");
    assert.equal(defaultStatus.remoteLabel, "Overleaf");
    assert.equal(defaultStatus.remotes.length, 2);

    const githubStatus = await getGitStatus(root, "paperbridge");
    assert.equal(githubStatus.remoteName, "paperbridge");
    assert.equal(githubStatus.provider, "git");
    assert.equal(githubStatus.remoteLabel, "GitHub");
    assert.equal(githubStatus.remoteRepository, "example/paper");
    assert.deepEqual(githubStatus.remotes.map((remote) => remote.name), ["overleaf", "paperbridge"]);
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Git sync UI sends the selected remote through pull, push, and conflict resolution", async () => {
  const appJs = await fs.readFile(path.join(process.cwd(), "public", "app.js"), "utf8");
  const indexHtml = await fs.readFile(path.join(process.cwd(), "public", "index.html"), "utf8");

  assert.match(indexHtml, /id="gitRemoteSelect"/);
  assert.match(appJs, /JSON\.stringify\(\{ remoteName \}\)/);
  assert.match(appJs, /push-preview\?remoteName=/);
  assert.match(appJs, /remoteName:\s*details\.remoteName \|\| state\.gitRemoteName/);
  assert.match(appJs, /files:\s*selection \|\| \[\],\s*remoteName/);
});

test("push UI does not block on local PDF compilation and explains remaining files", async () => {
  const serverJs = await fs.readFile(path.join(process.cwd(), "server.js"), "utf8");
  const appJs = await fs.readFile(path.join(process.cwd(), "public", "app.js"), "utf8");
  const serverStart = serverJs.indexOf('app.post("/api/git/push"');
  const serverBlock = serverJs.slice(serverStart, serverJs.indexOf('app.post("/api/review"', serverStart));
  const pushStart = appJs.indexOf("async function pushPaper()");
  const pushBlock = appJs.slice(pushStart, appJs.indexOf("function renderReview", pushStart));

  assert.doesNotMatch(serverBlock, /compileAndTrackLayout\(\)/);
  assert.match(serverBlock, /project:\s*await getProjectPayload\(/);
  assert.match(pushBlock, /正在提交并推送到 \$\{remoteLabel\}/);
  assert.match(pushBlock, /changedFiles/);
  assert.match(pushBlock, /仍有 \$\{pending\} 个本地文件未提交/);
});

test("bundled Windows Git uses OpenSSL instead of the failing Schannel backend", async () => {
  const projectJs = await fs.readFile(path.join(process.cwd(), "lib", "project.js"), "utf8");
  assert.match(projectJs, /git\.source === "bundled"/);
  assert.match(projectJs, /http\.sslBackend=openssl/);
  assert.match(projectJs, /SEC_E_NO_CREDENTIALS/);
});
