import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  lookupReferenceUrl,
  metadataToBibEntry,
  normalizeReferenceUrl,
  parseBibEntryText,
  suggestCitationKey
} from "../lib/reference-import.js";
import { startServer, stopServer } from "../server.js";

test("reference import resolves DOI metadata and creates the requested citation key shape", async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /api\.crossref\.org\/works\/10\.1000%2Fxyz/);
    return new Response(JSON.stringify({
      message: {
        type: "journal-article",
        title: ["A survey on technologies, standards and open challenges in satellite IoT"],
        author: [
          { family: "Centenaro", given: "Marco" },
          { family: "Costa", given: "Cristina E" }
        ],
        "container-title": ["IEEE Communications Surveys & Tutorials"],
        volume: "23",
        issue: "3",
        page: "1693-1720",
        issued: { "date-parts": [[2021]] },
        publisher: "IEEE",
        DOI: "10.1000/xyz"
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const metadata = await lookupReferenceUrl("https://doi.org/10.1000/xyz", { fetchImpl });
  const key = suggestCitationKey(metadata, []);
  assert.equal(key, "centenaro2021survey");
  const entry = metadataToBibEntry(metadata, key);
  assert.match(entry.raw, /@article\{centenaro2021survey,/);
  assert.match(entry.raw, /pages=\{1693--1720\}/);
  assert.match(entry.raw, /journal=\{IEEE Communications Surveys \\& Tutorials\}/);
  assert.deepEqual(parseBibEntryText(entry.raw).key, key);
});

test("reference import falls back to citation meta tags for publisher pages", async () => {
  const html = [
    '<html><head>',
    '<meta name="citation_title" content="Fast Satellite Networks">',
    '<meta name="citation_author" content="Doe, Jane">',
    '<meta name="citation_journal_title" content="Journal of Networks">',
    '<meta name="citation_publication_date" content="2024-05-01">',
    '<meta name="citation_doi" content="10.1234/fast">',
    '</head></html>'
  ].join("");
  const fetchImpl = async (url) => {
    assert.equal(url, "https://publisher.example/paper");
    return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  };
  const metadata = await lookupReferenceUrl("https://publisher.example/paper", { fetchImpl });
  assert.equal(metadata.title, "Fast Satellite Networks");
  assert.equal(metadata.doi, "10.1234/fast");
  assert.equal(metadata.year, "2024");
  assert.notEqual(suggestCitationKey(metadata, ["doe2024fast"]), "doe2024fast");
});

test("arXiv pages become preprint misc entries instead of journal articles", async () => {
  assert.equal(normalizeReferenceUrl("arXiv:2401.12345v2").url, "https://arxiv.org/abs/2401.12345v2");
  const html = [
    "<html><head>",
    '<meta name="citation_title" content="Learning Reliable Satellite Links">',
    '<meta name="citation_author" content="Doe, Jane">',
    '<meta name="citation_arxiv_id" content="2401.12345">',
    '<meta name="citation_date" content="2024-01-20">',
    '<meta name="arxiv_primary_category" content="cs.NI">',
    "</head></html>"
  ].join("");
  const metadata = await lookupReferenceUrl("https://arxiv.org/abs/2401.12345", {
    fetchImpl: async (url) => {
      assert.equal(url, "https://arxiv.org/abs/2401.12345");
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }
  });
  const entry = metadataToBibEntry(metadata, "doe2024learning");
  assert.equal(metadata.type, "preprint");
  assert.match(entry.raw, /@misc\{doe2024learning,/);
  assert.match(entry.raw, /eprint=\{2401\.12345\}/);
  assert.match(entry.raw, /archivePrefix=\{arXiv\}/);
  assert.match(entry.raw, /primaryClass=\{cs\.NI\}/);
  assert.doesNotMatch(entry.raw, /journal=\{/);
});

test("ordinary pages become URL misc entries with an access date", async () => {
  const html = [
    "<html><head><title>Project Documentation</title>",
    '<meta property="og:site_name" content="Example Lab">',
    '<meta name="author" content="Example Lab">',
    "</head></html>"
  ].join("");
  const metadata = await lookupReferenceUrl("https://example.org/docs/project", {
    fetchImpl: async (url) => {
      assert.equal(url, "https://example.org/docs/project");
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }
  });
  const entry = metadataToBibEntry(metadata, "example2026project");
  assert.equal(metadata.type, "webpage");
  assert.match(entry.raw, /@misc\{example2026project,/);
  assert.match(entry.raw, /url=\{https:\/\/example\.org\/docs\/project\}/);
  assert.match(entry.raw, /note=\{Accessed: \d{4}-\d{2}-\d{2}\}/);
});

test("IEEE pages can resolve a missing DOI through a high-confidence Crossref title match", async () => {
  const pageUrl = "https://ieeexplore.ieee.org/document/1234567";
  const html = [
    "<html><head>",
    '<meta name="citation_title" content="Reliable Satellite IoT Routing">',
    '<meta name="citation_author" content="Doe, Jane">',
    '<meta name="citation_conference_title" content="IEEE INFOCOM">',
    '<meta name="citation_publication_date" content="2025-05-01">',
    "</head></html>"
  ].join("");
  const metadata = await lookupReferenceUrl(pageUrl, {
    fetchImpl: async (url) => {
      if (url === pageUrl) return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
      assert.match(url, /api\.crossref\.org\/works\?query\.title=Reliable\+Satellite\+IoT\+Routing/);
      return new Response(JSON.stringify({
        message: {
          items: [{
            type: "proceedings-article",
            title: ["Reliable Satellite IoT Routing"],
            author: [{ family: "Doe", given: "Jane" }],
            "container-title": ["IEEE INFOCOM"],
            issued: { "date-parts": [[2025]] },
            DOI: "10.1109/INFOCOM12345.2025.1234567"
          }]
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });
  const entry = metadataToBibEntry(metadata, "doe2025reliable");
  assert.equal(metadata.doi, "10.1109/INFOCOM12345.2025.1234567");
  assert.equal(metadata.doiDiscovery, "title-match");
  assert.match(entry.raw, /@inproceedings\{doe2025reliable,/);
  assert.match(entry.raw, /doi=\{10\.1109\/INFOCOM12345\.2025\.1234567\}/);
});

test("reference API appends an entry to Bib and wires an unreferenced Bib file into main TeX", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-reference-add-"));
  const projectRoot = path.join(root, "project");
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(path.join(projectRoot, "main.tex"), "\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n", "utf8");
    await fs.writeFile(path.join(projectRoot, "references.bib"), "", "utf8");
    const server = await startServer({ port: 0, dataRoot: path.join(root, "data"), projectsRoot: path.join(root, "projects") });
    const request = async (url, options = {}) => {
      const response = await fetch(`${server.url}${url}`, { headers: { "Content-Type": "application/json" }, ...options });
      const payload = await response.json();
      assert.equal(response.ok, true, payload.error);
      return payload;
    };
    const provider = { type: "openai-compatible", baseUrl: "http://127.0.0.1:1", apiKey: "test", model: "test", jsonMode: true };
    await request("/api/setup", { method: "POST", body: JSON.stringify({ source: { mode: "local", localPath: projectRoot }, translation: provider, format: provider }) });
    const raw = "@article{centenaro2021survey,\n  title={A survey on satellite IoT},\n  author={Centenaro, Marco},\n  journal={IEEE Communications Surveys \\& Tutorials},\n  year={2021}\n}";
    const result = await request("/api/references/add", { method: "POST", body: JSON.stringify({ bibFile: "references.bib", raw, key: "centenaro2021survey" }) });
    assert.equal(result.entry.key, "centenaro2021survey");
    assert.match(await fs.readFile(path.join(projectRoot, "references.bib"), "utf8"), /@article\{centenaro2021survey/);
    assert.match(await fs.readFile(path.join(projectRoot, "main.tex"), "utf8"), /\\bibliography\{references\}/);
  } finally {
    await stopServer();
    await fs.rm(root, { recursive: true, force: true });
  }
});
