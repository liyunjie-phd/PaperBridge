import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer, stopServer } from "../server.js";

test("document API exposes editable math blocks and saves formula TeX", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-math-block-"));
  const projectRoot = path.join(root, "project");
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(
      path.join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{Method}",
        "This paragraph contains enough academic words to remain editable in the bilingual editor.",
        "",
        "\\begin{equation}",
        "E = mc^2",
        "\\end{equation}",
        "",
        "\\[",
        "a = b + c",
        "\\]",
        "",
        "Another paragraph contains enough academic words after the formula for editing.",
        "\\end{document}"
      ].join("\n"),
      "utf8"
    );

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
    const post = (url, body) => request(url, { method: "POST", body: JSON.stringify(body) });
    const provider = {
      type: "openai-compatible",
      baseUrl: "http://127.0.0.1",
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

    const document = await request("/api/document?file=main.tex");
    assert.equal(document.segments.length, 2);
    assert.equal(document.mathBlocks.length, 2);
    assert.match(document.mathBlocks[0].source, /E = mc\^2/);
    assert.match(document.mathBlocks[1].source, /a = b \+ c/);
    assert.equal(document.mathBlocks[0].headingPath[0].title, "Method");

    const nextFormula = [
      "\\begin{equation}",
      "E = mc^2 + b",
      "\\end{equation}"
    ].join("\n");
    const saved = await post("/api/math-block", {
      file: "main.tex",
      id: document.mathBlocks[0].id,
      sourceHash: document.mathBlocks[0].sourceHash,
      startLine: document.mathBlocks[0].startLine,
      source: nextFormula,
      deferCompile: true
    });

    assert.equal(saved.build, null);
    assert.match(saved.document.mathBlocks[0].source, /E = mc\^2 \+ b/);
    assert.match(await fs.readFile(path.join(projectRoot, "main.tex"), "utf8"), /E = mc\^2 \+ b/);
  } finally {
    await stopServer();
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});
