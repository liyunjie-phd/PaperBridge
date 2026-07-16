import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyProjectModularization,
  buildModularizationPlan,
  previewProjectModularization
} from "../lib/modularize.js";
import { getDependencyStatus } from "../lib/project.js";

const monolithicPaper = String.raw`\documentclass[twocolumn]{article}
\usepackage{amsmath}
\begin{document}
\section{Introduction}
The introduction contains enough academic prose for the bilingual editor and format migration.
\section{Related Work}
Prior systems use the following local equation format:
\begin{equation}
x = y + 1.
\end{equation}
\bibliographystyle{plain}
\bibliography{refs}
\end{document}
`;

test("modularization keeps global format in main and moves complete sections", () => {
  const plan = buildModularizationPlan(monolithicPaper, "main.tex", ["introduction.tex"]);
  assert.equal(plan.eligible, true);
  assert.deepEqual(plan.sections.map((section) => section.file), ["introduction_2.tex", "related_work.tex"]);
  assert.match(plan.mainContent, /documentclass\[twocolumn\]/);
  assert.match(plan.mainContent, /\\input\{introduction_2\}/);
  assert.match(plan.mainContent, /\\bibliographystyle\{plain\}/);
  assert.doesNotMatch(plan.mainContent, /enough academic prose/);
  assert.match(plan.sections[1].content, /\\begin\{equation\}/);
  assert.doesNotMatch(plan.sections[1].content, /\\bibliography/);
});

test("modularization detects an already modular main file", () => {
  const plan = buildModularizationPlan([
    "\\documentclass{article}",
    "\\begin{document}",
    "\\input{introduction}",
    "\\end{document}"
  ].join("\n"), "main.tex", ["introduction.tex"]);
  assert.equal(plan.eligible, false);
  assert.equal(plan.mode, "modular");
});

test("modularization preview requires referenced Bib files and rejects inline bibliography", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-modularize-bib-check-"));
  try {
    await fs.writeFile(path.join(root, "main.tex"), [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{Introduction}",
      "Enough academic prose appears in this introduction for project structure detection.",
      "\\begin{thebibliography}{1}",
      "\\bibitem{example} Example reference.",
      "\\end{thebibliography}",
      "\\end{document}"
    ].join("\n"), "utf8");
    let preview = await previewProjectModularization(root, "main.tex");
    assert.equal(preview.eligible, false);
    assert.equal(preview.mode, "bibliography-required");
    assert.match(preview.reason, /thebibliography/);

    await fs.writeFile(path.join(root, "main.tex"), monolithicPaper, "utf8");
    preview = await previewProjectModularization(root, "main.tex");
    assert.equal(preview.eligible, false);
    assert.deepEqual(preview.bibliography.missing, ["refs.bib"]);
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("project modularization compiles and retains a recoverable main backup", async (t) => {
  const dependencies = await getDependencyStatus();
  if (dependencies.compiler === "missing") {
    t.skip("No LaTeX compiler is available.");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-modularize-"));
  const projectRoot = path.join(root, "project");
  const backupRoot = path.join(root, "backup");
  try {
    await fs.mkdir(path.join(projectRoot, "paper"), { recursive: true });
    const compilable = monolithicPaper.replace("\\bibliographystyle{plain}\n\\bibliography{refs}\n", "");
    await fs.writeFile(path.join(projectRoot, "paper", "main.tex"), compilable, "utf8");
    const preview = await previewProjectModularization(projectRoot, "paper/main.tex");
    const result = await applyProjectModularization({
      projectRoot,
      mainTex: "paper/main.tex",
      expectedFingerprint: preview.fingerprint,
      backupRoot
    });
    assert.equal(result.build.success, true);
    assert.deepEqual(result.sections.map((section) => section.file), ["paper/introduction.tex", "paper/related_work.tex"]);
    assert.equal(await fs.readFile(path.join(backupRoot, "main.tex"), "utf8"), compilable);
    assert.match(await fs.readFile(path.join(projectRoot, "paper", "main.tex"), "utf8"), /\\input\{related_work\}/);
    assert.match(await fs.readFile(path.join(projectRoot, "paper", "related_work.tex"), "utf8"), /\\begin\{equation\}/);
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("project modularization restores the original project after compile failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-modularize-rollback-"));
  const projectRoot = path.join(root, "project");
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(projectRoot, "main.tex"), monolithicPaper, "utf8");
    await fs.writeFile(path.join(projectRoot, "refs.bib"), "@misc{example, title={Example}}\n", "utf8");
    const preview = await previewProjectModularization(projectRoot, "main.tex");
    await assert.rejects(applyProjectModularization({
      projectRoot,
      mainTex: "main.tex",
      expectedFingerprint: preview.fingerprint,
      backupRoot: path.join(root, "backup"),
      compile: async () => ({ success: false, errors: ["synthetic compile failure"] })
    }), (error) => error.code === "MODULARIZATION_COMPILE_FAILED");
    assert.equal(await fs.readFile(path.join(projectRoot, "main.tex"), "utf8"), monolithicPaper);
    await assert.rejects(fs.access(path.join(projectRoot, "introduction.tex")), { code: "ENOENT" });
    await assert.rejects(fs.access(path.join(projectRoot, "related_work.tex")), { code: "ENOENT" });

    const secondPreview = await previewProjectModularization(projectRoot, "main.tex");
    await assert.rejects(applyProjectModularization({
      projectRoot,
      mainTex: "main.tex",
      expectedFingerprint: secondPreview.fingerprint,
      backupRoot: path.join(root, "backup-state"),
      compile: async () => ({ success: true, pdf: { pages: 1 }, errors: [] }),
      afterApply: async () => {
        throw new Error("synthetic state migration failure");
      }
    }), /synthetic state migration failure/);
    assert.equal(await fs.readFile(path.join(projectRoot, "main.tex"), "utf8"), monolithicPaper);
    await assert.rejects(fs.access(path.join(projectRoot, "introduction.tex")), { code: "ENOENT" });
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});
