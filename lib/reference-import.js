const DOI_PATTERN = /10\.\d{4,9}\/[A-Z0-9._;()/:+-]+/i;
const ARXIV_ID_PATTERN = /(?:arxiv:\s*)?((?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{7})(?:v\d+)?)/i;
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
  let doi = decodeHtml(String(value || ""))
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .trim();
  doi = doi.replace(/^doi:\s*/i, "");
  const match = DOI_PATTERN.exec(doi);
  if (!match) return "";
  return match[0].replace(/[),.;]+$/, "").trim();
}

export function extractDoi(value) {
  return normalizeDoi(value);
}

export function extractArxivId(value) {
  return ARXIV_ID_PATTERN.exec(decodeHtml(String(value || "")))?.[1] || "";
}

export function normalizeReferenceUrl(value) {
  const input = String(value || "").trim();
  if (!input) throw new Error("请输入论文链接或 DOI。");
  const doi = normalizeDoi(input);
  if (doi) {
    return { input, doi, url: `https://doi.org/${doi}` };
  }
  if (!/^https?:\/\//i.test(input)) {
    const arxivId = extractArxivId(input);
    if (arxivId && /^(?:arxiv\s*:\s*)?(?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{7})(?:v\d+)?$/i.test(input)) {
      return { input, doi: "", url: `https://arxiv.org/abs/${arxivId}` };
    }
  }
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new Error("论文链接格式不正确，请粘贴 DOI、arXiv、IEEE 或普通网页链接。");
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
  const crossrefType = String(message.type || "misc");
  return {
    source: "crossref",
    type: crossrefType === "posted-content" ? "preprint" : crossrefType,
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
    abstract: String(message.abstract || ""),
    accessed: ""
  };
}

function htmlMeta(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]*content=["']([^"']*)["'][^>]*>`, "i");
  const reverse = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`, "i");
  return stripMarkup(pattern.exec(html)?.[1] || reverse.exec(html)?.[1] || "");
}

function htmlTitle(html) {
  return stripMarkup(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ""))?.[1] || "");
}

function cleanPageTitle(value) {
  return String(value || "")
    .replace(/\s*[|\-–—]\s*(?:IEEE\s+Xplore|IEEEXplore|ScienceDirect|ACM\s+Digital\s+Library|SpringerLink).*$/i, "")
    .trim();
}

function htmlCanonicalUrl(html) {
  const direct = /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i;
  const reverse = /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["'][^>]*>/i;
  return decodeHtml(direct.exec(html)?.[1] || reverse.exec(html)?.[1] || "").trim();
}

function authorFromName(value) {
  const name = stripMarkup(value);
  if (!name) return null;
  if (name.includes(",")) {
    const [family, ...given] = name.split(",");
    return { family: family.trim(), given: given.join(",").trim(), literal: "" };
  }
  const pieces = name.split(/\s+/).filter(Boolean);
  const family = pieces.pop() || "";
  return { family, given: pieces.join(" "), literal: "" };
}

function currentAccessDate() {
  return new Date().toISOString().slice(0, 10);
}

function doiFromHtml(html, { allowInline = false } = {}) {
  for (const field of ["citation_doi", "dc.identifier", "dc.identifier.doi", "prism.doi", "doi"]) {
    const doi = normalizeDoi(htmlMeta(html, field));
    if (doi) return doi;
  }
  return allowInline ? normalizeDoi(String(html || "")) : "";
}

function metadataFromHtml(html, url) {
  const authors = [...String(html || "").matchAll(/<meta[^>]+(?:name|property)=["']citation_author["'][^>]*content=["']([^"']*)["'][^>]*>/gi)]
    .map((match) => authorFromName(match[1]))
    .filter(Boolean);
  if (!authors.length) {
    const pageAuthor = authorFromName(htmlMeta(html, "author") || htmlMeta(html, "article:author"));
    if (pageAuthor) authors.push(pageAuthor);
  }
  const firstPage = htmlMeta(html, "citation_firstpage");
  const lastPage = htmlMeta(html, "citation_lastpage");
  const citationDoi = doiFromHtml(html, {
    allowInline: /(^|\.)ieeexplore\.ieee\.org$/i.test(url.hostname)
  });
  const arxivHost = /(^|\.)arxiv\.org$/i.test(url.hostname);
  const arxivId = extractArxivId(htmlMeta(html, "citation_arxiv_id"))
    || (arxivHost ? extractArxivId(url.pathname) : "");
  const journal = htmlMeta(html, "citation_journal_title");
  const booktitle = htmlMeta(html, "citation_conference_title");
  const citationTitle = htmlMeta(html, "citation_title");
  const publishedDate = htmlMeta(html, "citation_publication_date")
    || htmlMeta(html, "citation_date")
    || htmlMeta(html, "article:published_time")
    || htmlMeta(html, "date");
  const type = arxivId ? "preprint"
    : journal ? "journal-article"
      : booktitle ? "proceedings-article"
        : citationTitle ? "scholarly-article" : "webpage";
  return {
    source: "publisher-page",
    type,
    title: citationTitle || htmlMeta(html, "og:title") || htmlMeta(html, "twitter:title") || cleanPageTitle(htmlTitle(html)),
    authors,
    containerTitle: journal || booktitle,
    journal,
    booktitle,
    volume: htmlMeta(html, "citation_volume"),
    number: htmlMeta(html, "citation_issue"),
    pages: [firstPage, lastPage].filter(Boolean).join("--"),
    year: publishedDate.match(/\d{4}/)?.[0] || "",
    publisher: htmlMeta(html, "citation_publisher") || htmlMeta(html, "og:site_name") || url.hostname,
    doi: citationDoi,
    doiDiscovery: citationDoi ? "page" : "",
    url: htmlMeta(html, "citation_public_url") || htmlMeta(html, "og:url") || htmlCanonicalUrl(html) || url.toString(),
    abstract: htmlMeta(html, "description") || htmlMeta(html, "og:description"),
    eprint: arxivId.replace(/v\d+$/i, ""),
    archivePrefix: arxivId ? "arXiv" : "",
    primaryClass: htmlMeta(html, "citation_primary_category") || htmlMeta(html, "arxiv_primary_category"),
    accessed: currentAccessDate()
  };
}

function normalizedTitle(value) {
  return decodeHtml(stripMarkup(value))
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleSimilarity(left, right) {
  const a = normalizedTitle(left);
  const b = normalizedTitle(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const aTokens = new Set(a.split(/\s+/));
  const bTokens = new Set(b.split(/\s+/));
  const shared = [...aTokens].filter((token) => bTokens.has(token)).length;
  return (2 * shared) / (aTokens.size + bTokens.size);
}

function likelyScholarlyPage(metadata, url, html) {
  return /(^|\.)ieeexplore\.ieee\.org$/i.test(url.hostname)
    || metadata.type !== "webpage"
    || /(?:name|property)=["']citation_(?:title|author|journal_title|conference_title)["']/i.test(html);
}

async function crossrefByDoi(request, doi) {
  const response = await request(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
    headers: { Accept: "application/json", "User-Agent": "PaperBridge/0.4.2" }
  });
  if (!response?.ok) throw new Error(`文献元数据服务返回 HTTP ${response?.status || "错误"}。`);
  const payload = await response.json();
  return metadataFromCrossref(payload.message || {});
}

async function crossrefByTitle(request, title) {
  const query = new URL("https://api.crossref.org/works");
  query.searchParams.set("query.title", title);
  query.searchParams.set("rows", "5");
  const response = await request(query.toString(), {
    headers: { Accept: "application/json", "User-Agent": "PaperBridge/0.4.2" }
  });
  if (!response?.ok) return null;
  const payload = await response.json();
  const candidates = Array.isArray(payload.message?.items) ? payload.message.items : [];
  const ranked = candidates
    .map((item) => ({ item, similarity: titleSimilarity(title, firstValue(item.title)) }))
    .sort((left, right) => right.similarity - left.similarity);
  if (!ranked[0] || ranked[0].similarity < 0.86) return null;
  return { metadata: metadataFromCrossref(ranked[0].item), similarity: ranked[0].similarity };
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
      return await crossrefByDoi(request, normalized.doi);
    } catch (error) {
      if (/超时/.test(error.message)) throw error;
      throw new Error(`无法通过 DOI 获取文献元数据：${error.message}`);
    }
  }

  const pageUrl = new URL(normalized.url);
  const arxivHost = /(^|\.)arxiv\.org$/i.test(pageUrl.hostname);
  const arxivId = arxivHost ? extractArxivId(pageUrl.pathname) : "";
  const fetchUrl = arxivHost && /^\/pdf\//i.test(pageUrl.pathname) && arxivId
    ? `https://arxiv.org/abs/${arxivId}`
    : normalized.url;
  const response = await request(fetchUrl, { headers: { Accept: "text/html,application/xhtml+xml" } });
  if (!response?.ok) throw new Error(`论文网页返回 HTTP ${response?.status || "错误"}。`);
  const html = await response.text();
  let metadata = metadataFromHtml(html, pageUrl);
  if (metadata.doi && metadata.type !== "preprint") {
    try {
      metadata = {
        ...await crossrefByDoi(request, metadata.doi),
        url: metadata.url || pageUrl.toString(),
        doiDiscovery: metadata.doiDiscovery || "page",
        source: "publisher-page+crossref"
      };
    } catch {
      // The page metadata is still useful when Crossref is temporarily unavailable.
    }
  } else if (metadata.type !== "preprint" && metadata.title && likelyScholarlyPage(metadata, pageUrl, html)) {
    try {
      const resolved = await crossrefByTitle(request, metadata.title);
      if (resolved?.metadata?.doi) {
        metadata = {
          ...resolved.metadata,
          url: metadata.url || pageUrl.toString(),
          source: "publisher-page+crossref-title",
          doiDiscovery: "title-match",
          doiMatchConfidence: resolved.similarity
        };
      }
    } catch {
      // A page without a resolvable DOI can still be cited as a webpage or unpublished item.
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
  add("publisher", metadata.type === "preprint" ? "" : metadata.publisher);
  add("doi", metadata.doi);
  if (metadata.type === "preprint") {
    add("eprint", metadata.eprint);
    add("archivePrefix", metadata.archivePrefix);
    add("primaryClass", metadata.primaryClass);
    add("url", metadata.url);
  } else if (metadata.type === "webpage" || metadata.type === "scholarly-article" || !metadata.doi) {
    add("url", metadata.url);
    if (metadata.type === "webpage") add("note", metadata.accessed ? `Accessed: ${metadata.accessed}` : "");
  }
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
