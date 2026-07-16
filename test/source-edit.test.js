import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer, stopServer } from "../server.js";

test("TeX source API saves atomically, rejects stale edits, and retains three backups", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-source-api-"));
  const projectRoot = path.join(root, "project");
  const dataRoot = path.join(root, "data");
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(projectRoot, "main.tex"), [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\input{section}",
      "\\bibliographystyle{plain}",
      "\\bibliography{refs}",
      "\\end{document}"
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(projectRoot, "section.tex"), "Original section text.\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "refs.bib"), "@misc{example, title={Original reference}}\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "unused.bib"), "@misc{unused, title={Unused reference}}\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "unused.tex"), "Not part of the paper.\n", "utf8");

    const server = await startServer({ port: 0, dataRoot, projectsRoot: path.join(root, "projects") });
    const request = async (url, options = {}) => {
      const response = await fetch(`${server.url}${url}`, {
        headers: { "Content-Type": "application/json" },
        ...options
      });
      const payload = await response.json();
      return { response, payload };
    };
    const post = (url, body) => request(url, { method: "POST", body: JSON.stringify(body) });
    const provider = {
      type: "openai-compatible",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "test-key",
      model: "test-model",
      jsonMode: true
    };

    let result = await post("/api/setup", {
      source: { mode: "local", localPath: projectRoot },
      translation: provider,
      review: provider,
      autoCompile: false
    });
    assert.equal(result.response.ok, true, result.payload.error);
    assert.deepEqual(result.payload.texFiles, ["main.tex", "section.tex"]);
    assert.deepEqual(result.payload.bibliographyFiles, ["refs.bib"]);
    assert.deepEqual(result.payload.sourceFiles, ["main.tex", "section.tex", "refs.bib"]);
    assert.equal(result.payload.structure.mode, "modular");
    assert.deepEqual(result.payload.structure.workflow.local.files, ["section.tex"]);

    result = await request("/api/source?file=section.tex");
    assert.equal(result.response.ok, true, result.payload.error);
    const originalHash = result.payload.sourceHash;
    assert.equal(result.payload.content, "Original section text.\n");
    assert.equal(result.payload.eol, "\n");

    result = await post("/api/source", {
      file: "section.tex",
      content: "First PaperBridge edit.\n",
      sourceHash: originalHash
    });
    assert.equal(result.response.ok, true, result.payload.error);
    assert.equal(result.payload.build.skipped, true);
    assert.equal(await fs.readFile(path.join(projectRoot, "section.tex"), "utf8"), "First PaperBridge edit.\n");

    const stale = await post("/api/source", {
      file: "section.tex",
      content: "Stale edit.\n",
      sourceHash: originalHash
    });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.payload.code, "SOURCE_CHANGED");

    let source = result.payload.source;
    for (let index = 0; index < 4; index += 1) {
      result = await post("/api/source", {
        file: "section.tex",
        content: `Saved revision ${index}.\n`,
        sourceHash: source.sourceHash
      });
      assert.equal(result.response.ok, true, result.payload.error);
      source = result.payload.source;
    }

    const backupRoot = path.join(dataRoot, "source-backups");
    const backupFiles = (await fs.readdir(backupRoot, { recursive: true })).filter((name) => name.endsWith(".bak"));
    assert.equal(backupFiles.length, 3);

    result = await request("/api/source?file=refs.bib");
    assert.equal(result.response.ok, true, result.payload.error);
    const bibHash = result.payload.sourceHash;
    result = await post("/api/source", {
      file: "refs.bib",
      content: "@misc{example, title={Updated reference}}\n",
      sourceHash: bibHash
    });
    assert.equal(result.response.ok, true, result.payload.error);
    assert.match(await fs.readFile(path.join(projectRoot, "refs.bib"), "utf8"), /Updated reference/);

    const outside = await request("/api/source?file=unused.tex");
    assert.equal(outside.response.ok, false);
    const unusedBib = await request("/api/source?file=unused.bib");
    assert.equal(unusedBib.response.ok, false);
    const escaped = await request("/api/source?file=..%2Foutside.tex");
    assert.equal(escaped.response.ok, false);
  } finally {
    await stopServer();
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});
