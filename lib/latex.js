import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const EXCLUDED_ENVIRONMENTS = new Set([
  "algorithm",
  "algorithmic",
  "align",
  "align*",
  "alignat",
  "alignat*",
  "algorithm2e",
  "comment",
  "displaymath",
  "equation",
  "equation*",
  "figure",
  "figure*",
  "filecontents",
  "filecontents*",
  "flalign",
  "flalign*",
  "gather",
  "gather*",
  "longtable",
  "lstlisting",
  "math",
  "minted",
  "multline",
  "multline*",
  "table",
  "table*",
  "tabular",
  "tabular*",
  "tabularx",
  "thebibliography",
  "tikzpicture",
  "verbatim",
  "verbatim*",
  "Verbatim"
]);

const EDITABLE_MATH_ENVIRONMENTS = new Set([
  "align",
  "align*",
  "alignat",
  "alignat*",
  "displaymath",
  "equation",
  "equation*",
  "flalign",
  "flalign*",
  "gather",
  "gather*",
  "math",
  "multline",
  "multline*"
]);

const TABLE_CONTAINER_ENVIRONMENTS = new Set(["table", "table*", "longtable", "tabular", "tabular*", "tabularx"]);
const TABULAR_ENVIRONMENTS = new Set(["longtable", "tabular", "tabular*", "tabularx"]);

const STRUCTURAL_COMMAND = /^\s*\\(?:acmBooktitle|acmConference|acmDOI|acmISBN|acmYear|addtolength|affiliation|author|authornote|authornotemark|balance|bibliography|bibliographystyle|caption|ccsdesc|centering|copyrightyear|date|documentclass|email|end|geometry|hypersetup|IEEEauthorblockA|IEEEauthorblockN|include|includegraphics|input|keywords|label|maketitle|newtheorem|orcid|pagestyle|PassOptionsToPackage|printbibliography|received|RequirePackage|section|setcopyright|setcounter|setlength|settopmatter|subsection|subsubsection|title|usepackage|vspace)\b/;
const EXCLUDED_COMMAND_BLOCK = /^\s*\\(?:address|affiliation|author|authornote|authornotemark|city|corref|cortext|country|date|def|Declare\w*|department|ead|edef|email|fnref|fntext|gdef|institute|institution|newcommand|newenvironment|postalcode|providecommand|renewcommand|renewenvironment|streetaddress|thanks|title|xdef)\b/;
const HEADING_LEVELS = new Map([
  ["section", 1],
  ["subsection", 2],
  ["subsubsection", 3]
]);

export function hashText(value) {
  return crypto.createHash("sha1").update(value, "utf8").digest("hex");
}

function normalizeRelativeTexPath(value) {
  return value.endsWith(".tex") ? value : `${value}.tex`;
}

function assertWithinRoot(root, target) {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path escapes the configured paper project.");
  }
}

export async function resolveProjectFile(projectRoot, relativeFile) {
  const lexicalRoot = path.resolve(projectRoot);
  const lexicalTarget = path.resolve(lexicalRoot, relativeFile);
  assertWithinRoot(lexicalRoot, lexicalTarget);
  const stat = await fs.lstat(lexicalTarget);
  if (stat.isSymbolicLink()) {
    const error = new Error("Symbolic links cannot be edited by PaperBridge.");
    error.code = "SYMLINK_NOT_ALLOWED";
    throw error;
  }
  const [realRoot, realTarget] = await Promise.all([fs.realpath(lexicalRoot), fs.realpath(lexicalTarget)]);
  assertWithinRoot(realRoot, realTarget);
  return realTarget;
}

export async function discoverTexFiles(projectRoot, mainTex) {
  const root = path.resolve(projectRoot);
  const visited = new Set();
  const ordered = [];

  async function visit(relativeFile) {
    const normalized = normalizeRelativeTexPath(relativeFile).replaceAll("/", path.sep);
    const lexical = path.resolve(root, normalized);
    const absolute = await resolveProjectFile(root, normalized);
    const key = path.relative(root, lexical).replaceAll(path.sep, "/");
    if (visited.has(key)) return;
    visited.add(key);

    const content = await fs.readFile(absolute, "utf8");
    ordered.push(key);
    const baseDir = path.dirname(key);
    const includes = [...content.matchAll(/\\(?:input|include)\s*\{([^}]+)\}/g)]
      .map((match) => match[1].trim())
      .filter(Boolean);

    for (const include of includes) {
      const child = path.posix.normalize(path.posix.join(baseDir.replaceAll("\\", "/"), include));
      try {
        await visit(child);
      } catch (error) {
        // A malformed, missing, or out-of-root include belongs to the compile
        // diagnostics path.  Do not prevent the user from saving the TeX that
        // contains it, and never follow a path outside the project root.
        if (error?.code === "ENOENT" || error?.message === "Path escapes the configured paper project." || error?.code === "SYMLINK_NOT_ALLOWED") continue;
        throw error;
      }
    }
  }

  await visit(mainTex);
  return ordered;
}

export async function inspectBibliographyFiles(projectRoot, mainTex) {
  const root = path.resolve(projectRoot);
  const texFiles = await discoverTexFiles(root, mainTex);
  const referenced = [];
  let inline = false;
  for (const file of texFiles) {
    const content = await fs.readFile(await resolveProjectFile(root, file), "utf8");
    if (/\\begin\s*\{thebibliography\}/.test(content) || /\\begin\s*\{filecontents\*?\}\s*\{[^}]+\.bib\}/i.test(content)) {
      inline = true;
    }
    for (const match of content.matchAll(/\\bibliography\s*\{([^}]+)\}/g)) {
      referenced.push(...match[1].split(","));
    }
    for (const match of content.matchAll(/\\addbibresource(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
      referenced.push(match[1]);
    }
  }

  const files = [];
  const missing = [];
  for (const value of [...new Set(referenced.map((item) => String(item).trim()).filter(Boolean))]) {
    let normalized = value.replace(/^file:/i, "").replaceAll("\\", "/");
    if (!normalized.toLowerCase().endsWith(".bib")) normalized += ".bib";
    normalized = path.posix.normalize(normalized).replace(/^\.\//, "");
    if (!normalized || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
      missing.push(normalized || value);
      continue;
    }
    try {
      const absolute = await resolveProjectFile(root, normalized);
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) throw new Error("not a file");
      files.push(normalized);
    } catch {
      missing.push(normalized);
    }
  }
  return {
    files: [...new Set(files)],
    missing: [...new Set(missing)],
    referenced: [...new Set([...files, ...missing])],
    inline
  };
}

export async function discoverBibliographyFiles(projectRoot, mainTex) {
  return (await inspectBibliographyFiles(projectRoot, mainTex)).files;
}

function stripLatex(value) {
  return value
    .replace(/\$\$[\s\S]*?\$\$/g, " MATH ")
    .replace(/\$[^$]*\$/g, " MATH ")
    .replace(/\\\([\s\S]*?\\\)/g, " MATH ")
    .replace(/\\(?:cite\w*|ref|eqref|autoref|cref|Cref|pageref|label|url)\s*(?:\[[^\]]*\]\s*)*\{[^{}]*\}/g, " ")
    .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/g, " ")
    .replace(/[{}~]/g, " ")
    .replace(/\\[%&#_$]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasInlineComment(value) {
  return value.split(/\r?\n/).some((line) => /(^|[^\\])%/.test(line));
}

function isStructuralLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("%")) return true;
  if (/^\\(?:begin|end)\s*\{/.test(trimmed)) return true;
  return STRUCTURAL_COMMAND.test(line);
}

function extractHeading(line) {
  const command = line.match(/^\s*\\(section|subsection|subsubsection)(\*)?/);
  if (!command) return null;
  let cursor = command[0].length;
  const skipWhitespace = () => {
    while (/\s/.test(line[cursor] || "")) cursor += 1;
  };
  const readGroup = (open, close) => {
    if (line[cursor] !== open) return "";
    const start = ++cursor;
    let depth = 1;
    while (cursor < line.length) {
      if (line[cursor] === "\\") {
        cursor += 2;
        continue;
      }
      if (line[cursor] === open) depth += 1;
      if (line[cursor] === close) depth -= 1;
      if (depth === 0) return line.slice(start, cursor++);
      cursor += 1;
    }
    return "";
  };

  skipWhitespace();
  if (line[cursor] === "[") {
    readGroup("[", "]");
    skipWhitespace();
  }
  if (line[cursor] !== "{") return null;
  const latexTitle = readGroup("{", "}").trim();
  if (!latexTitle) return null;
  return {
    command: command[1],
    level: HEADING_LEVELS.get(command[1]),
    starred: Boolean(command[2]),
    latexTitle,
    title: stripLatex(latexTitle) || latexTitle
  };
}

function braceDelta(line) {
  let depth = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === "\\") {
      index += 1;
      continue;
    }
    if (line[index] === "{") depth += 1;
    if (line[index] === "}") depth -= 1;
  }
  return depth;
}

export function parseSegments(content, file = "document.tex") {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const segments = [];
  const buffer = [];
  let bufferStart = 0;
  const excludedStack = [];
  const hasDocumentBoundary = lines.some((line) => !line.trimStart().startsWith("%") && /\\begin\s*\{document\}/.test(line));
  let inDocument = !hasDocumentBoundary;
  let excludedCommandDepth = 0;
  let displayMathDelimiter = "";
  let bibliographyTail = false;
  let sectionIndex = 0;
  let sectionTitle = "";
  let headingPath = [];

  function flush(endLineExclusive) {
    if (!buffer.length) return;
    const raw = buffer.join(eol).trimEnd();
    const plainText = stripLatex(raw);
    const wordCount = plainText.split(/\s+/).filter(Boolean).length;
    if (wordCount >= 6 && !hasInlineComment(raw)) {
      const index = segments.length;
      segments.push({
        id: `${file}:${index}`,
        index,
        file,
        startLine: bufferStart + 1,
        endLine: endLineExclusive,
        english: raw,
        sourceHash: hashText(raw),
        plainText,
        wordCount,
        sectionId: `${file}:section:${sectionIndex}`,
        sectionIndex,
        sectionTitle,
        heading: headingPath.length ? { ...headingPath.at(-1) } : null,
        headingPath: headingPath.map((heading) => ({ ...heading }))
      });
    }
    buffer.length = 0;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const activeLine = stripLatexComment(line);
    const commented = !activeLine.trim();
    if (hasDocumentBoundary && !inDocument) {
      if (!commented && /\\begin\s*\{document\}/.test(activeLine)) inDocument = true;
      continue;
    }
    if (hasDocumentBoundary && !commented && /\\end\s*\{document\}/.test(activeLine)) {
      flush(i);
      inDocument = false;
      continue;
    }
    if (bibliographyTail) continue;
    if (/^\s*\\bibitem\b/.test(activeLine)) {
      flush(i);
      bibliographyTail = true;
      continue;
    }
    if (excludedCommandDepth > 0) {
      excludedCommandDepth += braceDelta(activeLine);
      if (excludedCommandDepth <= 0) excludedCommandDepth = 0;
      continue;
    }
    if (EXCLUDED_COMMAND_BLOCK.test(activeLine)) {
      flush(i);
      excludedCommandDepth = Math.max(0, braceDelta(activeLine));
      continue;
    }
    if (displayMathDelimiter) {
      if (markerIndex(activeLine, displayMathDelimiter) >= 0) displayMathDelimiter = "";
      continue;
    }
    if (markerIndex(activeLine, "\\[") >= 0) {
      flush(i);
      if (markerIndex(activeLine, "\\]") < 0) displayMathDelimiter = "\\]";
      continue;
    }
    const displayDollarCount = (activeLine.match(/\$\$/g) || []).length;
    if (displayDollarCount) {
      flush(i);
      if (displayDollarCount % 2 === 1) displayMathDelimiter = "$$";
      continue;
    }
    const beginMatches = [...activeLine.matchAll(/\\begin\s*\{([^}]+)\}/g)].map((match) => match[1]);
    const endMatches = [...activeLine.matchAll(/\\end\s*\{([^}]+)\}/g)].map((match) => match[1]);
    const wasExcluded = excludedStack.length > 0;
    const beginsExcluded = beginMatches.filter((name) => EXCLUDED_ENVIRONMENTS.has(name));

    if (beginsExcluded.length) {
      if (!wasExcluded) flush(i);
      excludedStack.push(...beginsExcluded);
    }
    if (wasExcluded || beginsExcluded.length) {
      for (const name of endMatches) {
        const last = excludedStack.lastIndexOf(name);
        if (last >= 0) excludedStack.splice(last, 1);
      }
      continue;
    }

    const heading = commented ? null : extractHeading(activeLine);
    if (heading) {
      flush(i);
      if (heading.level === 1) {
        sectionIndex += 1;
        sectionTitle = heading.title || `Section ${sectionIndex}`;
      }
      headingPath = [
        ...headingPath.filter((item) => item.level < heading.level),
        { ...heading, id: `${file}:heading:${i + 1}`, line: i + 1 }
      ];
      continue;
    }
    if (isStructuralLine(activeLine)) {
      flush(i);
      continue;
    }

    if (!buffer.length) bufferStart = i;
    buffer.push(line);
  }

  flush(lines.length);
  return { eol, lines, segments };
}

function markerIndex(line, marker, from = 0) {
  let index = String(line || "").indexOf(marker, from);
  while (index >= 0) {
    if (!fastLatexMarkerEscaped(line, index)) return index;
    index = line.indexOf(marker, index + marker.length);
  }
  return -1;
}

function fastLatexMarkerEscaped(source, index) {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) count += 1;
  return count % 2 === 1;
}

function stripLatexComment(line) {
  const source = String(line || "");
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "%" || fastLatexMarkerEscaped(source, index)) continue;
    return source.slice(0, index);
  }
  return source;
}

function mathBlockLabel(kind, name = "") {
  if (kind === "environment" && name) return name;
  if (name === "$$") return "$$";
  return "display math";
}

export function parseMathBlocks(content, file = "document.tex") {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const blocks = [];
  const excludedStack = [];
  const hasDocumentBoundary = lines.some((line) => !line.trimStart().startsWith("%") && /\\begin\s*\{document\}/.test(line));
  let inDocument = !hasDocumentBoundary;
  let headingPath = [];
  let bibliographyTail = false;

  function pushBlock(startIndex, endIndex, kind, name) {
    const source = lines.slice(startIndex, endIndex + 1).join(eol).trim();
    if (!source) return;
    const index = blocks.length;
    blocks.push({
      id: `${file}:math:${hashText(`${startIndex + 1}\0${endIndex + 1}\0${source}`)}`,
      type: "math",
      kind,
      name,
      label: mathBlockLabel(kind, name),
      index,
      file,
      startLine: startIndex + 1,
      endLine: endIndex + 1,
      source,
      sourceHash: hashText(source),
      headingPath: headingPath.map((heading) => ({ ...heading }))
    });
  }

  function findDisplayMathEnd(startIndex, marker, openIndex) {
    const closeMarker = marker === "\\[" ? "\\]" : "$$";
    const sameLineClose = markerIndex(stripLatexComment(lines[startIndex]), closeMarker, openIndex + marker.length);
    if (sameLineClose >= 0) return startIndex;
    for (let index = startIndex + 1; index < lines.length; index += 1) {
      const activeLine = stripLatexComment(lines[index]);
      if (!activeLine.trim()) continue;
      if (markerIndex(activeLine, closeMarker) >= 0) return index;
      if (hasDocumentBoundary && /\\end\s*\{document\}/.test(activeLine)) return index - 1;
    }
    return lines.length - 1;
  }

  function findEnvironmentEnd(startIndex, envName) {
    let depth = 0;
    for (let index = startIndex; index < lines.length; index += 1) {
      const line = stripLatexComment(lines[index]);
      if (!line.trim()) continue;
      const begins = [...line.matchAll(/\\begin\s*\{([^}]+)\}/g)].filter((match) => match[1] === envName);
      const ends = [...line.matchAll(/\\end\s*\{([^}]+)\}/g)].filter((match) => match[1] === envName);
      depth += begins.length;
      depth -= ends.length;
      if (depth <= 0 && (begins.length || ends.length)) return index;
      if (hasDocumentBoundary && /\\end\s*\{document\}/.test(line)) return Math.max(startIndex, index - 1);
    }
    return lines.length - 1;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const activeLine = stripLatexComment(line);
    const commented = !activeLine.trim();
    if (hasDocumentBoundary && !inDocument) {
      if (!commented && /\\begin\s*\{document\}/.test(activeLine)) inDocument = true;
      continue;
    }
    if (hasDocumentBoundary && !commented && /\\end\s*\{document\}/.test(activeLine)) break;
    if (bibliographyTail) continue;
    if (!commented && /^\s*\\bibitem\b/.test(line)) {
      bibliographyTail = true;
      continue;
    }

    const beginMatches = commented ? [] : [...activeLine.matchAll(/\\begin\s*\{([^}]+)\}/g)].map((match) => match[1]);
    const endMatches = commented ? [] : [...activeLine.matchAll(/\\end\s*\{([^}]+)\}/g)].map((match) => match[1]);

    if (excludedStack.length) {
      for (const name of beginMatches) {
        if (EXCLUDED_ENVIRONMENTS.has(name) && !EDITABLE_MATH_ENVIRONMENTS.has(name)) excludedStack.push(name);
      }
      for (const name of endMatches) {
        const last = excludedStack.lastIndexOf(name);
        if (last >= 0) excludedStack.splice(last, 1);
      }
      continue;
    }

    const heading = commented ? null : extractHeading(activeLine);
    if (heading) {
      headingPath = [
        ...headingPath.filter((item) => item.level < heading.level),
        { ...heading, id: `${file}:heading:${index + 1}`, line: index + 1 }
      ];
      continue;
    }

    const envName = beginMatches.find((name) => EDITABLE_MATH_ENVIRONMENTS.has(name));
    if (envName) {
      const endIndex = findEnvironmentEnd(index, envName);
      pushBlock(index, endIndex, "environment", envName);
      index = endIndex;
      continue;
    }

    const nonMathExcluded = beginMatches.filter((name) => EXCLUDED_ENVIRONMENTS.has(name) && !EDITABLE_MATH_ENVIRONMENTS.has(name));
    if (nonMathExcluded.length) {
      excludedStack.push(...nonMathExcluded);
      for (const name of endMatches) {
        const last = excludedStack.lastIndexOf(name);
        if (last >= 0) excludedStack.splice(last, 1);
      }
      continue;
    }

    const bracketMath = markerIndex(activeLine, "\\[");
    if (bracketMath >= 0) {
      const endIndex = findDisplayMathEnd(index, "\\[", bracketMath);
      pushBlock(index, endIndex, "delimiter", "\\[");
      index = endIndex;
      continue;
    }
    const dollarMath = markerIndex(activeLine, "$$");
    if (dollarMath >= 0) {
      const endIndex = findDisplayMathEnd(index, "$$", dollarMath);
      pushBlock(index, endIndex, "delimiter", "$$");
      index = endIndex;
    }
  }

  return blocks;
}

function findEnvironmentEnd(lines, startIndex, envName, hasDocumentBoundary = false) {
  let depth = 0;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = stripLatexComment(lines[index]);
    if (!line.trim()) continue;
    const begins = [...line.matchAll(/\\begin\s*\{([^}]+)\}/g)].filter((match) => match[1] === envName);
    const ends = [...line.matchAll(/\\end\s*\{([^}]+)\}/g)].filter((match) => match[1] === envName);
    depth += begins.length;
    depth -= ends.length;
    if (depth <= 0 && (begins.length || ends.length)) return index;
    if (hasDocumentBoundary && /\\end\s*\{document\}/.test(line)) return Math.max(startIndex, index - 1);
  }
  return lines.length - 1;
}

function splitLatexCells(value) {
  const cells = [];
  let current = "";
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\\") {
      current += char;
      if (index + 1 < value.length) current += value[++index];
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") depth = Math.max(0, depth - 1);
    if (char === "&" && depth === 0) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripTableCellLatex(value) {
  let text = String(value || "")
    .replace(/\\(?:textbf|textit|emph|texttt|textsc|mathrm|mathbf|mathit)\s*\{([^{}]*)\}/g, "$1")
    .replace(/\\(?:multicolumn|multirow)\s*\{[^{}]*\}\s*(?:\{[^{}]*\}\s*)?\{([^{}]*)\}/g, "$1")
    .replace(/\\(?:cite\w*|ref|eqref|autoref|cref|Cref|pageref|label)\s*(?:\[[^\]]*\]\s*)*\{[^{}]*\}/g, "")
    .replace(/\\%/g, "%")
    .replace(/\\&/g, "&")
    .replace(/\\_/g, "_")
    .replace(/\\#/g, "#")
    .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/g, "")
    .replace(/[{}]/g, "")
    .replace(/~/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text && value.trim()) text = value.replace(/[{}]/g, "").trim();
  return text;
}

function tableStructuralLine(line) {
  return /^\s*(?:\\(?:toprule|midrule|bottomrule|hline|cline|cmidrule|addlinespace|specialrule)\b|%|$)/.test(line);
}

function hasTableRowEnd(line) {
  return /(^|[^\\])\\\\(?:\s*(?:\[[^\]]*\])?)?\s*$/.test(line.trim());
}

function stripTableRowEnd(value) {
  return value.replace(/(^|[^\\])\\\\(?:\s*(?:\[[^\]]*\])?)?\s*$/s, "$1").trim();
}

function parseTableRows(lines, tabularStart, tabularEnd) {
  const rows = [];
  let rowStart = -1;
  const parts = [];
  const flush = (endLine) => {
    if (!parts.length) return;
    const raw = parts.join("\n");
    const withoutEnd = stripTableRowEnd(raw);
    const rawCells = splitLatexCells(withoutEnd);
    if (rawCells.length > 1 || stripTableCellLatex(rawCells[0] || "")) {
      rows.push({
        index: rows.length,
        startLine: rowStart + 1,
        endLine: endLine + 1,
        cells: rawCells.map((cell, column) => ({
          column,
          source: cell,
          text: stripTableCellLatex(cell)
        }))
      });
    }
    rowStart = -1;
    parts.length = 0;
  };

  for (let index = tabularStart + 1; index < tabularEnd; index += 1) {
    const line = lines[index];
    if (!parts.length && tableStructuralLine(line)) continue;
    if (!parts.length) rowStart = index;
    parts.push(line);
    if (hasTableRowEnd(line)) flush(index);
  }
  return rows;
}

function findFirstTabular(lines, startIndex, endIndex, hasDocumentBoundary) {
  for (let index = startIndex; index <= endIndex; index += 1) {
    const line = lines[index];
    if (line.trimStart().startsWith("%")) continue;
    const match = [...line.matchAll(/\\begin\s*\{([^}]+)\}/g)]
      .find((candidate) => TABULAR_ENVIRONMENTS.has(candidate[1]));
    if (!match) continue;
    const envName = match[1];
    return {
      envName,
      startLine: index + 1,
      endLine: findEnvironmentEnd(lines, index, envName, hasDocumentBoundary) + 1
    };
  }
  return null;
}

function tableCaption(source) {
  const match = source.match(/\\caption(?:\[[^\]]*\])?\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/);
  return match ? stripLatex(match[1]) || "Table" : "Table";
}

export function parseTableBlocks(content, file = "document.tex") {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const blocks = [];
  const excludedStack = [];
  const hasDocumentBoundary = lines.some((line) => !line.trimStart().startsWith("%") && /\\begin\s*\{document\}/.test(line));
  let inDocument = !hasDocumentBoundary;
  let headingPath = [];
  let bibliographyTail = false;

  function pushBlock(startIndex, endIndex, envName, tabular) {
    const source = lines.slice(startIndex, endIndex + 1).join(eol).trim();
    if (!source || !tabular) return;
    const rows = parseTableRows(lines, tabular.startLine - 1, tabular.endLine - 1);
    if (!rows.length) return;
    const index = blocks.length;
    blocks.push({
      id: `${file}:table:${hashText(`${startIndex + 1}\0${endIndex + 1}\0${source}`)}`,
      type: "table",
      index,
      file,
      envName,
      label: tableCaption(source),
      startLine: startIndex + 1,
      endLine: endIndex + 1,
      tabularEnv: tabular.envName,
      tabularStartLine: tabular.startLine,
      tabularEndLine: tabular.endLine,
      source,
      sourceHash: hashText(source),
      rows,
      headingPath: headingPath.map((heading) => ({ ...heading }))
    });
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const commented = line.trimStart().startsWith("%");
    if (hasDocumentBoundary && !inDocument) {
      if (!commented && /\\begin\s*\{document\}/.test(line)) inDocument = true;
      continue;
    }
    if (hasDocumentBoundary && !commented && /\\end\s*\{document\}/.test(line)) break;
    if (bibliographyTail) continue;
    if (!commented && /^\s*\\bibitem\b/.test(line)) {
      bibliographyTail = true;
      continue;
    }

    const beginMatches = commented ? [] : [...line.matchAll(/\\begin\s*\{([^}]+)\}/g)].map((match) => match[1]);
    const endMatches = commented ? [] : [...line.matchAll(/\\end\s*\{([^}]+)\}/g)].map((match) => match[1]);

    if (excludedStack.length) {
      for (const name of beginMatches) {
        if (EXCLUDED_ENVIRONMENTS.has(name) && !TABLE_CONTAINER_ENVIRONMENTS.has(name)) excludedStack.push(name);
      }
      for (const name of endMatches) {
        const last = excludedStack.lastIndexOf(name);
        if (last >= 0) excludedStack.splice(last, 1);
      }
      continue;
    }

    const heading = commented ? null : extractHeading(line);
    if (heading) {
      headingPath = [
        ...headingPath.filter((item) => item.level < heading.level),
        { ...heading, id: `${file}:heading:${index + 1}`, line: index + 1 }
      ];
      continue;
    }

    const envName = beginMatches.find((name) => TABLE_CONTAINER_ENVIRONMENTS.has(name));
    if (envName) {
      const endIndex = findEnvironmentEnd(lines, index, envName, hasDocumentBoundary);
      const tabular = TABULAR_ENVIRONMENTS.has(envName)
        ? { envName, startLine: index + 1, endLine: endIndex + 1 }
        : findFirstTabular(lines, index, endIndex, hasDocumentBoundary);
      pushBlock(index, endIndex, envName, tabular);
      index = endIndex;
      continue;
    }

    const excluded = beginMatches.filter((name) => EXCLUDED_ENVIRONMENTS.has(name));
    if (excluded.length) {
      excludedStack.push(...excluded);
      for (const name of endMatches) {
        const last = excludedStack.lastIndexOf(name);
        if (last >= 0) excludedStack.splice(last, 1);
      }
    }
  }
  return blocks;
}

export function escapeLatexTableCell(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/&/g, "\\&")
    .replace(/%/g, "\\%")
    .replace(/#/g, "\\#")
    .replace(/_/g, "\\_");
}

export function replaceTableBlockRows(document, block, rows) {
  const nextRows = Array.isArray(rows) ? rows : [];
  const normalizedRows = nextRows.map((row) => Array.isArray(row?.cells) ? row.cells : row)
    .filter((row) => Array.isArray(row))
    .map((row) => row.map((cell) => String(cell ?? "")));
  const columnCount = Math.max(0, ...normalizedRows.map((row) => row.length));
  if (!normalizedRows.length || !columnCount) {
    const error = new Error("表格至少需要保留一行一列。");
    error.code = "TABLE_SHAPE_CHANGED";
    throw error;
  }
  const rectangularRows = normalizedRows.map((row) => (
    Array.from({ length: columnCount }, (_value, index) => row[index] ?? "")
  ));
  const nextLines = [...document.lines];
  const firstRow = block.rows[0];
  const lastRow = block.rows.at(-1);
  const bodyStart = Math.max(0, Number(block.tabularStartLine || firstRow.startLine) - 1);
  const bodyEnd = Math.min(nextLines.length, Number(block.tabularEndLine || lastRow.endLine) - 1);
  const firstRowStart = firstRow.startLine - 1;
  const lastRowEnd = lastRow.endLine;
  const prefix = nextLines.slice(bodyStart, firstRowStart);
  const suffix = nextLines.slice(lastRowEnd, bodyEnd);
  const separators = block.rows.slice(0, -1).map((row, index) => (
    nextLines.slice(row.endLine, block.rows[index + 1].startLine - 1)
      .filter((line) => tableStructuralLine(line))
  ));
  const indent = (nextLines[firstRowStart].match(/^\s*/) || [""])[0];
  const generatedRows = [];
  rectangularRows.forEach((row, index) => {
    generatedRows.push(`${indent}${row.map(escapeLatexTableCell).join(" & ")} \\\\`);
    if (index < rectangularRows.length - 1) {
      generatedRows.push(...(separators[index] || separators.at(-1) || []));
    }
  });
  nextLines.splice(bodyStart, bodyEnd - bodyStart, ...prefix, ...generatedRows, ...suffix);
  const beginIndex = Number(block.tabularStartLine || 0) - 1;
  if (beginIndex >= 0 && beginIndex < nextLines.length) {
    nextLines[beginIndex] = resizeTabularColumnSpec(nextLines[beginIndex], block.tabularEnv, columnCount);
  }
  return nextLines.join(document.eol);
}

function resizeTabularColumnSpec(line, envName, columnCount) {
  const balancedResult = resizeTabularColumnSpecBalanced(line, envName, columnCount);
  if (balancedResult !== null) return balancedResult;
  const pattern = new RegExp(`(\\\\begin\\s*\\{${escapeRegExp(envName || "tabular")}\\}[^\\n]*\\{)([^{}]*)(\\})`);
  const match = String(line || "").match(pattern);
  if (!match) return line;
  const spec = match[2];
  const units = [...spec.matchAll(/(?:[pmb]\s*\{[^{}]*\}|[lcrX])/g)];
  let nextSpec = spec;
  if (units.length < columnCount) {
    const trailingBars = nextSpec.match(/\|*$/)?.[0] || "";
    nextSpec = `${nextSpec.slice(0, nextSpec.length - trailingBars.length)}${"l".repeat(columnCount - units.length)}${trailingBars}`;
  } else if (units.length > columnCount) {
    const remove = units.slice(columnCount).reverse();
    for (const unit of remove) nextSpec = `${nextSpec.slice(0, unit.index)}${nextSpec.slice(unit.index + unit[0].length)}`;
  }
  return `${match[1]}${nextSpec}${match[3]}`;
}

function resizeTabularColumnSpecBalanced(line, envName, columnCount) {
  const source = String(line || "");
  const begin = source.match(new RegExp("\\\\begin\\s*\\{" + escapeRegExp(envName || "tabular") + "\\}"));
  if (!begin) return null;
  let cursor = begin.index + begin[0].length;
  while (/\s/.test(source[cursor] || "")) cursor += 1;
  if (source[cursor] === "[") {
    const optionEnd = findBalancedDelimiter(source, cursor, "[", "]");
    if (optionEnd < 0) return null;
    cursor = optionEnd + 1;
    while (/\s/.test(source[cursor] || "")) cursor += 1;
  }
  if (source[cursor] !== "{") return null;
  const specEnd = findBalancedDelimiter(source, cursor, "{", "}");
  if (specEnd < 0) return null;
  const spec = source.slice(cursor + 1, specEnd);
  const units = tableColumnUnits(spec);
  let nextSpec = spec;
  if (units.length < columnCount) {
    const trailing = spec.match(/(?:\|+|[@!<>]\{[^{}]*\})+$/);
    const insertionIndex = trailing ? trailing.index : spec.length;
    nextSpec = spec.slice(0, insertionIndex) + "l".repeat(columnCount - units.length) + spec.slice(insertionIndex);
  } else if (units.length > columnCount) {
    const remove = units.slice(columnCount).reverse();
    for (const unit of remove) nextSpec = nextSpec.slice(0, unit.index) + nextSpec.slice(unit.index + unit.length);
  }
  return source.slice(0, cursor + 1) + nextSpec + source.slice(specEnd);
}

function findBalancedDelimiter(source, start, opening, closing) {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === opening) depth += 1;
    else if (source[index] === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function tableColumnUnits(spec) {
  const units = [];
  for (let index = 0; index < spec.length; index += 1) {
    const character = spec[index];
    if (/[lcrX]/.test(character)) {
      units.push({ index, length: 1 });
      continue;
    }
    if (/[pmb]/.test(character)) {
      let cursor = index + 1;
      while (/\s/.test(spec[cursor] || "")) cursor += 1;
      if (spec[cursor] === "{") {
        const end = findBalancedDelimiter(spec, cursor, "{", "}");
        if (end >= 0) {
          units.push({ index, length: end - index + 1 });
          index = end;
        }
      }
      continue;
    }
    if (character === "\\") {
      index += 1;
      while (/[A-Za-z@]/.test(spec[index] || "")) index += 1;
      index -= 1;
      continue;
    }
    if (/[>@<!]/.test(character) && spec[index + 1] === "{") {
      const end = findBalancedDelimiter(spec, index + 1, "{", "}");
      if (end >= 0) index = end;
    }
  }
  return units;
}

export async function readDocument(projectRoot, relativeFile) {
  const root = path.resolve(projectRoot);
  const absolute = await resolveProjectFile(root, relativeFile);
  const content = await fs.readFile(absolute, "utf8");
  return {
    content,
    ...parseSegments(content, relativeFile),
    mathBlocks: parseMathBlocks(content, relativeFile),
    tableBlocks: parseTableBlocks(content, relativeFile)
  };
}

export async function replaceSegment(projectRoot, relativeFile, index, sourceHash, nextEnglish) {
  const root = path.resolve(projectRoot);
  await resolveProjectFile(root, relativeFile);
  const document = await readDocument(root, relativeFile);
  const segment = document.segments[index];
  if (!segment) throw new Error("The selected paragraph no longer exists.");
  if (sourceHash && sourceHash !== segment.sourceHash) {
    const error = new Error("The LaTeX source changed after this paragraph was loaded.");
    error.code = "SOURCE_CHANGED";
    throw error;
  }

  const replacement = nextEnglish.trim().split(/\r?\n/);
  const nextLines = [...document.lines];
  nextLines.splice(segment.startLine - 1, segment.endLine - segment.startLine + 1, ...replacement);
  await fs.writeFile(await resolveProjectFile(root, relativeFile), nextLines.join(document.eol), "utf8");
  return readDocument(root, relativeFile);
}

function getWritableSegment(document, index, sourceHash) {
  const segment = document.segments[Number(index)];
  if (!segment) throw new Error("The selected paragraph no longer exists.");
  if (sourceHash && sourceHash !== segment.sourceHash) {
    const error = new Error("The LaTeX source changed after this paragraph was loaded.");
    error.code = "SOURCE_CHANGED";
    throw error;
  }
  return segment;
}

export async function insertSegment(projectRoot, relativeFile, index, sourceHash, nextEnglish, position = "after") {
  const root = path.resolve(projectRoot);
  await resolveProjectFile(root, relativeFile);
  const document = await readDocument(root, relativeFile);
  const anchor = getWritableSegment(document, index, sourceHash);
  const prepared = String(nextEnglish || "").trim();
  const parsed = parseSegments(prepared, relativeFile);
  if (parsed.segments.length !== 1 || parsed.segments[0].english !== prepared) {
    const error = new Error("The generated English must contain exactly one editable LaTeX paragraph.");
    error.code = "INVALID_PARAGRAPH";
    throw error;
  }

  const normalizedPosition = position === "before" ? "before" : "after";
  const insertAt = normalizedPosition === "before" ? anchor.startLine - 1 : anchor.endLine;
  const nextLines = [...document.lines];
  nextLines.splice(insertAt, 0, "", ...prepared.split(/\r?\n/), "");
  await fs.writeFile(await resolveProjectFile(root, relativeFile), nextLines.join(document.eol), "utf8");

  const updated = await readDocument(root, relativeFile);
  const expectedStartLine = insertAt + 2;
  const inserted = updated.segments
    .filter((segment) => segment.sourceHash === parsed.segments[0].sourceHash)
    .sort((left, right) => Math.abs(left.startLine - expectedStartLine) - Math.abs(right.startLine - expectedStartLine))[0];
  if (!inserted) {
    const error = new Error("The new paragraph could not be located after it was written.");
    error.code = "INVALID_PARAGRAPH";
    throw error;
  }
  return { document: updated, segment: inserted };
}

export async function deleteSegment(projectRoot, relativeFile, index, sourceHash) {
  const root = path.resolve(projectRoot);
  await resolveProjectFile(root, relativeFile);
  const document = await readDocument(root, relativeFile);
  const segment = getWritableSegment(document, index, sourceHash);
  const nextLines = [...document.lines];
  nextLines.splice(segment.startLine - 1, segment.endLine - segment.startLine + 1);
  await fs.writeFile(await resolveProjectFile(root, relativeFile), nextLines.join(document.eol), "utf8");
  return { document: await readDocument(root, relativeFile), segment };
}

export async function commentSegment(projectRoot, relativeFile, index, sourceHash) {
  const root = path.resolve(projectRoot);
  await resolveProjectFile(root, relativeFile);
  const document = await readDocument(root, relativeFile);
  const segment = getWritableSegment(document, index, sourceHash);
  const nextLines = [...document.lines];
  const commented = nextLines
    .slice(segment.startLine - 1, segment.endLine)
    .map((line) => `% ${line}`);
  nextLines.splice(segment.startLine - 1, segment.endLine - segment.startLine + 1, ...commented);
  await fs.writeFile(await resolveProjectFile(root, relativeFile), nextLines.join(document.eol), "utf8");
  return { document: await readDocument(root, relativeFile), segment };
}

export async function commentSegmentSelection(projectRoot, relativeFile, index, sourceHash, selectionStart, selectionEnd) {
  const root = path.resolve(projectRoot);
  await resolveProjectFile(root, relativeFile);
  const document = await readDocument(root, relativeFile);
  const segment = getWritableSegment(document, index, sourceHash);
  const start = Number(selectionStart);
  const end = Number(selectionEnd);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > segment.english.length) {
    const error = new Error("Please select text inside the English LaTeX paragraph before commenting part of it.");
    error.code = "INVALID_SELECTION";
    throw error;
  }
  const sourceText = document.lines.slice(segment.startLine - 1, segment.endLine).join(document.eol).trimEnd();
  if (sourceText !== segment.english) {
    const error = new Error("The selected paragraph could not be mapped back to the TeX source.");
    error.code = "INVALID_SELECTION";
    throw error;
  }
  const selected = segment.english.slice(start, end);
  if (!selected.trim()) {
    const error = new Error("Please select non-empty English LaTeX text before commenting part of it.");
    error.code = "INVALID_SELECTION";
    throw error;
  }

  const replacement = [];
  const pushText = (value, side) => {
    const prepared = side === "before"
      ? value.replace(/[ \t\r\n]+$/g, "")
      : value.replace(/^[ \t\r\n]+/g, "");
    if (prepared) replacement.push(...prepared.split(/\r?\n/));
  };
  pushText(segment.english.slice(0, start), "before");
  replacement.push(...selected.split(/\r?\n/).map((line) => line ? `% ${line}` : "%"));
  pushText(segment.english.slice(end), "after");

  const nextLines = [...document.lines];
  nextLines.splice(segment.startLine - 1, segment.endLine - segment.startLine + 1, ...replacement);
  await fs.writeFile(await resolveProjectFile(root, relativeFile), nextLines.join(document.eol), "utf8");
  return { document: await readDocument(root, relativeFile), segment };
}

export function extractProtectedTokens(value) {
  const patterns = [
    /\$\$[\s\S]*?\$\$/g,
    /\$[^$\n]+\$/g,
    /\\\([\s\S]*?\\\)/g,
    /\\\[[\s\S]*?\\\]/g,
    /\\(?:cite\w*|ref|eqref|autoref|cref|Cref|pageref|label|url)\s*(?:\[[^\]]*\]\s*)*\{[^{}]*\}/g,
    /\\href\s*\{[^{}]*\}\s*\{[^{}]*\}/g,
    /\\item(?:\[[^\]]*\])?/g
  ];
  const tokens = [];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) tokens.push(match[0]);
  }
  return [...new Set(tokens)];
}

const SOFT_TEXT_COMMANDS = new Set([
  "emph",
  "textbf",
  "textit",
  "textmd",
  "textnormal",
  "textrm",
  "textsc",
  "textsf",
  "textsl",
  "texttt",
  "underline"
]);

export function isSoftLatexCommandSignature(command) {
  const name = String(command || "").match(/^\\([A-Za-z@]+)/)?.[1];
  return Boolean(name && SOFT_TEXT_COMMANDS.has(name));
}

export function isSoftProtectedToken(token) {
  const value = String(token || "");
  if (!/^\$[^$\n]+\$$/.test(value)) return false;
  const inner = value.slice(1, -1).trim();
  if (!/\d/.test(inner)) return false;
  const stripped = inner
    .replace(/\\[%#$&_{}]/g, "")
    .replace(/\\[,;:!\s]/g, "");
  if (/\\[A-Za-z@]+/.test(stripped)) return false;
  return /^[0-9\s.,:%+\-=<>()[\]{}^_*\/]*$/.test(stripped);
}

export function findMissingProtectedTokens(currentEnglish, chinese, nextEnglish, options = {}) {
  const englishTokens = extractProtectedTokens(currentEnglish)
    .filter((token) => !(options.allowSoftEnglishRemovals && isSoftProtectedToken(token)));
  const required = [...new Set([
    ...englishTokens,
    ...extractProtectedTokens(chinese || "")
  ])];
  return required.filter((token) => !nextEnglish.includes(token));
}

const DANGEROUS_LATEX_COMMANDS = new Set([
  "catcode",
  "csname",
  "directlua",
  "endlinechar",
  "everyeof",
  "everyjob",
  "IfFileExists",
  "immediate",
  "include",
  "input",
  "InputIfFileExists",
  "luaexec",
  "luadirect",
  "newread",
  "newwrite",
  "openin",
  "openout",
  "pdfextension",
  "pdfliteral",
  "pdfobj",
  "pdfxform",
  "read",
  "scantokens",
  "special",
  "write",
  "write18"
]);

const SIGNATURE_COMMANDS = new Set([
  "addbibresource",
  "bibliography",
  "bibliographystyle",
  "documentclass",
  "IfFileExists",
  "include",
  "input",
  "InputIfFileExists",
  "RequirePackage",
  "usepackage"
]);

export function extractLatexCommandSignatures(value) {
  const signatures = new Set();
  for (const match of String(value || "").matchAll(/\\([A-Za-z@]+)\*?/g)) {
    signatures.add(`\\${match[1]}`);
  }
  const signaturePattern = /\\(addbibresource|bibliography|bibliographystyle|documentclass|IfFileExists|include|input|InputIfFileExists|RequirePackage|usepackage)\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g;
  for (const match of String(value || "").matchAll(signaturePattern)) {
    if (!SIGNATURE_COMMANDS.has(match[1])) continue;
    signatures.add(`\\${match[1]}{${match[2].trim()}}`);
  }
  return [...signatures].sort();
}

export function analyzeLatexCommands(previousValues, candidate) {
  const references = Array.isArray(previousValues) ? previousValues : [previousValues];
  const allowed = new Set(references.flatMap(extractLatexCommandSignatures));
  const candidateCommands = extractLatexCommandSignatures(candidate);
  const unexpectedCommands = candidateCommands.filter((command) => !allowed.has(command));
  const dangerousCommands = unexpectedCommands.filter((command) => {
    const name = command.match(/^\\([A-Za-z@]+)/)?.[1];
    return name && DANGEROUS_LATEX_COMMANDS.has(name);
  });
  return { dangerousCommands, unexpectedCommands };
}

export function cleanModelText(value) {
  return String(value || "")
    .trim()
    .replace(/^```(?:latex|tex|text|json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}
