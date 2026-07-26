import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer, stopServer } from "../server.js";

async function jsonRequest(baseUrl, url, body = null) {
  const response = await fetch(`${baseUrl}${url}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json();
  assert.equal(response.ok, true, payload.error);
  return payload;
}

async function withFigureProject(callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-figure-"));
  const projectRoot = path.join(root, "project");
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(projectRoot, "main.tex"), [
      "\\documentclass{article}",
      "\\usepackage{graphicx}",
      "\\begin{document}",
      "The first paragraph contains enough words for figure insertion anchoring.",
      "",
      "The second paragraph contains enough words to remain after the inserted figure.",
      "\\end{document}"
    ].join("\n"), "utf8");
    const server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data"),
      projectsRoot: path.join(root, "projects")
    });
    await jsonRequest(server.url, "/api/project/open", { projectRoot, mainTex: "main.tex" });
    await callback({ root, projectRoot, server });
  } finally {
    await stopServer();
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("figure insertion copies local images and creates a side-by-side top float near a paragraph", async () => {
  await withFigureProject(async ({ root, projectRoot, server }) => {
    const imageA = path.join(root, "panel-a.png");
    const imageB = path.join(root, "panel-b.jpg");
    await fs.writeFile(imageA, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await fs.writeFile(imageB, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const document = await jsonRequest(server.url, "/api/document?file=main.tex");
    const result = await jsonRequest(server.url, "/api/figure/insert", {
      file: "main.tex",
      anchor: {
        type: "segment",
        index: document.segments[0].index,
        sourceHash: document.segments[0].sourceHash,
        position: "after"
      },
      images: [imageA, imageB],
      description: "插入第二页左列最上方，两张图片并排放",
      caption: "Two diagnostic panels.",
      label: "fig:two-panels",
      deferCompile: true
    });

    assert.equal(result.assets.length, 2);
    assert.ok(result.assets.every((asset) => asset.copied));
    assert.equal(result.layout.environment, "figure");
    assert.equal(result.layout.option, "!t");
    assert.match(result.latex, /\\begin\{figure\}\[!t\]/);
    assert.match(result.latex, /\\begin\{minipage\}\{0\.48\\columnwidth\}/);
    assert.match(result.latex, /\\caption\{Two diagnostic panels\.\}/);
    assert.match(result.latex, /\\label\{fig:two-panels\}/);
    for (const asset of result.assets) {
      await fs.access(path.join(projectRoot, asset.relativePath));
    }
    const content = await fs.readFile(path.join(projectRoot, "main.tex"), "utf8");
    assert.ok(content.indexOf("The first paragraph") < content.indexOf("\\begin{figure}"));
    assert.ok(content.indexOf("\\end{figure}") < content.indexOf("The second paragraph"));
    assert.equal(result.document.segments.length, 2);
  });
});

test("figure insertion at the TeX cursor can reuse a project image and create a spanning float", async () => {
  await withFigureProject(async ({ projectRoot, server }) => {
    await fs.mkdir(path.join(projectRoot, "fig"));
    await fs.writeFile(path.join(projectRoot, "fig", "existing.pdf"), "%PDF-1.4\n", "utf8");
    const source = await jsonRequest(server.url, "/api/source?file=main.tex");
    const cursorOffset = source.content.indexOf("\\end{document}");
    const result = await jsonRequest(server.url, "/api/figure/insert", {
      file: "main.tex",
      anchor: {
        type: "source",
        sourceHash: source.sourceHash,
        cursorOffset
      },
      images: "fig/existing.pdf",
      description: "插入第三页整体的最上方，跨栏",
      caption: "A spanning overview.",
      label: "overview",
      deferCompile: true
    });

    assert.equal(result.assets.length, 1);
    assert.equal(result.assets[0].copied, false);
    assert.equal(result.assets[0].relativePath, "fig/existing.pdf");
    assert.equal(result.layout.environment, "figure*");
    assert.match(result.source.content, /\\begin\{figure\*\}\[!t\]/);
    assert.match(result.source.content, /\\includegraphics\[width=0\.95\\textwidth\]\{fig\/existing\.pdf\}/);
    assert.match(result.source.content, /\\label\{fig:overview\}/);
  });
});
