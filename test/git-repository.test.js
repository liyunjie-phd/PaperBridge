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
  pushGitRepository
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
