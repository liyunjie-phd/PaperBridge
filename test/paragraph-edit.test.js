import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer, stopServer } from "../server.js";

test("paragraph API inserts, remaps Chinese drafts, and deletes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-paragraph-api-"));
  const projectRoot = path.join(root, "project");
  let providerServer;
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(
      path.join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "The first English paragraph contains enough academic words for bilingual editing.",
        "",
        "The second English paragraph contains enough academic words for bilingual editing.",
        "\\end{document}"
      ].join("\n"),
      "utf8"
    );

    providerServer = http.createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Consume the request before responding so repeated calls can reuse the connection.
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: "The generated English paragraph preserves terminology and contains enough academic prose." } }]
      }));
    });
    await new Promise((resolve, reject) => {
      providerServer.once("error", reject);
      providerServer.listen(0, "127.0.0.1", resolve);
    });
    const providerPort = providerServer.address().port;

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
      baseUrl: `http://127.0.0.1:${providerPort}`,
      apiKey: "test-key",
      model: "test-model",
      jsonMode: true
    };

    await post("/api/setup", {
      source: { mode: "local", localPath: projectRoot },
      translation: provider,
      review: provider,
      autoCompile: false,
      pageLimit: 12
    });
    let document = await request("/api/document?file=main.tex");
    await Promise.all([
      post("/api/segment/chinese", { file: "main.tex", index: 0, chinese: "第一段中文工作稿。" }),
      post("/api/segment/chinese", { file: "main.tex", index: 1, chinese: "第二段中文工作稿。" })
    ]);
    document = await request("/api/document?file=main.tex");
    assert.deepEqual(document.segments.map((segment) => segment.chinese), ["第一段中文工作稿。", "第二段中文工作稿。"]);
    const stateFiles = await fs.readdir(path.join(root, "data", "data"));
    assert.ok(stateFiles.some((file) => file.endsWith(".json.bak")));

    const added = await post("/api/segment/add", {
      file: "main.tex",
      index: 0,
      sourceHash: document.segments[0].sourceHash,
      chinese: "这是新增的中文正文段落。",
      position: "after"
    });
    document = added.document;
    assert.equal(document.segments.length, 3);
    assert.deepEqual(document.segments.map((segment) => segment.chinese), [
      "第一段中文工作稿。",
      "这是新增的中文正文段落。",
      "第二段中文工作稿。"
    ]);
    assert.match(document.segments[1].english, /generated English paragraph/);

    const removed = await post("/api/segment/delete", {
      file: "main.tex",
      index: 1,
      sourceHash: document.segments[1].sourceHash
    });
    document = removed.document;
    assert.equal(document.segments.length, 2);
    assert.deepEqual(document.segments.map((segment) => segment.chinese), [
      "第一段中文工作稿。",
      "第二段中文工作稿。"
    ]);
    assert.doesNotMatch(await fs.readFile(path.join(projectRoot, "main.tex"), "utf8"), /generated English paragraph/);
  } finally {
    await stopServer();
    if (providerServer) await new Promise((resolve) => providerServer.close(resolve));
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});
