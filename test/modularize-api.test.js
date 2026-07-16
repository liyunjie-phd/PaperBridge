import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getDependencyStatus } from "../lib/project.js";
import { startServer, stopServer } from "../server.js";

test("modularization API preserves Chinese drafts and exposes the referenced Bib file", async (t) => {
  const dependencies = await getDependencyStatus();
  if (dependencies.compiler === "missing") {
    t.skip("No LaTeX compiler is available.");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-modularize-api-"));
  const projectRoot = path.join(root, "project");
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(projectRoot, "main.tex"), [
      "\\documentclass[twocolumn]{article}",
      "\\begin{document}",
      "\\section{Introduction}",
      "The introduction contains enough academic prose for bilingual editing and cites prior work \\cite{example}.",
      "\\section{Related Work}",
      "The related work section contains enough academic prose for a separate local format stage.",
      "\\bibliographystyle{plain}",
      "\\bibliography{refs}",
      "\\end{document}"
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(projectRoot, "refs.bib"), [
      "@misc{example,",
      "  author = {Example Author},",
      "  title = {Example Reference},",
      "  year = {2026}",
      "}"
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
    const original = await request("/api/document?file=main.tex");
    assert.equal(original.segments.length, 2);
    await post("/api/segment/chinese", {
      file: "main.tex",
      index: 0,
      chinese: "这是引言的中文工作稿。"
    });
    await post("/api/segment/chinese", {
      file: "main.tex",
      index: 1,
      chinese: "这是相关工作的中文工作稿。"
    });

    const preview = await post("/api/project/modularize/preview");
    assert.equal(preview.eligible, true);
    assert.deepEqual(preview.workflow.local.files, ["introduction.tex", "related_work.tex"]);
    assert.deepEqual(preview.workflow.references.files, ["refs.bib"]);
    const result = await post("/api/project/modularize/apply", {
      confirmed: true,
      fingerprint: preview.fingerprint
    });
    assert.equal(result.build.success, true);
    assert.deepEqual(result.project.sourceFiles, ["main.tex", "introduction.tex", "related_work.tex", "refs.bib"]);
    assert.equal((await request("/api/document?file=introduction.tex")).segments[0].chinese, "这是引言的中文工作稿。");
    assert.equal((await request("/api/document?file=related_work.tex")).segments[0].chinese, "这是相关工作的中文工作稿。");
    assert.match((await request("/api/source?file=refs.bib")).content, /Example Reference/);
    const modularMain = await fs.readFile(path.join(projectRoot, "main.tex"), "utf8");
    assert.match(modularMain, /\\input\{introduction\}/);
    assert.match(modularMain, /\\bibliography\{refs\}/);
    assert.doesNotMatch(modularMain, /enough academic prose/);
  } finally {
    await stopServer();
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});
