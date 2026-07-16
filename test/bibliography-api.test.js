import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getDependencyStatus } from "../lib/project.js";
import { startServer, stopServer } from "../server.js";

test("inline references migrate to Bib and no longer block chapter modularization", async (t) => {
  const dependencies = await getDependencyStatus();
  if (dependencies.compiler === "missing") {
    t.skip("No LaTeX compiler is available.");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-bibliography-api-"));
  const projectRoot = path.join(root, "project");
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(projectRoot, "main.tex"), [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{Introduction}",
      "The introduction contains enough academic prose for editing and cites prior work \\cite{example}.",
      "\\section{Method}",
      "The method section contains enough academic prose for a separate chapter file.",
      "\\begin{thebibliography}{1}",
      "\\bibitem{example} Example Author, \\emph{Example Reference}, 2026.",
      "\\bibitem{uncited} Background Author, Background Reference, 2025.",
      "\\end{thebibliography}",
      "\\end{document}"
    ].join("\n"), "utf8");

    const server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data"),
      projectsRoot: path.join(root, "projects")
    });
    const request = async (url, options = {}) => {
      const response = await fetch(`${server.url}${url}`, {
        headers: { "Content-Type": "application/json" },
        ...options
      });
      const payload = await response.json();
      assert.equal(response.ok, true, payload.error);
      return payload;
    };
    const post = (url, body = {}) => request(url, { method: "POST", body: JSON.stringify(body) });
    const provider = {
      type: "openai-compatible",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "test-key",
      model: "test-model",
      jsonMode: true
    };
    await post("/api/setup", {
      source: { mode: "local", localPath: projectRoot },
      translation: provider,
      review: provider,
      autoCompile: false
    });

    let preview = await post("/api/project/modularize/preview");
    assert.equal(preview.mode, "bibliography-required");
    assert.equal(preview.bibliographyMigration.eligible, true);
    assert.deepEqual(preview.bibliographyMigration.entries.map((entry) => entry.key), ["example", "uncited"]);
    assert.deepEqual(preview.bibliographyMigration.files.map((file) => file.file), ["references.bib"]);

    const migrated = await post("/api/project/bibliography/migrate", {
      confirmed: true,
      fingerprint: preview.bibliographyMigration.fingerprint
    });
    assert.equal(migrated.build.success, true);
    assert.ok(migrated.project.sourceFiles.includes("references.bib"));
    assert.match((await request("/api/source?file=references.bib")).content, /@misc\{example,/);

    preview = await post("/api/project/modularize/preview");
    assert.equal(preview.eligible, true);
    assert.equal(preview.bibliography.inline, false);
    assert.deepEqual(preview.bibliography.files, ["references.bib"]);
    const modularized = await post("/api/project/modularize/apply", {
      confirmed: true,
      fingerprint: preview.fingerprint
    });
    assert.equal(modularized.build.success, true);
    assert.deepEqual(modularized.project.sourceFiles, ["main.tex", "introduction.tex", "method.tex", "references.bib"]);
    const finalMain = await fs.readFile(path.join(projectRoot, "main.tex"), "utf8");
    assert.doesNotMatch(finalMain, /thebibliography/);
    assert.match(finalMain, /\\input\{introduction\}/);
    assert.match(finalMain, /\\bibliography\{references\}/);
    assert.match(finalMain, /\\nocite\{uncited\}/);
  } finally {
    await stopServer();
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});
