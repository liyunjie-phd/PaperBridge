const DOI_PATTERN = /10\.\d{4,9}\/[\S]+/i;
const KEY_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "based", "by", "for", "from", "in", "into",
  "of", "on", "or", "the", "to", "toward", "towards", "via", "with", "using"
]);
const KEY_GENERIC_WORDS = new Set(["study", "analysis", "approach", "method", "system", "model", "framework"]);

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, number) => String.fromCodePoint(Number(number)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripMarkup(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function normalizeDoi(value) {
  let doi = String(value || "").trim();
  doi = doi.replace(/^doi:\s*/i, "");
  const match = DOI_PATTERN.exec(doi);
  if (!match) return "";
  return match[0].replace(/[),.;]+$/, "").trim();
}

export function extractDoi(value) {
  return normalizeDoi(value);
}

export function normalizeReferenceUrl(value) {
  const input = String(value || "").trim();
  if (!input) throw new Error("请输入论文链接或 DOI。");
  const doi = normalizeDoi(input);
  if (doi) {
    return { input, doi, url: `https://doi.org/${doi}` };
  }
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new Error("论文链接格式不正确，请粘贴 DOI、doi.org 链接或论文网页链接。");
  }
  return { input, doi, url: url.toString() };
}

function firstValue(value) {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

function metadataFromCrossref(message) {
  const authors = Array.isArray(message.author) ? message.author.map((author) => ({
    family: String(author.family || "").trim(),
    given: String(author.given || "").trim(),
    literal: String(author.name || "").trim()
  })).filter((author) => author.family || author.given || author.literal) : [];
  const dateParts = message.issued?.["date-parts"]?.[0] || message.published?.["date-parts"]?.[0] || [];
  const year = dateParts[0] ? String(dateParts[0]) : "";
  const container = firstValue(message["container-title"]);
  return {
    source: "crossref",
    type: String(message.type || "misc"),
    title: firstValue(message.title),
    authors,
    containerTitle: container,
    journal: message.type === "journal-article" ? container : "",
    booktitle: message.type === "proceedings-article" ? container : "",
    volume: String(message.volume || ""),
    number: String(message.issue || ""),
    pages: String(message.page || ""),
    year,
    publisher: String(message.publisher || ""),
    doi: normalizeDoi(message.DOI || message.doi),
    url: String(message.URL || ""),
    abstract: String(message.abstract || "")
  };
}

function htmlMeta(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]*content=["']([^"']*)["'][^>]*>`, "i");
  const reverse = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`, "i");
  return stripMarkup(pattern.exec(html)?.[1] || reverse.exec(html)?.[1] || "");
}

function metadataFromHtml(html, url) {
  const authors = [...String(html || "").matchAll(/<meta[^>]+(?:name|property)=["']citation_author["'][^>]*content=["']([^"']*)["'][^>]*>/gi)]
    .map((match) => {
      const value = stripMarkup(match[1]);
      if (value.includes(",")) {
        const [family, ...given] = value.split(",");
        return { family: family.trim(), given: given.join(",").trim(), literal: "" };
      }
      const pieces = value.split(/\s+/).filter(Boolean);
      const family = pieces.pop() || "";
      return { family, given: pieces.join(" "), literal: "" };
    });
  const firstPage = htmlMeta(html, "citation_firstpage");
  const lastPage = htmlMeta(html, "citation_lastpage");
  const citationDoi = normalizeDoi(htmlMeta(html, "citation_doi"));
  return {
    source: "publisher-page",
    type: "journal-article",
    title: htmlMeta(html, "citation_title") || htmlMeta(html, "og:title") || "",
    authors,
    containerTitle: htmlMeta(html, "citation_journal_title") || htmlMeta(html, "citation_conference_title"),
    journal: htmlMeta(html, "citation_journal_title"),
    booktitle: htmlMeta(html, "citation_conference_title"),
    volume: htmlMeta(html, "citation_volume"),
    number: htmlMeta(html, "citation_issue"),
    pages: [firstPage, lastPage].filter(Boolean).join("--"),
    year: (htmlMeta(html, "citation_publication_date") || "").match(/\d{4}/)?.[0] || "",
    publisher: htmlMeta(html, "citation_publisher"),
    doi: citationDoi,
    url: url.toString(),
    abstract: htmlMeta(html, "description")
  };
}

async function fetchJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, options);
  if (!response?.ok) throw new Error(`文献元数据服务返回 HTTP ${response?.status || "错误"}。`);
  return response.json();
}

export async function lookupReferenceUrl(value, { fetchImpl = globalThis.fetch, timeoutMs = 12000 } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("当前运行环境不支持网络文献识别。");
  const normalized = normalizeReferenceUrl(value);
  const request = async (url, options = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error.name === "AbortError") throw new Error("文献元数据请求超时，请检查网络或直接粘贴 DOI。");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  if (normalized.doi) {
    try {
      const response = await request(`https://api.crossref.org/works/${encodeURIComponent(normalized.doi)}`, {
        headers: { Accept: "application/json", "User-Agent": "PaperBridge/0.4.2" }
      });
      if (!response?.ok) throw new Error(`文献元数据服务返回 HTTP ${response?.status || "错误"}。`);
      const payload = await response.json();
      return metadataFromCrossref(payload.message || {});
    } catch (error) {
      if (/超时/.test(error.message)) throw error;
      throw new Error(`无法通过 DOI 获取文献元数据：${error.message}`);
    }
  }

  const response = await request(normalized.url, { headers: { Accept: "text/html,application/xhtml+xml" } });
  if (!response?.ok) throw new Error(`论文网页返回 HTTP ${response?.status || "错误"}。`);
  const html = await response.text();
  let metadata = metadataFromHtml(html, new URL(normalized.url));
  if (metadata.doi) {
    try {
      const crossrefResponse = await request(`https://api.crossref.org/works/${encodeURIComponent(metadata.doi)}`, {
        headers: { Accept: "application/json", "User-Agent": "PaperBridge/0.4.2" }
      });
      if (!crossrefResponse?.ok) throw new Error(`文献元数据服务返回 HTTP ${crossrefResponse?.status || "错误"}。`);
      const payload = await crossrefResponse.json();
      metadata = { ...metadataFromCrossref(payload.message || {}), source: "publisher-page+crossref" };
    } catch {
      // The page metadata is still useful when Crossref is temporarily unavailable.
    }
  }
  if (!metadata.title && !metadata.doi) throw new Error("没有在论文网页中找到可用的标题或 DOI。请改用 DOI 链接。");
  return metadata;
}

function ascii(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim();
}

function authorSurname(metadata) {
  const author = metadata.authors?.[0] || {};
  return ascii(author.family || author.literal || author.given).split(/\s+/)[0].toLowerCase() || "reference";
}

function titleKeywords(title) {
  return ascii(String(title || "").replace(/\\[A-Za-z]+\s*/g, " "))
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !KEY_STOP_WORDS.has(word) && !KEY_GENERIC_WORDS.has(word));
}

export function suggestCitationKey(metadata, existingKeys = []) {
  const year = String(metadata.year || "").match(/\d{4}/)?.[0] || "nd";
  const keywords = titleKeywords(metadata.title);
  const prefix = `${authorSurname(metadata)}${year}`;
  const base = `${prefix}${keywords[0] || "paper"}`;
  const used = new Set(existingKeys.map((key) => String(key).toLowerCase()));
  if (!used.has(base)) return base;
  for (const keyword of keywords.slice(1)) {
    const candidate = `${prefix}${keyword}`;
    if (!used.has(candidate)) return candidate;
  }
  let suffix = 2;
  while (used.has(`${base}${suffix}`)) suffix += 1;
  return `${base}${suffix}`;
}

function escapeBibValue(value) {
  return String(value || "")
    .replace(/\\&/g, "&")
    .replace(/(^|[^\\])&/g, "$1\\&")
    .replace(/(^|[^\\])%/g, "$1\\%")
    .replace(/(^|[^\\])#/g, "$1\\#")
    .replace(/(^|[^\\])_/g, "$1\\_")
    .replace(/\s+/g, " ")
    .trim();
}

function bibAuthors(authors = []) {
  return authors.map((author) => {
    if (author.literal) return author.literal;
    if (author.family && author.given) return `${author.family}, ${author.given}`;
    return author.family || author.given;
  }).filter(Boolean).join(" and ");
}

export function metadataToBibEntry(metadata, key) {
  const type = metadata.type === "journal-article" ? "article"
    : metadata.type === "proceedings-article" ? "inproceedings"
      : metadata.type === "book-chapter" ? "incollection"
        : metadata.type === "book" ? "book" : "misc";
  const fields = [];
  const add = (name, value) => {
    if (String(value || "").trim()) fields.push([name, escapeBibValue(value)]);
  };
  add("title", metadata.title);
  add("author", bibAuthors(metadata.authors));
  if (type === "article") add("journal", metadata.journal || metadata.containerTitle);
  else if (type === "inproceedings" || type === "incollection") add("booktitle", metadata.booktitle || metadata.containerTitle);
  add("volume", metadata.volume);
  add("number", metadata.number);
  add("pages", String(metadata.pages || "").replace(/(?<!-)\s*-\s*(?!-)/g, "--"));
  add("year", metadata.year);
  add("publisher", metadata.publisher);
  add("doi", metadata.doi);
  if (!metadata.doi) add("url", metadata.url);
  const formattedFields = fields.map(([name, value]) => `  ${name}={${value}}`);
  const raw = [
    `@${type}{${key},`,
    ...formattedFields.map((line, index) => `${line}${index < formattedFields.length - 1 ? "," : ""}`),
    "}"
  ].join("\n");
  return { type, key, fields: Object.fromEntries(fields), raw };
}

function readBalancedEntry(text) {
  const start = String(text || "").search(/@[A-Za-z]+\s*[({]/);
  if (start < 0) throw new Error("BibTeX 内容中没有找到文献条目。");
  let openIndex = start;
  while (!/[({]/.test(text[openIndex])) openIndex += 1;
  const open = text[openIndex];
  const close = open === "{" ? "}" : ")";
  let depth = 1;
  let index = openIndex + 1;
  while (index < text.length && depth) {
    if (text[index] === open && text[index - 1] !== "\\") depth += 1;
    else if (text[index] === close && text[index - 1] !== "\\") depth -= 1;
    index += 1;
  }
  if (depth) throw new Error("BibTeX 条目的括号没有闭合。");
  if (String(text).slice(index).trim()) throw new Error("一次只能写入一个 BibTeX 条目。");
  return text.slice(start, index);
}

export function parseBibEntryText(text) {
  const raw = readBalancedEntry(String(text || "").trim());
  const header = /^@([A-Za-z]+)\s*[({]\s*([^,\s]+)\s*,/s.exec(raw);
  if (!header) throw new Error("BibTeX 条目缺少引用名。");
  const key = header[2].trim();
  if (!/^[A-Za-z0-9_:.+/-]+$/.test(key)) throw new Error("citation key 只能包含字母、数字、下划线、点、冒号、加号或短横线。");
  const body = raw.slice(header[0].length, -1);
  const fields = {};
  for (const match of body.matchAll(/(?:^|,)\s*([A-Za-z][A-Za-z0-9_-]*)\s*=\s*(\{(?:[^{}]|\{[^{}]*\})*\}|"(?:[^"\\]|\\.)*"|[^,]+?)(?=,\s*[A-Za-z][A-Za-z0-9_-]*\s*=|$)/gs)) {
    fields[match[1].toLowerCase()] = String(match[2]).trim().replace(/^(\{|"|)([\s\S]*?)(\}|"|)$/s, "$2").trim();
  }
  if (!fields.title && !fields.author) throw new Error("BibTeX 条目至少需要 title 或 author。");
  return { type: header[1].toLowerCase(), key, fields, raw };
}

export function serializeBibEntry(entry) {
  const fields = Object.entries(entry.fields || {}).filter(([, value]) => String(value || "").trim());
  const formattedFields = fields.map(([name, value]) => `  ${name}={${value}}`);
  return [
    `@${entry.type || "misc"}{${entry.key},`,
    ...formattedFields.map((line, index) => `${line}${index < formattedFields.length - 1 ? "," : ""}`),
    "}"
  ].join("\n");
}
