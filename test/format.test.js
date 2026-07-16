import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analyzeFormat,
  applyFormat,
  applyFormatOperations,
  configureFormatRuntime,
  formatRelevantExcerpt,
  latestFormatJob,
  verifyContentIntegrity
} from "../lib/format.js";
import { compileProject, getDependencyStatus } from "../lib/project.js";

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

test("format integrity ignores venue metadata but still protects abstract prose", () => {
  const article = [{
    file: "main.tex",
    content: String.raw`\documentclass{article}
\begin{document}
\title{Stable Title}
\author{One Author}
\maketitle
\begin{abstract}
The abstract contains stable scholarly findings that must remain intact across every format migration.
\end{abstract}
\section{Introduction}
The body contains stable scholarly content for the migration test.
\end{document}`
  }];
  const elsevier = [{
    file: "main.tex",
    content: String.raw`\documentclass[3p,twocolumn]{elsarticle}
\begin{document}
\begin{frontmatter}
\title{Stable Title}
\author[inst1]{One Author}
\affiliation[inst1]{organization={A Much Longer University Name},city={Example City},country={Exampleland}}
\begin{abstract}
The abstract contains stable scholarly findings that must remain intact across every format migration.
\end{abstract}
\begin{keyword}format migration \sep reproducibility\end{keyword}
\end{frontmatter}
\section{Introduction}
The body contains stable scholarly content for the migration test.
\end{document}`
  }];
  assert.equal(verifyContentIntegrity(article, elsevier).wordDelta, 0);
  assert.throws(() => verifyContentIntegrity(article, [{
    ...elsevier[0],
    content: elsevier[0].content.replace(
      "The abstract contains stable scholarly findings that must remain intact across every format migration.",
      ""
    )
  }]), (error) => error.code === "FORMAT_INTEGRITY_FAILED");
});

test("format integrity blocks lost figure paths", () => {
  const after = [{
    file: "main.tex",
    content: before[0].content.replace("\\includegraphics{figures/result.pdf}", "")
  }];
  assert.throws(() => verifyContentIntegrity(before, after), /figure paths/);
});

test("clean format builds discard stale auxiliary commands", async (t) => {
  const dependencies = await getDependencyStatus();
  if (dependencies.compiler === "missing") {
    t.skip("No LaTeX compiler is available.");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-clean-build-"));
  try {
    await fs.writeFile(path.join(root, "main.tex"), [
      "\\documentclass{article}",
      "\\begin{document}",
      "Clean build content with a citation \\cite{example}.",
      "\\bibliographystyle{plain}",
      "\\bibliography{refs}",
      "\\end{document}"
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(root, "refs.bib"), "@misc{example,title={Clean Build Reference},year={2026}}\n", "utf8");
    await fs.writeFile(path.join(root, "main.aux"), "\\undefinedstalecommand\n", "utf8");
    await fs.writeFile(path.join(root, "main.bbl"), "\\undefinedstalecommand\n", "utf8");
    const result = await compileProject(root, "main.tex", { clean: true });
    assert.equal(result.success, true);
    assert.equal(result.pdf.exists, true);
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("format excerpts keep structural commands without sending distant prose", () => {
  const content = [
    "\\documentclass{article}",
    ...Array.from({ length: 3000 }, (_value, index) => index === 1500 ? "DISTANT_PRIVATE_PROSE" : `ordinary prose ${index}`),
    "\\bibliographystyle{plain}"
  ].join("\n");
  const excerpt = formatRelevantExcerpt(content, 3000);
  assert.match(excerpt, /documentclass/);
  assert.match(excerpt, /bibliographystyle/);
  assert.doesNotMatch(excerpt, /DISTANT_PRIVATE_PROSE/);
});

test("format edit operations require exact unambiguous anchors", () => {
  const content = "\\documentclass{article}\n\\begin{document}\nBody\n\\end{document}\n";
  const changed = applyFormatOperations(content, {
    operations: [{ type: "replace", oldText: "\\documentclass{article}", newText: "\\documentclass{report}" }]
  });
  assert.match(changed, /documentclass\{report\}/);
  assert.throws(() => applyFormatOperations("same\nsame\n", {
    operations: [{ type: "replace", oldText: "same", newText: "next" }]
  }), /出现 2 次/);
});

test("format analysis retries malformed weak-model output with validation feedback", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-format-retry-"));
  const projectRoot = path.join(root, "project");
  let calls = 0;
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(projectRoot, "main.tex"), "\\documentclass{article}\n\\begin{document}\nBody text.\n\\end{document}\n", "utf8");
    configureFormatRuntime({
      dataRoot: path.join(root, "data"),
      callProvider: async () => {
        calls += 1;
        if (calls === 1) return "I found several formatting changes.";
        return JSON.stringify({
          targetName: "Reliable target",
          summary: "Change the document class.",
          differences: [{ id: "F1", category: "document class", current: "article", target: "report", action: "replace documentclass", risk: "high" }],
          affectedFiles: ["main.tex"],
          warnings: []
        });
      }
    });
    const job = await analyzeFormat({ provider: {}, projectRoot, mainTex: "main.tex", requirements: "Use report class", filePaths: [] });
    assert.equal(job.analysis.modelAttempts, 2);
    assert.equal(calls, 2);
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("format migration requests approval before adding unexpected LaTeX commands", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-format-commands-"));
  const projectRoot = path.join(root, "project");
  let operationCalls = 0;
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
      callProvider: async (_provider, request) => {
        if (request.system.includes("format analyst")) return JSON.stringify({
            targetName: "Test format",
            summary: "Add emphasis",
            differences: [{ id: "F1", category: "style", current: "plain", target: "bold", action: "emphasize", risk: "low" }],
            affectedFiles: ["main.tex"],
            warnings: []
          });
        operationCalls += 1;
        if (operationCalls === 1) return `<latex>${source.replace("The method", "The \\textbf{method}")}</latex>`;
        return JSON.stringify({
          file: "main.tex",
          operations: [{
            id: "E1",
            type: "replace",
            oldText: "The method",
            newText: "The \\textbf{method}",
            reason: "test unexpected command approval"
          }]
        });
      }
    });
    const job = await analyzeFormat({ provider: {}, projectRoot, mainTex: "main.tex", requirements: "Add emphasis", filePaths: [] });
    await assert.rejects(
      applyFormat({ provider: {}, projectRoot, mainTex: "main.tex", jobId: job.id }),
      (error) => error.code === "UNEXPECTED_LATEX_COMMANDS"
        && error.details.unexpectedCommands.some((command) => command.includes("textbf"))
        && Boolean(error.details.approvalToken)
    );
    const latest = await latestFormatJob(projectRoot, "main.tex");
    assert.equal(latest.execution.modelAttempts, 2);
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("format migration repairs a fatal compiler error with a minimal second plan", async (t) => {
  const dependencies = await getDependencyStatus();
  if (dependencies.compiler === "missing") {
    t.skip("No LaTeX compiler is available.");
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-format-compile-repair-"));
  const projectRoot = path.join(root, "project");
  let repairPrompt = "";
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(projectRoot, "main.tex"), [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{Title}",
      "The method preserves the original scholarly content and result values for publication.",
      "\\end{document}"
    ].join("\n"), "utf8");
    configureFormatRuntime({
      dataRoot: path.join(root, "data"),
      callProvider: async (_provider, request) => {
        if (request.system.includes("format analyst")) return JSON.stringify({
          targetName: "Compiler repair test",
          summary: "Use an unnumbered heading.",
          differences: [{ id: "F1", category: "heading", current: "numbered", target: "unnumbered", action: "add a section star", risk: "low" }],
          affectedFiles: ["main.tex"],
          warnings: []
        });
        if (request.system.includes("format migration planner")) return JSON.stringify({
          file: "main.tex",
          operations: [{
            id: "E1",
            type: "replace",
            oldText: "\\section{Title}",
            newText: "\\section*{Title",
            reason: "simulate a weak-model brace omission"
          }]
        });
        if (request.system.includes("repair a LaTeX format migration")) {
          repairPrompt = request.user;
          return JSON.stringify({
            file: "main.tex",
            operations: [{
              id: "R1",
              type: "replace",
              oldText: "\\section*{Title",
              newText: "\\section*{Title}",
              reason: "restore the missing closing brace reported by the compiler"
            }]
          });
        }
        throw new Error("Unexpected model request.");
      }
    });

    const job = await analyzeFormat({
      provider: {},
      projectRoot,
      mainTex: "main.tex",
      requirements: "Use unnumbered section headings",
      filePaths: []
    });
    const result = await applyFormat({ provider: {}, projectRoot, mainTex: "main.tex", jobId: job.id });
    const finalSource = await fs.readFile(path.join(projectRoot, "main.tex"), "utf8");
    assert.equal(result.build.success, true);
    assert.equal(result.job.build.compileRepairAttempts, 1);
    assert.match(finalSource, /\\section\*\{Title\}/);
    assert.match(repairPrompt, /Compiler (?:errors|log tail)/);
    assert.match(repairPrompt, /section\*\{Title/);
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("format planning restores a used package before compilation", async (t) => {
  const dependencies = await getDependencyStatus();
  if (dependencies.compiler === "missing") {
    t.skip("No LaTeX compiler is available.");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-format-package-restore-"));
  const projectRoot = path.join(root, "project");
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(projectRoot, "main.tex"), [
      "\\documentclass{article}",
      "\\usepackage{booktabs}",
      "\\begin{document}",
      "The table preserves the original scholarly result values.",
      "\\begin{tabular}{l}",
      "\\toprule",
      "Result \\\\",
      "\\bottomrule",
      "\\end{tabular}",
      "\\end{document}"
    ].join("\n"), "utf8");
    configureFormatRuntime({
      dataRoot: path.join(root, "data"),
      callProvider: async (_provider, request) => {
        if (request.system.includes("format analyst")) return JSON.stringify({
          targetName: "Weak-model package restoration test",
          summary: "Apply the target format without changing the table.",
          differences: [{ id: "F1", category: "packages", current: "booktabs", target: "target packages", action: "adjust packages", risk: "medium", scope: "global" }],
          affectedFiles: ["main.tex"],
          warnings: []
        });
        if (request.system.includes("format migration planner")) return JSON.stringify({
          file: "main.tex",
          operations: [{ id: "E1", type: "delete", oldText: "\\usepackage{booktabs}\n", newText: "", reason: "simulate a weak model removing a required package" }]
        });
        if (request.system.includes("repair a LaTeX format migration")) return JSON.stringify({
          file: "main.tex",
          operations: [{ id: "R1", type: "insert_before", oldText: "\\begin{document}", newText: "\\usepackage{booktabs}\n", reason: "restore the original package required by top and bottom rules" }]
        });
        throw new Error("Unexpected model request.");
      }
    });
    const job = await analyzeFormat({
      provider: {},
      projectRoot,
      mainTex: "main.tex",
      requirements: "Preserve the booktabs table",
      filePaths: []
    });
    const result = await applyFormat({ provider: {}, projectRoot, mainTex: "main.tex", jobId: job.id });
    assert.equal(result.build.success, true);
    assert.equal(result.job.build.compileRepairAttempts, 0);
    assert.match(await fs.readFile(path.join(projectRoot, "main.tex"), "utf8"), /\\usepackage\{booktabs\}/);
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("format planner retries when target literals or used packages are missing", async (t) => {
  const dependencies = await getDependencyStatus();
  if (dependencies.compiler === "missing") {
    t.skip("No LaTeX compiler is available.");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-format-constraints-"));
  const projectRoot = path.join(root, "project");
  let plannerCalls = 0;
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(projectRoot, "main.tex"), [
      "\\documentclass{article}",
      "\\usepackage{booktabs}\\usepackage{graphicx}",
      "\\begin{document}",
      "The table preserves the original scholarly result values.",
      "\\begin{tabular}{l}",
      "\\toprule",
      "Result \\\\",
      "\\bottomrule",
      "\\end{tabular}",
      "\\end{document}"
    ].join("\n"), "utf8");
    configureFormatRuntime({
      dataRoot: path.join(root, "data"),
      callProvider: async (_provider, request) => {
        if (request.system.includes("format analyst")) return JSON.stringify({
          targetName: "Two-column article",
          summary: "Use the required two-column document class.",
          differences: [{ id: "F1", category: "columns", current: "one column", target: "two columns", action: "change document class options", risk: "medium", scope: "global" }],
          affectedFiles: ["main.tex"],
          warnings: []
        });
        if (!request.system.includes("format migration planner")) throw new Error("Unexpected model request.");
        plannerCalls += 1;
        return JSON.stringify({
          file: "main.tex",
          operations: plannerCalls === 1
            ? [
                { id: "E1", type: "replace", oldText: "\\documentclass{article}", newText: "\\documentclass[onecolumn]{article}", reason: "simulate a weak model missing the required target literal" },
                { id: "E2", type: "delete", oldText: "\\usepackage{booktabs}\\usepackage{graphicx}\n", newText: "", reason: "simulate an over-aggressive weak model" },
                { id: "E3", type: "insert_before", oldText: "\\begin{document}", newText: "% \\documentclass[twocolumn]{article}\n\\input{preamble}\n", reason: "simulate a commented target literal and blindly copied support file" }
              ]
            : [
                { id: "E1", type: "replace", oldText: "\\documentclass{article}", newText: "\\documentclass[twocolumn]{article}", reason: "use two columns" },
                { id: "E2", type: "delete", oldText: "\\usepackage{booktabs}\\usepackage{graphicx}\n", newText: "", reason: "simulate a weak model again removing a package used by the table" }
              ]
        });
      }
    });
    const job = await analyzeFormat({
      provider: {},
      projectRoot,
      mainTex: "main.tex",
      requirements: "Use \\documentclass[twocolumn]{article} and preserve the table.",
      filePaths: []
    });
    const result = await applyFormat({ provider: {}, projectRoot, mainTex: "main.tex", jobId: job.id });
    assert.equal(result.build.success, true);
    assert.equal(plannerCalls, 2);
    const finalSource = await fs.readFile(path.join(projectRoot, "main.tex"), "utf8");
    assert.match(finalSource, /\\documentclass\[twocolumn\]\{article\}/);
    assert.match(finalSource, /\\usepackage\{booktabs\}/);
    assert.doesNotMatch(finalSource, /\\input\{preamble\}/);
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("format migration plans global main first, then local chapters, and preserves Bib entries", async (t) => {
  const dependencies = await getDependencyStatus();
  if (dependencies.compiler === "missing") {
    t.skip("No LaTeX compiler is available.");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-format-staged-"));
  const projectRoot = path.join(root, "project");
  const plannerOrder = [];
  let relatedCalls = 0;
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(projectRoot, "main.tex"), [
      "\\documentclass{article}",
      "\\setlength{\\columnsep}{10pt}",
      "\\begin{document}",
      "\\input{introduction}",
      "\\input{related_work}",
      "\\bibliographystyle{plain}",
      "\\bibliography{refs}",
      "\\end{document}"
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(projectRoot, "introduction.tex"), [
      "\\section{Introduction}",
      "The introduction contains enough academic prose and cites prior work \\cite{example}.",
      "\\begin{figure}[h]",
      "\\centering\\rule{1cm}{1cm}",
      "\\caption{Example}",
      "\\end{figure}"
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(projectRoot, "related_work.tex"), [
      "\\section{Related Work}",
      "The related work chapter contains enough academic prose for local processing.",
      "\\begin{equation}",
      "x = y + 1",
      "\\end{equation}"
    ].join("\n"), "utf8");
    const originalBib = "@misc{example, author={Example Author}, title={Example Reference}, year={2026}}\n";
    await fs.writeFile(path.join(projectRoot, "refs.bib"), originalBib, "utf8");

    configureFormatRuntime({
      dataRoot: path.join(root, "data"),
      callProvider: async (_provider, request) => {
        if (request.system.includes("format analyst")) return JSON.stringify({
          targetName: "Staged test format",
          summary: "Adjust global spacing and local float placement.",
          differences: [
            { id: "F1", category: "columns", current: "10pt gap", target: "12pt gap", action: "change column separation", risk: "low", scope: "global" },
            { id: "F2", category: "figure placement", current: "here", target: "top", action: "change local figure placement", risk: "low", scope: "local" }
          ],
          affectedFiles: [],
          warnings: []
        });
        if (!request.system.includes("format migration planner")) throw new Error("Unexpected model request.");
        const file = request.user.match(/# Current file: ([^\n]+)/)?.[1];
        plannerOrder.push(file);
        if (file === "main.tex") return JSON.stringify({
          file,
          operations: [{ id: "G1", type: "replace", oldText: "\\setlength{\\columnsep}{10pt}", newText: "\\setlength{\\columnsep}{12pt}", reason: "global column spacing" }]
        });
        if (file === "introduction.tex") return JSON.stringify({
          file,
          operations: [{ id: "L1", type: "replace", oldText: "\\begin{figure}[h]", newText: "\\begin{figure}[t]", reason: "local float placement" }]
        });
        relatedCalls += 1;
        if (relatedCalls === 1) return JSON.stringify({
          file,
          operations: [{ id: "L2", type: "insert_before", oldText: "\\section{Related Work}", newText: "\\usepackage{geometry}\n", reason: "invalid global command in local stage" }]
        });
        return JSON.stringify({ file, operations: [] });
      }
    });
    const job = await analyzeFormat({
      provider: {},
      projectRoot,
      mainTex: "main.tex",
      requirements: "Use a 12pt column gap and top-positioned figures",
      filePaths: []
    });
    assert.equal(job.workflow.mode, "global-local-bib");
    assert.deepEqual(job.workflow.bibliographyFiles, ["refs.bib"]);
    const result = await applyFormat({ provider: {}, projectRoot, mainTex: "main.tex", jobId: job.id });
    assert.equal(result.build.success, true);
    assert.deepEqual(plannerOrder, ["main.tex", "introduction.tex", "related_work.tex", "related_work.tex"]);
    assert.equal(result.job.execution.modelAttempts, 4);
    assert.deepEqual(result.job.execution.stages.map((stage) => stage.scope), ["global", "local", "local", "references"]);
    assert.match(await fs.readFile(path.join(projectRoot, "main.tex"), "utf8"), /columnsep\}\{12pt\}/);
    assert.match(await fs.readFile(path.join(projectRoot, "introduction.tex"), "utf8"), /figure\}\[t\]/);
    assert.equal(await fs.readFile(path.join(projectRoot, "refs.bib"), "utf8"), originalBib);
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});
