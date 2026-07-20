import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { performance } from "node:perf_hooks";
import test from "node:test";

const SECTION_PATTERN = /^\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)\b/;
const BEGIN_END_PATTERN = /^\\(begin|end)\{/;
const GROUPED_ENVS = new Set([
  "equation", "equation*", "align", "align*", "gather", "gather*",
  "multline", "multline*", "alignat", "alignat*", "flalign", "flalign*",
  "figure", "figure*", "table", "table*", "tabular", "tabular*",
  "tikzpicture", "pgfpicture", "verbatim", "lstlisting", "minted",
  "theorem", "lemma", "proposition", "corollary", "definition",
  "example", "remark", "proof", "abstract",
  "itemize", "enumerate", "description",
  "minipage", "center", "flushleft", "flushright",
  "thebibliography"
]);
const PROSE_GROUPED_ENVS = new Set([
  "proof", "theorem", "lemma", "proposition", "corollary", "definition", "example", "remark", "abstract"
]);

function djb2Hex(source) {
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(16);
}

function djb2Number(source) {
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(index)) | 0;
  }
  return hash;
}

function isEscaped(source, index) {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) count += 1;
  return count % 2 === 1;
}

function visibleTexLine(line) {
  const source = String(line || "");
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "%" && !isEscaped(source, index)) return source.slice(0, index).trimEnd();
  }
  return source;
}

function splitProseEnvBody({ envName, envArgs, bodyLines, bodyStartLine, beginLine }) {
  const paragraphs = [];
  let current = [];
  let currentStart = bodyStartLine;
  bodyLines.forEach((line, index) => {
    if (line.trim() === "") {
      if (current.length > 0) paragraphs.push({ lines: current, startLine: currentStart });
      current = [];
      currentStart = bodyStartLine + index + 1;
      return;
    }
    if (current.length === 0) currentStart = bodyStartLine + index;
    current.push(line);
  });
  if (current.length > 0) paragraphs.push({ lines: current, startLine: currentStart });

  if (paragraphs.length === 0) {
    return [{
      startLine: bodyStartLine - 1,
      endLine: bodyStartLine,
      source: `\\begin{${envName}}${envArgs}\n\\end{${envName}}`,
      parentEnv: envName,
      position: "only",
      parentEnvLine: beginLine
    }];
  }

  return paragraphs.map((paragraph, index) => {
    const position = paragraphs.length === 1
      ? "only"
      : index === 0
        ? "first"
        : index === paragraphs.length - 1
          ? "last"
          : "middle";
    const prefix = position === "first" || position === "only" ? `\\begin{${envName}}${envArgs}\n` : "";
    const suffix = position === "last" || position === "only" ? `\n\\end{${envName}}` : "";
    return {
      startLine: paragraph.startLine,
      endLine: paragraph.startLine + paragraph.lines.length - 1,
      source: `${prefix}${paragraph.lines.join("\n")}${suffix}`,
      parentEnv: envName,
      position,
      parentEnvLine: beginLine
    };
  });
}

function splitIntoBlocks(source) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const visibleLines = lines.map((line) => visibleTexLine(line));
  const blocks = [];
  const ordinalCounts = new Map();
  let blockStart = 0;
  let blockLines = [];

  const nextId = (blockSource) => {
    const hash = djb2Hex(blockSource);
    const ordinal = ordinalCounts.get(hash) ?? 0;
    ordinalCounts.set(hash, ordinal + 1);
    return `block-${hash}-${ordinal}`;
  };
  const flush = (endLine) => {
    if (blockLines.some((line) => line.trim() !== "")) {
      const blockSource = blockLines.join("\n");
      blocks.push({ id: nextId(blockSource), startLine: blockStart, endLine, source: blockSource });
    }
    blockLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = visibleLines[index];
    const trimmed = line.trim();
    const isBoundary = trimmed === "" || SECTION_PATTERN.test(trimmed) || BEGIN_END_PATTERN.test(trimmed);
    if (isBoundary && blockLines.length > 0) flush(index - 1);
    if (trimmed === "") {
      blockStart = index + 1;
      continue;
    }

    let gatheredAsEnv = false;
    const beginMatch = trimmed.match(/^\\begin\{(\w+\*?)\}(.*)$/);
    if (beginMatch && GROUPED_ENVS.has(beginMatch[1])) {
      gatheredAsEnv = true;
      const envName = beginMatch[1];
      const envArgs = beginMatch[2] || "";
      const beginPattern = `\\begin{${envName}}`;
      const endPattern = `\\end{${envName}}`;
      const beginLine = index;
      const bodyStartLine = index + 1;
      const bodyLines = [];
      let depth = 1;
      index += 1;
      while (index < lines.length && depth > 0) {
        const inner = visibleLines[index].trim();
        if (inner.includes(beginPattern)) depth += 1;
        if (inner.includes(endPattern)) depth -= 1;
        if (depth > 0) bodyLines.push(visibleLines[index]);
        if (depth > 0) index += 1;
      }
      if (PROSE_GROUPED_ENVS.has(envName)) {
        splitProseEnvBody({ envName, envArgs, bodyLines, bodyStartLine, beginLine })
          .forEach((block) => blocks.push({ id: nextId(block.source), ...block }));
      } else {
        const blockSource = [visibleLines[beginLine], ...bodyLines, visibleLines[index] ?? ""].join("\n");
        blocks.push({ id: nextId(blockSource), startLine: beginLine, endLine: index, source: blockSource });
      }
      blockStart = index + 1;
    }

    if (!gatheredAsEnv) {
      if (trimmed !== "" && blockLines.filter((line) => line.trim() !== "").length === 0) blockStart = index;
      blockLines.push(line);
    }
  }

  if (blockLines.length > 0) flush(lines.length - 1);
  return blocks;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderBlock(block) {
  const html = escapeHtml(block.source)
    .replace(/\\section\{([^}]*)\}/g, "<h2>$1</h2>")
    .replace(/\\subsection\{([^}]*)\}/g, "<h3>$1</h3>")
    .replace(/\$\$([\s\S]*?)\$\$/g, (_match, math) => `<span class="math-pending display" data-math="${escapeHtml(math)}"></span>`)
    .replace(/\$([^$\n]+)\$/g, (_match, math) => `<span class="math-pending" data-math="${escapeHtml(math)}"></span>`)
    .replace(/\n/g, "<br>");
  return {
    html: `<div class="preview-block" data-source-line="${block.startLine}" data-end-line="${block.endLine}">${html}</div>`,
    tikzBlocks: []
  };
}

function cachedBlocks(blocks) {
  return blocks.map((block) => {
    const rendered = renderBlock(block);
    return {
      id: block.id,
      startLine: block.startLine,
      endLine: block.endLine,
      sourceHash: djb2Number(block.source),
      html: rendered.html,
      htmlHash: djb2Number(rendered.html)
    };
  });
}

function diffBlocks(oldBlocks, newBlocks) {
  const patches = [];
  const newCachedBlocks = [];
  const oldById = new Map(oldBlocks.map((block) => [block.id, block]));
  const newIds = new Set(newBlocks.map((block) => block.id));

  oldBlocks.forEach((old) => {
    if (!newIds.has(old.id)) patches.push({ op: "delete", blockId: old.id });
  });

  const postDeleteOldOrder = oldBlocks.filter((block) => newIds.has(block.id) && block.html !== "").map((block) => block.id);
  const oldOrderMap = new Map(postDeleteOldOrder.map((id, index) => [id, index]));
  let maxOldPosition = -1;
  let lastAnchorId = null;

  newBlocks.forEach((block) => {
    const sourceHash = djb2Number(block.source);
    const old = oldById.get(block.id);
    let html;
    let htmlHash;
    if (!old) {
      const rendered = renderBlock(block);
      html = rendered.html;
      htmlHash = djb2Number(html);
      patches.push({ op: "insert", blockId: block.id, html, sourceLine: block.startLine, afterId: lastAnchorId });
    } else if (old.sourceHash === sourceHash) {
      html = old.html;
      htmlHash = old.htmlHash;
    } else {
      const rendered = renderBlock(block);
      html = rendered.html;
      htmlHash = djb2Number(html);
      patches.push({ op: "update", blockId: block.id, html, sourceLine: block.startLine });
    }

    if (old && html !== "") {
      const oldPosition = oldOrderMap.get(block.id);
      if (oldPosition !== undefined && oldPosition < maxOldPosition) {
        patches.push({ op: "move", blockId: block.id, afterId: lastAnchorId });
      }
      if (oldPosition !== undefined && oldPosition > maxOldPosition) maxOldPosition = oldPosition;
    }

    newCachedBlocks.push({
      id: block.id,
      startLine: block.startLine,
      endLine: block.endLine,
      sourceHash,
      html,
      htmlHash
    });
    if (html !== "") lastAnchorId = block.id;
  });

  return { patches, newCachedBlocks };
}

function createLargeTex(paragraphs = 2000) {
  const body = [];
  for (let index = 0; index < paragraphs; index += 1) {
    if (index % 100 === 0) body.push(`\\section{Section ${index / 100 + 1}}`);
    body.push(`Paragraph ${index} describes a wireless system with $E_${index}=mc^2$ and keeps source mapping stable.`);
    body.push("");
  }
  return ["\\documentclass{article}", "\\begin{document}", ...body, "\\end{document}"].join("\n");
}

test("fast preview probe splits real IEEE TeX into source-mapped blocks", async () => {
  const source = await fs.readFile(new URL("../template/conference-latex-template_10-17-19/Conference-LaTeX-template_10-17-19/conference_101719.tex", import.meta.url), "utf8");
  const blocks = splitIntoBlocks(source);
  assert.ok(blocks.length > 20);
  assert.ok(blocks.some((block) => SECTION_PATTERN.test(block.source.trim())));
  assert.ok(blocks.some((block) => /^\\begin\{figure\}/.test(block.source.trim()) && /\\end\{figure\}/.test(block.source)));
  assert.ok(blocks.every((block) => Number.isInteger(block.startLine) && block.startLine <= block.endLine));

  const mathBlock = renderBlock({ startLine: 10, endLine: 10, source: "The model uses $E=mc^2$ for a viewport-aware math placeholder." });
  assert.match(mathBlock.html, /class="math-pending"/);
  assert.match(mathBlock.html, /data-source-line="10"/);
});

test("fast preview probe hides TeX comments while preserving escaped percent signs", () => {
  const source = [
    "\\section{Visible Section}",
    "% This commented paragraph should never be rendered.",
    "Visible paragraph keeps 95\\% reliability. % This inline note should be hidden.",
    "% \\begin{equation}",
    "% x = y",
    "% \\end{equation}",
    "Another visible paragraph remains after commented math."
  ].join("\n");
  const html = splitIntoBlocks(source).map((block) => renderBlock(block).html).join("\n");

  assert.match(html, /Visible Section/);
  assert.match(html, /95\\% reliability/);
  assert.match(html, /Another visible paragraph/);
  assert.doesNotMatch(html, /commented paragraph/);
  assert.doesNotMatch(html, /inline note/);
  assert.doesNotMatch(html, /x = y/);
});

test("fast preview probe edits one prose block without re-rendering the document", () => {
  const source = createLargeTex();
  const oldBlocks = cachedBlocks(splitIntoBlocks(source));
  const edited = source.replace(
    "Paragraph 777 describes a wireless system",
    "Paragraph 777 adds a new scheduling insight"
  );

  const start = performance.now();
  const { patches } = diffBlocks(oldBlocks, splitIntoBlocks(edited));
  const elapsedMs = performance.now() - start;
  const renderedPatches = patches.filter((patch) => patch.op === "insert" || patch.op === "update");

  assert.ok(elapsedMs < 1000, `incremental split+diff took ${elapsedMs.toFixed(1)} ms`);
  assert.equal(renderedPatches.length, 1);
  assert.ok(patches.length <= 2);
  assert.match(renderedPatches[0].html, /data-source-line="\d+"/);
});

test("fast preview probe inserts a section as a small patch instead of a full rerender", () => {
  const source = createLargeTex(800);
  const oldBlocks = cachedBlocks(splitIntoBlocks(source));
  const inserted = source.replace(
    "Paragraph 420 describes a wireless system",
    "\\subsection{Inserted Preview Section}\n\nParagraph 420 describes a wireless system"
  );

  const { patches } = diffBlocks(oldBlocks, splitIntoBlocks(inserted));
  const insertPatches = patches.filter((patch) => patch.op === "insert");

  assert.ok(insertPatches.length <= 2);
  assert.ok(insertPatches.some((patch) => /Inserted Preview Section/.test(patch.html)));
  assert.ok(patches.length < 10);
});
