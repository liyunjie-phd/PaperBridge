import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer, stopServer } from "../server.js";

test("paragraph translation writes LaTeX changes directly and makes one provider request", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-latex-safety-"));
  const projectRoot = path.join(root, "project");
  let providerServer;
  let providerOutput = "A safe replacement paragraph contains enough academic words for publication.";
  let providerCalls = 0;
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(
      path.join(projectRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nThe original English paragraph contains enough \\emph{academic} words for editing.\n\\end{document}\n",
      "utf8"
    );
    providerServer = http.createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Consume the request body.
      }
      providerCalls += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: providerOutput } }] }));
    });
    await new Promise((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
    const providerPort = providerServer.address().port;
    const server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data"),
      projectsRoot: path.join(root, "projects")
    });
    const request = async (url, body) => {
      const response = await fetch(`${server.url}${url}`, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
      return { response, payload: await response.json() };
    };
    const provider = {
      type: "openai-compatible",
      baseUrl: `http://127.0.0.1:${providerPort}`,
      apiKey: "test-key",
      model: "test-model",
      jsonMode: true
    };
    let result = await request("/api/setup", {
      source: { mode: "local", localPath: projectRoot },
      translation: provider,
      review: provider,
      autoCompile: false
    });
    assert.equal(result.response.ok, true, JSON.stringify(result.payload));
    result = await request("/api/document?file=main.tex");
    const segment = result.payload.segments[0];

    providerOutput = "Dangerous output \\input{C:/private-file} contains enough academic words.";
    result = await request("/api/segment/translate", {
      file: "main.tex",
      index: segment.index,
      sourceHash: segment.sourceHash,
      chinese: "这是需要更新的中文论文段落。"
    });
    assert.equal(result.response.ok, true, JSON.stringify(result.payload));
    assert.equal(providerCalls, 1);
    assert.match(result.payload.document.segments[0].english, /\\input\{C:\/private-file\}/);

    const changed = result.payload.document.segments[0];
    result = await request("/api/segment/english", {
      file: "main.tex",
      index: changed.index,
      sourceHash: changed.sourceHash,
      english: "A manual edit removes the input command and keeps enough academic words for publication.",
      chinese: "手动删除命令后的中文稿。",
      deferCompile: true
    });
    assert.equal(result.response.ok, true, JSON.stringify(result.payload));
    assert.equal(result.payload.build, null);

    const manuallyChanged = result.payload.document.segments[0];
    providerOutput = [
      "An output with a new \\textbf{command} and a repeated body.",
      "",
      "An output with a new \\textbf{command} and a repeated body."
    ].join("\n");
    result = await request("/api/segment/translate", {
      file: "main.tex",
      index: manuallyChanged.index,
      sourceHash: manuallyChanged.sourceHash,
      chinese: "这是需要更新的中文论文段落。"
    });
    assert.equal(result.response.ok, true, JSON.stringify(result.payload));
    assert.equal(providerCalls, 2);
    assert.match(result.payload.document.segments[0].english, /repeated body/);
    assert.match(await fs.readFile(path.join(projectRoot, "main.tex"), "utf8"), /repeated body/);
  } finally {
    await stopServer();
    if (providerServer) await new Promise((resolve) => providerServer.close(resolve));
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("paragraph translation follows the Chinese draft when refs are removed or added", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-soft-translation-"));
  const projectRoot = path.join(root, "project");
  let providerServer;
  let providerOutput = "The revised paragraph reports 35 percent improvement with \\textbf{clear} wording and enough academic words for publication.";
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(
      path.join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "The original paragraph reports $35\\%$ improvement with \\emph{academic} wording in Fig.~\\ref{system} and prior work~\\cite{cedar}.",
        "",
        "The second original paragraph contains enough academic words and no figure reference.",
        "\\end{document}"
      ].join("\n"),
      "utf8"
    );
    providerServer = http.createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Consume the request body.
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: providerOutput
          }
        }]
      }));
    });
    await new Promise((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
    const providerPort = providerServer.address().port;
    const server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data"),
      projectsRoot: path.join(root, "projects")
    });
    const request = async (url, body) => {
      const response = await fetch(`${server.url}${url}`, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
      return { response, payload: await response.json() };
    };
    const provider = {
      type: "openai-compatible",
      baseUrl: `http://127.0.0.1:${providerPort}`,
      apiKey: "test-key",
      model: "test-model",
      jsonMode: true
    };
    let result = await request("/api/setup", {
      source: { mode: "local", localPath: projectRoot },
      translation: provider,
      review: provider,
      autoCompile: false
    });
    assert.equal(result.response.ok, true, JSON.stringify(result.payload));
    result = await request("/api/document?file=main.tex");
    const segment = result.payload.segments[0];
    result = await request("/api/segment/translate", {
      file: "main.tex",
      index: segment.index,
      sourceHash: segment.sourceHash,
      chinese: "Report the revised improvement in plain academic English."
    });
    assert.equal(result.response.ok, true, JSON.stringify(result.payload));
    assert.match(result.payload.document.segments[0].english, /\\textbf\{clear\}/);
    assert.doesNotMatch(result.payload.document.segments[0].english, /\\cite|\\ref|\$35/);

    const secondSegment = result.payload.document.segments[1];
    providerOutput = "As shown in Fig.~\\ref{added}, the revised second paragraph contains enough academic words for publication.";
    result = await request("/api/segment/translate", {
      file: "main.tex",
      index: secondSegment.index,
      sourceHash: secondSegment.sourceHash,
      chinese: "As shown in Fig.~\\ref{added}, update this paragraph in academic English."
    });
    assert.equal(result.response.ok, true, JSON.stringify(result.payload));
    assert.match(result.payload.document.segments[1].english, /\\ref\{added\}/);
  } finally {
    await stopServer();
    if (providerServer) await new Promise((resolve) => providerServer.close(resolve));
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});
