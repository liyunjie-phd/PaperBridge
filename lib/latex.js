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

const STRUCTURAL_COMMAND = /^\s*\\(?:acmBooktitle|acmConference|acmDOI|acmISBN|acmYear|addtolength|affiliation|author|authornote|authornotemark|balance|bibliography|bibliographystyle|caption|ccsdesc|centering|copyrightyear|date|documentclass|email|end|geometry|hypersetup|IEEEauthorblockA|IEEEauthorblockN|include|includegraphics|input|keywords|label|maketitle|newtheorem|orcid|pagestyle|PassOptionsToPackage|printbibliography|received|RequirePackage|section|setcopyright|setcounter|setlength|settopmatter|subsection|subsubsection|title|usepackage|vspace)\b/;
const EXCLUDED_COMMAND_BLOCK = /^\s*\\(?:address|affiliation|author|authornote|authornotemark|city|corref|cortext|country|date|def|Declare\w*|department|ead|edef|email|fnref|fntext|gdef|institute|institution|newcommand|newenvironment|postalcode|providecommand|renewcommand|renewenvironment|streetaddress|thanks|title|xdef)\b/;

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
      await visit(child);
    }
  }

  await visit(mainTex);
  return ordered;
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
        wordCount
      });
    }
    buffer.length = 0;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const commented = line.trimStart().startsWith("%");
    if (hasDocumentBoundary && !inDocument) {
      if (!commented && /\\begin\s*\{document\}/.test(line)) inDocument = true;
      continue;
    }
    if (hasDocumentBoundary && !commented && /\\end\s*\{document\}/.test(line)) {
      flush(i);
      inDocument = false;
      continue;
    }
    if (bibliographyTail) continue;
    if (/^\s*\\bibitem\b/.test(line)) {
      flush(i);
      bibliographyTail = true;
      continue;
    }
    if (excludedCommandDepth > 0) {
      excludedCommandDepth += braceDelta(line);
      if (excludedCommandDepth <= 0) excludedCommandDepth = 0;
      continue;
    }
    if (EXCLUDED_COMMAND_BLOCK.test(line)) {
      flush(i);
      excludedCommandDepth = Math.max(0, braceDelta(line));
      continue;
    }
    if (displayMathDelimiter) {
      if (line.includes(displayMathDelimiter)) displayMathDelimiter = "";
      continue;
    }
    if (line.includes("\\[")) {
      flush(i);
      if (!line.includes("\\]")) displayMathDelimiter = "\\]";
      continue;
    }
    const displayDollarCount = (line.match(/\$\$/g) || []).length;
    if (displayDollarCount) {
      flush(i);
      if (displayDollarCount % 2 === 1) displayMathDelimiter = "$$";
      continue;
    }
    const beginMatches = [...line.matchAll(/\\begin\s*\{([^}]+)\}/g)].map((match) => match[1]);
    const endMatches = [...line.matchAll(/\\end\s*\{([^}]+)\}/g)].map((match) => match[1]);
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

    if (isStructuralLine(line)) {
      flush(i);
      continue;
    }

    if (!buffer.length) bufferStart = i;
    buffer.push(line);
  }

  flush(lines.length);
  return { eol, lines, segments };
}

export async function readDocument(projectRoot, relativeFile) {
  const root = path.resolve(projectRoot);
  const absolute = await resolveProjectFile(root, relativeFile);
  const content = await fs.readFile(absolute, "utf8");
  return { content, ...parseSegments(content, relativeFile) };
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

export function findMissingProtectedTokens(currentEnglish, chinese, nextEnglish) {
  const required = [...new Set([
    ...extractProtectedTokens(currentEnglish),
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
