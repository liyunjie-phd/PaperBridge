import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyProjectBibliographyMigration,
  buildBibliographyMigrationPlan,
  previewProjectBibliographyMigration
} from "../lib/bibliography.js";
import { inspectBibliographyFiles } from "../lib/latex.js";
import { getDependencyStatus } from "../lib/project.js";

const inlinePaper = String.raw`\documentclass[conference]{IEEEtran}
\begin{document}
\section{Introduction}
This manuscript cites the primary reference \cite{primary}.
\begin{thebibliography}{00}
\bibitem{primary} A. Author, "Primary Title," \emph{Example Journal}, 2025.
\bibitem{background} B. Author, "Background Title," Example Press, 2024.
\end{thebibliography}
\end{document}
`;

test("inline bibitems migrate without changing citation keys or dropping uncited entries", () => {
  const plan = buildBibliographyMigrationPlan(inlinePaper, "main.tex", ["main.tex"]);
  assert.equal(plan.eligible, true);
  assert.equal(plan.style, "IEEEtran");
  assert.deepEqual(plan.entries.map((entry) => entry.key), ["primary", "background"]);
  assert.deepEqual(plan.uncitedKeys, ["background"]);
  assert.deepEqual(plan.files.map((file) => file.file), ["references.bib"]);
  assert.match(plan.files[0].content, /@misc\{primary,/);
  assert.match(plan.files[0].content, /Primary Title/);
  assert.match(plan.files[0].content, /@misc\{background,/);
  assert.doesNotMatch(plan.mainContent, /thebibliography/);
  assert.match(plan.mainContent, /\\bibliographystyle\{IEEEtran\}/);
  assert.match(plan.mainContent, /\\nocite\{background\}/);
  assert.match(plan.mainContent, /\\bibliography\{references\}/);
  assert.match(plan.mainContent, /\\cite\{primary\}/);
});

test("inline filecontents moves to its named Bib file and keeps the existing bibliography call", () => {
  const content = String.raw`\documentclass{article}
\begin{filecontents*}{refs.bib}
@article{example, title={Example Title}, year={2026}}
\end{filecontents*}
\begin{document}
\section{Introduction}
This paper cites an example \cite{example}.
\bibliographystyle{plain}
\bibliography{refs}
\end{document}
`;
  const plan = buildBibliographyMigrationPlan(content, "main.tex", ["main.tex"]);
  assert.equal(plan.eligible, true);
  assert.deepEqual(plan.files.map((file) => file.file), ["refs.bib"]);
  assert.match(plan.files[0].content, /@article\{example/);
  assert.doesNotMatch(plan.mainContent, /filecontents/);
  assert.match(plan.mainContent, /\\bibliography\{refs\}/);
});

test("bibliography migration compiles and exposes a standalone Bib file", async (t) => {
  const dependencies = await getDependencyStatus();
  if (dependencies.compiler === "missing") {
    t.skip("No LaTeX compiler is available.");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-bibliography-"));
  const projectRoot = path.join(root, "project");
  try {
    await fs.mkdir(projectRoot);
    const compilable = inlinePaper.replace("[conference]{IEEEtran}", "{article}");
    await fs.writeFile(path.join(projectRoot, "main.tex"), compilable, "utf8");
    const preview = await previewProjectBibliographyMigration(projectRoot, "main.tex");
    assert.equal(preview.eligible, true);
    const result = await applyProjectBibliographyMigration({
      projectRoot,
      mainTex: "main.tex",
      expectedFingerprint: preview.fingerprint,
      backupRoot: path.join(root, "backup")
    });
    assert.equal(result.build.success, true);
    assert.deepEqual(result.entries, ["primary", "background"]);
    assert.match(await fs.readFile(path.join(projectRoot, "references.bib"), "utf8"), /Background Title/);
    const bibliography = await inspectBibliographyFiles(projectRoot, "main.tex");
    assert.equal(bibliography.inline, false);
    assert.deepEqual(bibliography.files, ["references.bib"]);
    assert.deepEqual(bibliography.missing, []);
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bibliography migration restores main and removes the Bib file after compile failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-bibliography-rollback-"));
  const projectRoot = path.join(root, "project");
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(projectRoot, "main.tex"), inlinePaper, "utf8");
    const preview = await previewProjectBibliographyMigration(projectRoot, "main.tex");
    await assert.rejects(applyProjectBibliographyMigration({
      projectRoot,
      mainTex: "main.tex",
      expectedFingerprint: preview.fingerprint,
      backupRoot: path.join(root, "backup"),
      compile: async () => ({ success: false, errors: ["synthetic failure"] })
    }), (error) => error.code === "BIBLIOGRAPHY_MIGRATION_COMPILE_FAILED");
    assert.equal(await fs.readFile(path.join(projectRoot, "main.tex"), "utf8"), inlinePaper);
    await assert.rejects(fs.access(path.join(projectRoot, "references.bib")), { code: "ENOENT" });
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});
