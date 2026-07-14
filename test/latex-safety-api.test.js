import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer, stopServer } from "../server.js";

test("AI paragraph output blocks dangerous commands and requires approval for unexpected commands", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-latex-safety-"));
  const projectRoot = path.join(root, "project");
  let providerServer;
  let providerOutput = "A safe replacement paragraph contains enough academic words for publication.";
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(
      path.join(projectRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}\nThe original English paragraph contains enough academic words for editing.\n\\end{document}\n",
      "utf8"
    );
    providerServer = http.createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Consume the request body.
      }
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
    assert.equal(result.response.ok, true, result.payload.error);
    result = await request("/api/document?file=main.tex");
    const segment = result.payload.segments[0];

    providerOutput = "Dangerous output \\input{C:/private-file} contains enough academic words.";
    result = await request("/api/segment/translate", {
      file: "main.tex",
      index: segment.index,
      sourceHash: segment.sourceHash,
      chinese: "这是需要更新的中文论文段落。"
    });
    assert.equal(result.response.status, 422);
    assert.equal(result.payload.code, "DANGEROUS_LATEX_COMMANDS");

    providerOutput = "An approved \\textbf{replacement} paragraph contains enough academic words for publication.";
    result = await request("/api/segment/translate", {
      file: "main.tex",
      index: segment.index,
      sourceHash: segment.sourceHash,
      chinese: "这是需要更新的中文论文段落。"
    });
    assert.equal(result.response.status, 409);
    assert.equal(result.payload.code, "UNEXPECTED_LATEX_COMMANDS");
    const approvalToken = result.payload.details.approvalToken;

    result = await request("/api/segment/translate", {
      file: "main.tex",
      index: segment.index,
      sourceHash: segment.sourceHash,
      chinese: "这是需要更新的中文论文段落。",
      approvalToken
    });
    assert.equal(result.response.ok, true, result.payload.error);
    assert.match(result.payload.document.segments[0].english, /textbf/);
  } finally {
    await stopServer();
    if (providerServer) await new Promise((resolve) => providerServer.close(resolve));
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});
