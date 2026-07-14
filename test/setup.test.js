import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectMainTex, normalizeGitRepositoryUrl, normalizeOverleafGitUrl } from "../lib/setup.js";

test("Overleaf browser links are converted to authenticated Git URLs", () => {
  assert.equal(
    normalizeOverleafGitUrl("https://cn.overleaf.com/project/68833681546f37c7278d71af"),
    "https://git@git.overleaf.com/68833681546f37c7278d71af"
  );
  assert.equal(
    normalizeOverleafGitUrl("https://git.overleaf.com/68833681546f37c7278d71af"),
    "https://git@git.overleaf.com/68833681546f37c7278d71af"
  );
});

test("main TeX detection prefers main.tex with a document class", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-main-"));
  try {
    await fs.mkdir(path.join(root, "sections"));
    await fs.writeFile(path.join(root, "draft.tex"), "\\documentclass{article}\n", "utf8");
    await fs.writeFile(path.join(root, "main.tex"), "\\documentclass{acmart}\n", "utf8");
    await fs.writeFile(path.join(root, "sections", "intro.tex"), "Introduction\n", "utf8");
    assert.equal(await detectMainTex(root), "main.tex");
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("generic Git repository URLs accept HTTPS and remove embedded credentials", () => {
  assert.equal(
    normalizeGitRepositoryUrl("git clone https://author:secret@github.com/example/paper.git?token=unsafe"),
    "https://github.com/example/paper.git"
  );
  assert.throws(() => normalizeGitRepositoryUrl("git@github.com:example/paper.git"), /HTTPS/);
  assert.throws(() => normalizeGitRepositoryUrl("https://git.overleaf.com/project"), /Overleaf/);
});
