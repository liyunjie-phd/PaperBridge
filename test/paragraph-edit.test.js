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
      autoCompile: false
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

    const commented = await post("/api/segment/comment", {
      file: "main.tex",
      index: 1,
      sourceHash: document.segments[1].sourceHash,
      chinese: "这是刚刚修改且尚未自动保存的中文工作稿。"
    });
    document = commented.document;
    assert.equal(document.segments.length, 2);
    let sourceText = await fs.readFile(path.join(projectRoot, "main.tex"), "utf8");
    assert.match(sourceText, /% The generated English paragraph/);

    const source = await request("/api/source?file=main.tex");
    sourceText = source.content.replace("% The generated English paragraph", "The generated English paragraph");
    await post("/api/source", {
      file: "main.tex",
      content: sourceText,
      sourceHash: source.sourceHash
    });
    document = await request("/api/document?file=main.tex");
    assert.equal(document.segments.length, 3);
    assert.equal(document.segments[1].chinese, "这是刚刚修改且尚未自动保存的中文工作稿。");

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

test("paragraph API comments only the selected English text", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-partial-comment-"));
  const projectRoot = path.join(root, "project");
  try {
    await fs.mkdir(projectRoot);
    const paragraph = [
      "Alpha introduction contains enough academic words before the selected text.",
      "This removable sentence should be commented.",
      "The remaining manuscript prose stays editable after the selection."
    ].join(" ");
    await fs.writeFile(
      path.join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        paragraph,
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
      baseUrl: "http://127.0.0.1:9",
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
    let document = await request("/api/document?file=main.tex");
    const segment = document.segments[0];
    const selected = "This removable sentence should be commented.";
    const selectionStart = segment.english.indexOf(selected);
    assert.notEqual(selectionStart, -1);
    const result = await post("/api/segment/comment", {
      file: "main.tex",
      index: segment.index,
      sourceHash: segment.sourceHash,
      chinese: "partial Chinese draft",
      selectionStart,
      selectionEnd: selectionStart + selected.length
    });
    document = result.document;
    assert.equal(document.segments.length, 2);
    assert.equal(document.segments[0].chinese, "partial Chinese draft");
    assert.match(document.segments[0].english, /Alpha introduction/);
    assert.match(document.segments[1].english, /remaining manuscript prose/);
    assert.doesNotMatch(document.segments.map((item) => item.english).join("\n"), /removable sentence/);
    const sourceText = await fs.readFile(path.join(projectRoot, "main.tex"), "utf8");
    assert.match(sourceText, /% This removable sentence should be commented\./);
    assert.doesNotMatch(sourceText, /% Alpha introduction/);
  } finally {
    await stopServer();
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("stale Chinese autosave is ignored after the English paragraph changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-stale-chinese-"));
  const projectRoot = path.join(root, "project");
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(
      path.join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "The original English paragraph contains enough academic words for stale autosave testing.",
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
      baseUrl: "http://127.0.0.1:9",
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
    let document = await request("/api/document?file=main.tex");
    const original = document.segments[0];
    await post("/api/segment/english", {
      file: "main.tex",
      index: original.index,
      sourceHash: original.sourceHash,
      english: "The updated English paragraph contains enough academic words after the edit is saved.",
      chinese: "正确的中文工作稿。"
    });
    const stale = await post("/api/segment/chinese", {
      file: "main.tex",
      index: original.index,
      sourceHash: original.sourceHash,
      chinese: "过期的中文自动保存。"
    });
    assert.deepEqual(stale, { saved: false, stale: true });
    document = await request("/api/document?file=main.tex");
    assert.equal(document.segments[0].chinese, "正确的中文工作稿。");
  } finally {
    await stopServer();
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});
