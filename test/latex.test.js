import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analyzeLatexCommands,
  deleteSegment,
  discoverTexFiles,
  findMissingProtectedTokens,
  insertSegment,
  parseSegments,
  readDocument,
  replaceSegment
} from "../lib/latex.js";
import { getFloatLayout } from "../lib/project.js";

test("parseSegments keeps prose and skips figures", () => {
  const source = [
    "\\section{Introduction}",
    "",
    "This paragraph contains enough academic prose to become an editable segment with \\cite{demo}.",
    "",
    "\\begin{figure}",
    "\\includegraphics{demo.pdf}",
    "\\caption{This caption must not be edited as body prose.}",
    "\\end{figure}",
    "",
    "A second paragraph provides sufficient words for another editable bilingual segment."
  ].join("\n");
  const parsed = parseSegments(source, "main.tex");
  assert.equal(parsed.segments.length, 2);
  assert.match(parsed.segments[0].english, /cite\{demo\}/);
  assert.doesNotMatch(parsed.segments.map((item) => item.english).join("\n"), /caption must not/);
});

test("parseSegments assigns prose to top-level LaTeX sections", () => {
  const source = [
    "An abstract paragraph contains enough academic prose to remain editable before the first section.",
    "",
    "\\section{Introduction}",
    "The introduction paragraph contains enough academic prose for section-scoped translation.",
    "",
    "\\subsection{Motivation}",
    "The motivation paragraph remains part of the same top-level introduction section.",
    "",
    "\\section{Method}",
    "The method paragraph contains enough academic prose for a separate translation request."
  ].join("\n");

  const parsed = parseSegments(source, "main.tex");
  assert.deepEqual(parsed.segments.map((segment) => segment.sectionTitle), ["", "Introduction", "Introduction", "Method"]);
  assert.deepEqual(parsed.segments.map((segment) => segment.sectionIndex), [0, 1, 1, 2]);
  assert.equal(parsed.segments[1].sectionId, parsed.segments[2].sectionId);
  assert.notEqual(parsed.segments[2].sectionId, parsed.segments[3].sectionId);
  assert.deepEqual(parsed.segments.map((segment) => segment.heading?.title || ""), [
    "",
    "Introduction",
    "Motivation",
    "Method"
  ]);
  assert.deepEqual(parsed.segments[2].headingPath.map((heading) => heading.title), ["Introduction", "Motivation"]);
  assert.equal(parsed.segments[2].heading.level, 2);
});

test("parseSegments preserves nested LaTeX titles for the bilingual editor", () => {
  const source = [
    "\\section[Short title]{System \\textit{Overview}}",
    "The overview paragraph contains enough academic prose to remain editable in the bilingual view.",
    "",
    "\\subsection{Runtime Design}",
    "The runtime paragraph also contains enough academic prose to remain visible for translation.",
    "",
    "\\subsubsection{Compile Cache}",
    "The cache paragraph contains enough academic prose for a third level heading test."
  ].join("\n");

  const parsed = parseSegments(source, "main.tex");
  assert.deepEqual(parsed.segments.map((segment) => segment.heading.title), [
    "System Overview",
    "Runtime Design",
    "Compile Cache"
  ]);
  assert.deepEqual(parsed.segments[2].headingPath.map((heading) => heading.level), [1, 2, 3]);
  assert.equal(parsed.segments[0].heading.latexTitle, "System \\textit{Overview}");
});

test("parseSegments excludes IEEE preamble, author metadata, math, and references", () => {
  const source = [
    "\\documentclass[conference]{IEEEtran}",
    "\\usepackage{cite}",
    "\\usepackage{amsmath,amssymb,amsfonts}",
    "\\usepackage{algorithmic}",
    "\\usepackage{graphicx}",
    "\\usepackage{textcomp}",
    "\\usepackage{xcolor}",
    "\\def\\BibTeX{{\\rm B\\kern-.05em{\\sc i\\kern-.025em b}\\kern-.08em",
    "    T\\kern-.1667em\\lower.7ex\\hbox{E}\\kern-.125emX}}",
    "\\title{A Private Paper Title That Must Not Become Body Prose}",
    "\\author{\\IEEEauthorblockN{Alice Example and Bob Example}",
    "\\IEEEauthorblockA{Private University and private@example.com}}",
    "\\begin{document}",
    "\\maketitle",
    "\\begin{abstract}",
    "This abstract paragraph contains enough ordinary academic prose to require bilingual editing.",
    "\\end{abstract}",
    "\\section{Introduction}",
    "This introduction paragraph contains enough meaningful academic prose to remain editable in PaperBridge.",
    "\\[",
    "E = mc^2",
    "\\]",
    "\\begin{figure}",
    "\\caption{A private figure caption that should not enter the translation queue.}",
    "\\end{figure}",
    "\\begin{thebibliography}{1}",
    "\\bibitem{demo} A. Author, A reference title with many words, 2026.",
    "\\end{thebibliography}",
    "\\end{document}"
  ].join("\n");

  const parsed = parseSegments(source, "main.tex");
  assert.equal(parsed.segments.length, 2);
  const english = parsed.segments.map((segment) => segment.english).join("\n");
  assert.match(english, /abstract paragraph/);
  assert.match(english, /introduction paragraph/);
  assert.doesNotMatch(english, /usepackage|BibTeX|Alice Example|private@example|mc\^2|figure caption|reference title/);
});

test("parseSegments excludes standalone macro and bibliography files", () => {
  const macros = [
    "\\usepackage{xcolor}",
    "\\newcommand{\\systemname}{",
    "  A long internal macro definition with words that are not manuscript prose",
    "}",
    "\\def\\AnotherMacro{More implementation text that must stay outside translation}"
  ].join("\n");
  const references = [
    "\\bibitem{first}",
    "A. Author and B. Author, A long reference entry that should never be translated.",
    "\\bibitem{second}",
    "C. Author, Another long reference entry that must remain untouched."
  ].join("\n");
  const body = "A section file without document boundaries still contains editable academic manuscript prose.";

  assert.equal(parseSegments(macros, "macros.tex").segments.length, 0);
  assert.equal(parseSegments(references, "references.tex").segments.length, 0);
  assert.equal(parseSegments(body, "introduction.tex").segments.length, 1);
});

test("protected LaTeX tokens are detected", () => {
  const original = "Results improve by $35\\%$ as shown in Fig.~\\ref{system} and \\cite{cedar}.";
  const next = "Results improve by $35\\%$ according to \\cite{cedar}.";
  assert.deepEqual(findMissingProtectedTokens(original, "", next), ["\\ref{system}"]);
});

test("translation token checks allow soft English-only formatting edits", () => {
  const original = "Results improve by $35\\%$ as shown in Fig.~\\ref{system} and prior work~\\cite{cedar}.";
  const next = "Results improve by 35 percent in the revised text.";
  assert.deepEqual(findMissingProtectedTokens(original, "", next, { allowSoftEnglishRemovals: true }), [
    "\\ref{system}",
    "\\cite{cedar}"
  ]);
  assert.deepEqual(findMissingProtectedTokens("", "Keep \\cite{cedar} in the sentence.", next, {
    allowSoftEnglishRemovals: true
  }), ["\\cite{cedar}"]);
});

test("AI LaTeX command analysis blocks dangerous additions and reports unexpected commands", () => {
  const dangerous = analyzeLatexCommands(
    ["Existing text with \\cite{demo}."],
    "Revised text with \\cite{demo} and \\input{C:/private-file}."
  );
  assert.deepEqual(dangerous.dangerousCommands, ["\\input", "\\input{C:/private-file}"]);

  const unexpected = analyzeLatexCommands(
    ["Existing plain academic prose."],
    "Revised \\textbf{academic prose} with emphasis."
  );
  assert.deepEqual(unexpected.dangerousCommands, []);
  assert.deepEqual(unexpected.unexpectedCommands, ["\\textbf"]);
});

test("project file resolution rejects a directory junction outside the project", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paper-bridge-realpath-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "paper-bridge-outside-"));
  try {
    await fs.writeFile(path.join(outside, "section.tex"), "External text must not be editable through a link.\n", "utf8");
    try {
      await fs.symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error.code)) return t.skip("Symbolic links are unavailable in this environment.");
      throw error;
    }
    await assert.rejects(readDocument(root, "linked/section.tex"), /escapes|Symbolic links/);
  } finally {
    for (const target of [root, outside]) {
      const relative = path.relative(os.tmpdir(), target);
      assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
      await fs.rm(target, { recursive: true, force: true });
    }
  }
});

test("discover and replace paragraphs without touching included files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paper-bridge-"));
  await fs.writeFile(path.join(root, "main.tex"), "\\input{section}\n", "utf8");
  await fs.writeFile(
    path.join(root, "section.tex"),
    "The original English paragraph contains enough words for the parser to select it.\n",
    "utf8"
  );
  assert.deepEqual(await discoverTexFiles(root, "main.tex"), ["main.tex", "section.tex"]);
  const document = await readDocument(root, "section.tex");
  const segment = document.segments[0];
  await replaceSegment(
    root,
    "section.tex",
    segment.index,
    segment.sourceHash,
    "The revised English paragraph still contains enough words and remains valid LaTeX prose."
  );
  const revised = await fs.readFile(path.join(root, "section.tex"), "utf8");
  assert.match(revised, /revised English paragraph/);
});

test("insert and delete editable paragraphs without changing their neighbors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paper-bridge-structure-"));
  try {
    await fs.writeFile(
      path.join(root, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "The first English paragraph contains enough academic words to remain editable.",
        "",
        "The second English paragraph also contains enough academic words to remain editable.",
        "\\end{document}"
      ].join("\n"),
      "utf8"
    );
    let document = await readDocument(root, "main.tex");
    const inserted = await insertSegment(
      root,
      "main.tex",
      document.segments[0].index,
      document.segments[0].sourceHash,
      "A newly translated English paragraph contains enough publication ready academic prose.",
      "after"
    );
    assert.equal(inserted.document.segments.length, 3);
    assert.match(inserted.document.segments[0].english, /first English/);
    assert.match(inserted.document.segments[1].english, /newly translated/);
    assert.match(inserted.document.segments[2].english, /second English/);

    const removed = await deleteSegment(
      root,
      "main.tex",
      inserted.segment.index,
      inserted.segment.sourceHash
    );
    document = removed.document;
    assert.equal(document.segments.length, 2);
    assert.match(document.segments[0].english, /first English/);
    assert.match(document.segments[1].english, /second English/);
    assert.doesNotMatch(await fs.readFile(path.join(root, "main.tex"), "utf8"), /newly translated/);
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("float layout reads figure pages from the aux file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paper-bridge-layout-"));
  await fs.writeFile(
    path.join(root, "main.tex"),
    "\\begin{figure}\n\\caption{Demo}\n\\label{fig:demo}\n\\end{figure}\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(root, "main.aux"),
    "\\newlabel{fig:demo}{{1}{4}{Demo}{figure.1}{}}\n",
    "utf8"
  );
  assert.deepEqual(await getFloatLayout(root, "main.tex"), [
    { label: "fig:demo", type: "figure", file: "main.tex", page: 4 }
  ]);
});
