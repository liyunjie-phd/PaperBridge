import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer, stopServer } from "../server.js";

test("project undo restores paragraph and file changes, keeps ten steps, and clears on save confirmation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-undo-"));
  const projectRoot = path.join(root, "project");
  try {
    await fs.mkdir(projectRoot);
    const original = [
      "\\documentclass{article}",
      "\\begin{document}",
      "The first academic paragraph contains enough English prose for editing.",
      "",
      "The second academic paragraph contains enough English prose for editing.",
      "\\end{document}"
    ].join("\n");
    await fs.writeFile(path.join(projectRoot, "main.tex"), original, "utf8");

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
      format: provider,
      autoCompile: false
    });
    assert.equal((await request("/api/undo/status")).count, 0);

    let document = await request("/api/document?file=main.tex");
    const insertedText = "The inserted English paragraph is written directly without an AI request.";
    document = (await post("/api/segment/add", {
      file: "main.tex",
      index: 0,
      sourceHash: document.segments[0].sourceHash,
      chinese: insertedText,
      position: "after"
    })).document;
    assert.equal(document.segments.length, 3);
    assert.equal((await request("/api/undo/status")).count, 1);

    await post("/api/source/create", { file: "sections/new-section.tex" });
    assert.equal(await fs.readFile(path.join(projectRoot, "sections", "new-section.tex"), "utf8"), "");
    assert.equal((await request("/api/undo/status")).count, 2);

    const inserted = document.segments.find((segment) => segment.english === insertedText);
    document = (await post("/api/segment/delete", {
      file: "main.tex",
      index: inserted.index,
      sourceHash: inserted.sourceHash
    })).document;
    assert.equal(document.segments.length, 2);
    assert.equal((await request("/api/undo/status")).count, 3);

    let undone = await post("/api/undo");
    assert.equal(undone.label, "删除段落");
    assert.equal((await request("/api/document?file=main.tex")).segments.length, 3);
    assert.equal(undone.history.count, 2);

    undone = await post("/api/undo");
    assert.match(undone.label, /新建文件/);
    await assert.rejects(fs.access(path.join(projectRoot, "sections", "new-section.tex")));
    assert.equal(undone.history.count, 1);

    undone = await post("/api/undo");
    assert.equal(undone.label, "插入段落");
    assert.equal(await fs.readFile(path.join(projectRoot, "main.tex"), "utf8"), original);
    assert.equal(undone.history.count, 0);

    let source = await request("/api/source?file=main.tex");
    for (let index = 0; index < 12; index += 1) {
      const result = await post("/api/source", {
        file: "main.tex",
        content: `${original}\n% revision ${index}\n`,
        sourceHash: source.sourceHash,
        deferCompile: true
      });
      source = result.source;
    }
    const capped = await request("/api/undo/status");
    assert.equal(capped.count, 10);
    assert.equal(capped.limit, 10);

    await post("/api/undo");
    assert.match(await fs.readFile(path.join(projectRoot, "main.tex"), "utf8"), /% revision 10/);
    const committed = await post("/api/undo/commit");
    assert.equal(committed.count, 0);
    assert.equal(committed.canUndo, false);
  } finally {
    await stopServer();
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("desktop UI exposes project undo and saves before exiting", async () => {
  const [html, appJs, preload, electronMain] = await Promise.all([
    fs.readFile(path.join(process.cwd(), "public", "index.html"), "utf8"),
    fs.readFile(path.join(process.cwd(), "public", "app.js"), "utf8"),
    fs.readFile(path.join(process.cwd(), "preload.cjs"), "utf8"),
    fs.readFile(path.join(process.cwd(), "electron-main.js"), "utf8")
  ]);

  assert.match(html, /id="undoButton"/);
  assert.match(appJs, /elements\.undoButton\.addEventListener\("click"/);
  assert.match(appJs, /event\.key\.toLowerCase\(\) !== "z"/);
  assert.match(appJs, /textarea, input, select, \[contenteditable='true'\]/);
  assert.match(appJs, /window\.paperBridgeDesktop\?\.onCloseRequest\?\.\(handleDesktopCloseRequest\)/);
  assert.match(appJs, /api\("\/api\/undo\/commit"/);
  assert.match(preload, /paperbridge:close-request/);
  assert.match(preload, /paperbridge:close-response/);
  assert.match(electronMain, /是否保存刚才所做的全部更改/);
  assert.match(electronMain, /保存并退出/);
  assert.match(electronMain, /继续编辑/);
});
