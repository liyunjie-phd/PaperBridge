import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer, stopServer } from "../server.js";

test("section translation reports progress without sending other sections", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-translation-progress-"));
  const projectRoot = path.join(root, "project");
  const batchSizes = [];
  let providerServer;
  try {
    await fs.mkdir(projectRoot);
    const introduction = Array.from({ length: 9 }, (_, index) => (
      `Paragraph ${index + 1} contains enough academic words to be detected as editable manuscript prose for translation testing.${index === 0 ? " \\cite{demo}" : ""}`
    ));
    const method = Array.from({ length: 3 }, (_, index) => (
      `Method paragraph ${index + 1} contains enough academic words and must remain outside the introduction translation request.`
    ));
    await fs.writeFile(
      path.join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{Introduction}",
        ...introduction.flatMap((paragraph) => [paragraph, ""]),
        "\\section{Method}",
        ...method.flatMap((paragraph) => [paragraph, ""]),
        "\\end{document}"
      ].join("\n"),
      "utf8"
    );

    providerServer = http.createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      const user = payload.messages.find((message) => message.role === "user").content;
      const input = JSON.parse(user.slice(user.lastIndexOf("\n") + 1));
      batchSizes.push(input.length);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              translations: input.map((item, index) => ({ id: item.id, chinese: `这是第 ${index + 1} 个测试翻译段落。` }))
            })
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
      const payload = await response.json();
      assert.equal(response.ok, true, payload.error);
      return payload;
    };
    const provider = {
      type: "openai-compatible",
      baseUrl: `http://127.0.0.1:${providerPort}`,
      apiKey: "test-key",
      model: "test-model",
      jsonMode: true
    };

    const project = await request("/api/setup", {
      source: { mode: "local", localPath: projectRoot },
      translation: provider,
      review: provider,
      autoCompile: false,
      pageLimit: 12
    });
    assert.equal("pageLimit" in project.config, false);

    let document = await request("/api/document?file=main.tex");
    assert.equal(document.segments.length, 12);
    const introductionSegments = document.segments.filter((segment) => segment.sectionTitle === "Introduction");
    const methodSegments = document.segments.filter((segment) => segment.sectionTitle === "Method");
    let result = await request("/api/file/translate-to-chinese", {
      file: "main.tex",
      sectionId: introductionSegments[0].sectionId,
      segmentIds: [introductionSegments[0].id]
    });
    assert.deepEqual(result.progress, { attempted: 1, translated: 1, skipped: 0 });
    assert.doesNotMatch(result.document.segments[0].chinese, /\\cite/);
    assert.equal(result.document.segments.filter((segment) => segment.chinese).length, 1);
    assert.equal(result.document.segments.filter((segment) => segment.sectionTitle === "Method" && segment.chinese).length, 0);

    document = result.document;
    result = await request("/api/file/translate-to-chinese", {
      file: "main.tex",
      sectionId: introductionSegments[0].sectionId,
      segmentIds: introductionSegments.slice(1).map((segment) => segment.id)
    });
    assert.deepEqual(result.progress, { attempted: 8, translated: 8, skipped: 0 });
    assert.equal(result.document.segments.filter((segment) => segment.chinese).length, 9);
    assert.equal(result.document.segments.filter((segment) => segment.sectionTitle === "Method" && segment.chinese).length, 0);

    result = await request("/api/file/translate-to-chinese", {
      file: "main.tex",
      sectionId: methodSegments[0].sectionId,
      segmentIds: methodSegments.map((segment) => segment.id)
    });
    assert.deepEqual(result.progress, { attempted: 3, translated: 3, skipped: 0 });
    assert.equal(result.document.segments.filter((segment) => segment.chinese).length, 12);
    assert.deepEqual(batchSizes, [1, 8, 3]);
  } finally {
    await stopServer();
    if (providerServer) await new Promise((resolve) => providerServer.close(resolve));
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});
