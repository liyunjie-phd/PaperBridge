import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { detectMainTex, listMainTexCandidates, normalizeGitRepositoryUrl, normalizeOverleafGitUrl } from "../lib/setup.js";
import { collectBuildErrors, collectBuildWarnings, compileProject, getDependencyStatus } from "../lib/project.js";

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
    await fs.writeFile(path.join(root, "sections", "sample.tex"), "\\documentclass{article}\n", "utf8");
    assert.equal(await detectMainTex(root), "main.tex");
    assert.deepEqual(await listMainTexCandidates(root), ["main.tex", "draft.tex"]);
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

test("LaTeX errors are separated from non-blocking warnings", () => {
  const log = [
    "LaTeX Warning: Citation `demo' on page 1 undefined.",
    "Overfull \\hbox (2.0pt too wide) in paragraph at lines 1--2",
    "! LaTeX Error: Command \\algorithm already defined."
  ].join("\n");
  const warnings = collectBuildWarnings(log);
  const errors = collectBuildErrors(log);
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((warning) => !warning.includes("LaTeX Error")));
  assert.match(errors[0], /algorithm 与 algorithm2e/);
  assert.ok(errors.some((error) => error.includes("LaTeX Error")));
});

test("a warning-only LaTeX build still produces a previewable PDF", async (t) => {
  const dependencies = await getDependencyStatus();
  if (dependencies.compiler === "missing") {
    t.skip("No LaTeX compiler is available in this environment.");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-warning-build-"));
  try {
    await fs.writeFile(path.join(root, "main.tex"), [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\hbox to 1pt{This intentionally overfull line only creates a warning.}",
      "\\end{document}"
    ].join("\n"), "utf8");
    const build = await compileProject(root, "main.tex");
    assert.equal(build.success, true);
    assert.equal(build.previewAvailable, true);
    assert.equal(build.pdf.exists, true);
    assert.equal(build.errors.length, 0);
    assert.ok(build.warnings.some((warning) => warning.includes("Overfull")));
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});
