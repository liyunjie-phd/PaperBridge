import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeFormat, applyFormat, configureFormatRuntime, verifyContentIntegrity } from "../lib/format.js";

const before = [{
  file: "main.tex",
  content: String.raw`\documentclass{article}
\begin{document}
The method preserves the original scholarly content and result values \cite{Smith2024}.
\begin{figure}\includegraphics{figures/result.pdf}\caption{Result}\label{fig:result}\end{figure}
See Figure~\ref{fig:result}.
\end{document}`
}];

test("format integrity allows document class changes with preserved content", () => {
  const after = [{
    file: "main.tex",
    content: before[0].content.replace("\\documentclass{article}", "\\documentclass[sigconf]{acmart}")
  }];
  const result = verifyContentIntegrity(before, after);
  assert.equal(result.wordDelta, 0);
});

test("format integrity blocks lost figure paths", () => {
  const after = [{
    file: "main.tex",
    content: before[0].content.replace("\\includegraphics{figures/result.pdf}", "")
  }];
  assert.throws(() => verifyContentIntegrity(before, after), /figure paths/);
});

test("format migration requests approval before adding unexpected LaTeX commands", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-format-commands-"));
  const projectRoot = path.join(root, "project");
  try {
    await fs.mkdir(projectRoot);
    const source = [
      "\\documentclass{article}",
      "\\begin{document}",
      "The method preserves the original scholarly content and result values for publication.",
      "\\end{document}"
    ].join("\n");
    await fs.writeFile(path.join(projectRoot, "main.tex"), source, "utf8");
    configureFormatRuntime({
      dataRoot: path.join(root, "data"),
      callProvider: async (_provider, request) => request.json
        ? JSON.stringify({
            targetName: "Test format",
            summary: "Add emphasis",
            differences: [{ id: "F1", category: "style", current: "plain", target: "bold", action: "emphasize", risk: "low" }],
            affectedFiles: ["main.tex"],
            warnings: []
          })
        : `<latex>${source.replace("The method", "The \\textbf{method}")}</latex>`
    });
    const job = await analyzeFormat({ provider: {}, projectRoot, mainTex: "main.tex", requirements: "Add emphasis", filePaths: [] });
    await assert.rejects(
      applyFormat({ provider: {}, projectRoot, mainTex: "main.tex", jobId: job.id }),
      (error) => error.code === "UNEXPECTED_LATEX_COMMANDS"
        && error.details.unexpectedCommands.some((command) => command.includes("textbf"))
        && Boolean(error.details.approvalToken)
    );
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});
