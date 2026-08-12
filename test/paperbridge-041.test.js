import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer, stopServer } from "../server.js";

async function withProject(name, content, callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), name));
  const projectRoot = path.join(root, "paper");
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(projectRoot, "main.tex"), content, "utf8");
    const server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data"),
      projectsRoot: path.join(root, "projects")
    });
    const request = async (url, body = null, method = body ? "POST" : "GET") => {
      const response = await fetch(`${server.url}${url}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
      const payload = await response.json();
      if (!response.ok) {
        const error = new Error(payload.error || response.statusText);
        error.payload = payload;
        throw error;
      }
      return payload;
    };
    await request("/api/project/open", { projectRoot, mainTex: "main.tex" });
    await callback({ root, projectRoot, request });
  } finally {
    await stopServer();
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
}

const tablePaper = [
  "\\documentclass{article}",
  "\\begin{document}",
  "This introduction paragraph has enough words to be detected by PaperBridge.",
  "",
  "\\begin{table}",
  "\\caption{Result table}",
  "\\begin{tabular}{ll}",
  "\\toprule",
  "Metric & Value \\\\",
  "Delay & 10 ms \\\\",
  "\\bottomrule",
  "\\end{tabular}",
  "\\end{table}",
  "",
  "This closing paragraph also has enough words for the editor.",
  "\\end{document}"
].join("\n");

test("table blocks are exposed as editable bilingual grids and save English cells back to TeX", async () => {
  await withProject("paperbridge-041-table-", tablePaper, async ({ projectRoot, request }) => {
    let document = await request("/api/document?file=main.tex");
    assert.equal(document.tableBlocks.length, 1);
    const table = document.tableBlocks[0];
    assert.deepEqual(table.rows.map((row) => row.cells.map((cell) => cell.text)), [
      ["Metric", "Value"],
      ["Delay", "10 ms"]
    ]);
    assert.deepEqual(table.chineseRows, [
      ["Metric", "Value"],
      ["Delay", "10 ms"]
    ]);

    const result = await request("/api/table-block", {
      file: "main.tex",
      id: table.id,
      sourceHash: table.sourceHash,
      startLine: table.startLine,
      chineseRows: [["指标", "值"], ["时延", "1 秒"]],
      englishRows: [["Metric", "Value"], ["Latency", "1 s"]],
      deferCompile: true
    });
    document = result.document;
    assert.deepEqual(document.tableBlocks[0].chineseRows, [["指标", "值"], ["时延", "1 秒"]]);
    const content = await fs.readFile(path.join(projectRoot, "main.tex"), "utf8");
    assert.match(content, /Latency & 1 s \\\\/);
  });
});

test("creating a TeX source file lists and opens the new file even before it is included", async () => {
  await withProject("paperbridge-041-create-", tablePaper, async ({ projectRoot, request }) => {
    const result = await request("/api/source/create", { file: "sections/new-section" });
    assert.equal(result.source.file, "sections/new-section.tex");
    assert.ok(result.project.sourceFiles.includes("sections/new-section.tex"));
    assert.equal(await fs.readFile(path.join(projectRoot, "sections", "new-section.tex"), "utf8"), "");
    const source = await request("/api/source?file=sections%2Fnew-section.tex");
    assert.equal(source.file, "sections/new-section.tex");
  });
});

test("saving TeX source is lightweight by default but can explicitly refresh the bilingual document", async () => {
  await withProject("paperbridge-041-source-sync-", tablePaper, async ({ request }) => {
    const source = await request("/api/source?file=main.tex");
    const nextContent = source.content.replace(
      "This introduction paragraph has enough words to be detected by PaperBridge.",
      "This revised introduction paragraph is saved without rebuilding the bilingual editor."
    );
    const result = await request("/api/source", {
      file: "main.tex",
      content: nextContent,
      sourceHash: source.sourceHash,
      deferCompile: true
    });
    assert.equal(result.document, null);
    assert.equal(result.build, null);

    const refreshedContent = nextContent.replace(
      "saved without rebuilding the bilingual editor",
      "returned when an explicit refresh is requested"
    );
    const refreshed = await request("/api/source", {
      file: "main.tex",
      content: refreshedContent,
      sourceHash: result.source.sourceHash,
      deferCompile: true,
      refreshDocument: true
    });
    assert.ok(refreshed.document);
    assert.match(refreshed.document.segments[0].english, /explicit refresh is requested/);
  });
});

const mathPaper = [
  "\\documentclass{article}",
  "\\begin{document}",
  "The first paragraph contains enough words to remain editable.",
  "\\[",
  "x = y + z",
  "\\]",
  "The second paragraph also contains enough words to remain editable.",
  "\\end{document}"
].join("\n");

test("formula blocks can be moved between editable paragraphs", async () => {
  await withProject("paperbridge-041-math-move-", mathPaper, async ({ projectRoot, request }) => {
    const document = await request("/api/document?file=main.tex");
    const block = document.mathBlocks[0];
    const target = document.segments[1];
    await request("/api/math-block/move", {
      file: "main.tex",
      id: block.id,
      sourceHash: block.sourceHash,
      startLine: block.startLine,
      target: {
        type: "segment",
        index: target.index,
        sourceHash: target.sourceHash,
        position: "after"
      },
      deferCompile: true
    });
    const content = await fs.readFile(path.join(projectRoot, "main.tex"), "utf8");
    assert.ok(content.indexOf("The second paragraph") < content.indexOf("x = y + z"));
  });
});
