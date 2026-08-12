import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer, stopServer } from "../server.js";

test("section translation reports progress without sending other sections", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-translation-progress-"));
  const projectRoot = path.join(root, "project");
  const batchSizes = [];
  let providerServer;
  try {
    await fs.mkdir(projectRoot);
    const introduction = Array.from({ length: 9 }, (_, index) => (
      `Paragraph ${index + 1} contains enough academic words to be detected as editable manuscript prose for translation testing.${index === 0 ? " \\cite{demo}" : ""}`
    ));
    const method = Array.from({ length: 3 }, (_, index) => (
      `Method paragraph ${index + 1} contains enough academic words and must remain outside the introduction translation request.`
    ));
    await fs.writeFile(
      path.join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{Introduction}",
        ...introduction.flatMap((paragraph) => [paragraph, ""]),
        "\\section{Method}",
        ...method.flatMap((paragraph) => [paragraph, ""]),
        "\\end{document}"
      ].join("\n"),
      "utf8"
    );

    providerServer = http.createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      const user = payload.messages.find((message) => message.role === "user").content;
      const input = JSON.parse(user.slice(user.lastIndexOf("\n") + 1));
      batchSizes.push(input.length);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              translations: input.map((item, index) => ({ id: item.id, chinese: `这是第 ${index + 1} 个测试翻译段落。` }))
            })
          }
        }]
      }));
    });
    await new Promise((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
    const providerPort = providerServer.address().port;
    const server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data"),
      projectsRoot: path.join(root, "projects")
    });
    const request = async (url, body) => {
      const response = await fetch(`${server.url}${url}`, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
      const payload = await response.json();
      assert.equal(response.ok, true, payload.error);
      return payload;
    };
    const provider = {
      type: "openai-compatible",
      baseUrl: `http://127.0.0.1:${providerPort}`,
      apiKey: "test-key",
      model: "test-model",
      jsonMode: true
    };

    const project = await request("/api/setup", {
      source: { mode: "local", localPath: projectRoot },
      translation: provider,
      review: provider,
      autoCompile: false,
      pageLimit: 12
    });
    assert.equal("pageLimit" in project.config, false);

    let document = await request("/api/document?file=main.tex");
    assert.equal(document.segments.length, 12);
    const introductionSegments = document.segments.filter((segment) => segment.sectionTitle === "Introduction");
    const methodSegments = document.segments.filter((segment) => segment.sectionTitle === "Method");
    let result = await request("/api/file/translate-to-chinese", {
      file: "main.tex",
      sectionId: introductionSegments[0].sectionId,
      segmentIds: [introductionSegments[0].id]
    });
    assert.deepEqual(result.progress, { attempted: 1, translated: 1, skipped: 0 });
    assert.doesNotMatch(result.document.segments[0].chinese, /\\cite/);
    assert.equal(result.document.segments.filter((segment) => segment.chinese).length, 1);
    assert.equal(result.document.segments.filter((segment) => segment.sectionTitle === "Method" && segment.chinese).length, 0);

    document = result.document;
    result = await request("/api/file/translate-to-chinese", {
      file: "main.tex",
      sectionId: introductionSegments[0].sectionId,
      segmentIds: introductionSegments.slice(1).map((segment) => segment.id)
    });
    assert.deepEqual(result.progress, { attempted: 8, translated: 8, skipped: 0 });
    assert.equal(result.document.segments.filter((segment) => segment.chinese).length, 9);
    assert.equal(result.document.segments.filter((segment) => segment.sectionTitle === "Method" && segment.chinese).length, 0);

    result = await request("/api/file/translate-to-chinese", {
      file: "main.tex",
      sectionId: methodSegments[0].sectionId,
      segmentIds: methodSegments.map((segment) => segment.id)
    });
    assert.deepEqual(result.progress, { attempted: 3, translated: 3, skipped: 0 });
    assert.equal(result.document.segments.filter((segment) => segment.chinese).length, 12);
    assert.deepEqual(batchSizes, [1, 8, 3]);
  } finally {
    await stopServer();
    if (providerServer) await new Promise((resolve) => providerServer.close(resolve));
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Chinese generation can be forced for already translated paragraphs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-force-chinese-"));
  const projectRoot = path.join(root, "project");
  let providerServer;
  let providerCalls = 0;
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(
      path.join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{Introduction}",
        "This paragraph contains enough academic words to be translated, regenerated, and checked by PaperBridge.",
        "\\section{Method}",
        "This method paragraph contains enough academic words to confirm file-wide translation across sections.",
        "\\end{document}"
      ].join("\n"),
      "utf8"
    );
    providerServer = http.createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      const user = payload.messages.find((message) => message.role === "user").content;
      const input = JSON.parse(user.slice(user.lastIndexOf("\n") + 1));
      providerCalls += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              translations: input.map((item) => ({ id: item.id, chinese: `forced translation ${providerCalls}` }))
            })
          }
        }]
      }));
    });
    await new Promise((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
    const providerPort = providerServer.address().port;
    const server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data"),
      projectsRoot: path.join(root, "projects")
    });
    const request = async (url, body) => {
      const response = await fetch(`${server.url}${url}`, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
      const payload = await response.json();
      assert.equal(response.ok, true, payload.error);
      return payload;
    };
    const provider = {
      type: "openai-compatible",
      baseUrl: `http://127.0.0.1:${providerPort}`,
      apiKey: "test-key",
      model: "test-model",
      jsonMode: true
    };
    await request("/api/setup", {
      source: { mode: "local", localPath: projectRoot },
      translation: provider,
      review: provider,
      autoCompile: false
    });
    let document = await request("/api/document?file=main.tex");
    const segmentIds = document.segments.map((segment) => segment.id);
    assert.equal(segmentIds.length, 2);
    let result = await request("/api/file/translate-to-chinese", {
      file: "main.tex",
      segmentIds,
      force: true
    });
    assert.deepEqual(result.document.segments.map((segment) => segment.chinese), [
      "forced translation 1",
      "forced translation 1"
    ]);
    result = await request("/api/file/translate-to-chinese", {
      file: "main.tex",
      segmentIds,
      force: true
    });
    assert.deepEqual(result.progress, { attempted: 2, translated: 2, skipped: 0 });
    assert.deepEqual(result.document.segments.map((segment) => segment.chinese), [
      "forced translation 2",
      "forced translation 2"
    ]);
    assert.equal(providerCalls, 2);
  } finally {
    await stopServer();
    if (providerServer) await new Promise((resolve) => providerServer.close(resolve));
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("concurrent adjacent paragraph translations call AI in parallel and write distinct TeX safely", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-adjacent-translate-"));
  const projectRoot = path.join(root, "project");
  let providerServer;
  let active = 0;
  let maxActive = 0;
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(
      path.join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "The first original paragraph contains enough academic words for adjacent translation testing.",
        "",
        "The second original paragraph contains enough academic words for adjacent translation testing.",
        "\\end{document}"
      ].join("\n"),
      "utf8"
    );
    providerServer = http.createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        const payload = JSON.parse(body);
        const user = payload.messages.find((message) => message.role === "user")?.content || "";
        const isFirst = user.includes("第一段中文");
        await new Promise((resolve) => setTimeout(resolve, 80));
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          choices: [{
            message: {
              content: isFirst
                ? "The first translated paragraph contains enough academic words and remains distinct."
                : "The second translated paragraph contains enough academic words and remains distinct."
            }
          }]
        }));
      } finally {
        active -= 1;
      }
    });
    await new Promise((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
    const providerPort = providerServer.address().port;
    const server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data"),
      projectsRoot: path.join(root, "projects")
    });
    const request = async (url, body) => {
      const response = await fetch(`${server.url}${url}`, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
      const payload = await response.json();
      assert.equal(response.ok, true, payload.error);
      return payload;
    };
    const provider = {
      type: "openai-compatible",
      baseUrl: `http://127.0.0.1:${providerPort}`,
      apiKey: "test-key",
      model: "test-model",
      jsonMode: true
    };
    await request("/api/setup", {
      source: { mode: "local", localPath: projectRoot },
      translation: provider,
      review: provider,
      autoCompile: false
    });
    const document = await request("/api/document?file=main.tex");
    await Promise.all([
      request("/api/segment/translate", {
        file: "main.tex",
        index: document.segments[0].index,
        sourceHash: document.segments[0].sourceHash,
        chinese: "第一段中文工作稿。",
        deferCompile: true
      }),
      request("/api/segment/translate", {
        file: "main.tex",
        index: document.segments[1].index,
        sourceHash: document.segments[1].sourceHash,
        chinese: "第二段中文工作稿。",
        deferCompile: true
      })
    ]);
    assert.equal(maxActive, 2);
    const result = await request("/api/document?file=main.tex");
    assert.match(result.segments[0].english, /first translated paragraph/);
    assert.match(result.segments[1].english, /second translated paragraph/);
    assert.notEqual(result.segments[0].english, result.segments[1].english);
  } finally {
    await stopServer();
    if (providerServer) await new Promise((resolve) => providerServer.close(resolve));
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("file terminology is extracted locally before Chinese translation and reused in prompts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-terminology-"));
  const projectRoot = path.join(root, "project");
  let providerServer;
  const translationPrompts = [];
  let generationCalls = 0;
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(
      path.join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\begin{table}",
        "\\begin{tabular}{ll}",
        "信标 & beacon \\\\",
        "\\end{tabular}",
        "\\caption{Terminology table}",
        "\\end{table}",
        "\\section{Introduction}",
        "Low Earth Orbit (LEO) satellite links require repeated terminology consistency.",
        "The beacon interval controls the synchronization cadence for low-earth-orbit satellite links.",
        "\\end{document}"
      ].join("\n"),
      "utf8"
    );
    providerServer = http.createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      const system = payload.messages.find((message) => message.role === "system")?.content || "";
      const user = payload.messages.find((message) => message.role === "user")?.content || "";
      response.writeHead(200, { "Content-Type": "application/json" });
      if (system.includes("You build a compact bilingual terminology glossary")) {
        generationCalls += 1;
        response.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ terms: [{ english: "beacon", chinese: "信标", keepEnglish: false }] }) } }]
        }));
        return;
      }
      translationPrompts.push({ system, user });
      const input = JSON.parse(user.slice(user.lastIndexOf("\n") + 1));
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              translations: input.map((item) => ({ id: item.id, chinese: "信标间隔控制同步节奏。" }))
            })
          }
        }]
      }));
    });
    await new Promise((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
    const providerPort = providerServer.address().port;
    const server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data"),
      projectsRoot: path.join(root, "projects")
    });
    const request = async (url, body) => {
      const response = await fetch(`${server.url}${url}`, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
      const payload = await response.json();
      assert.equal(response.ok, true, payload.error);
      return payload;
    };
    const provider = {
      type: "openai-compatible",
      baseUrl: `http://127.0.0.1:${providerPort}`,
      apiKey: "test-key",
      model: "test-model",
      jsonMode: true
    };
    await request("/api/setup", {
      source: { mode: "local", localPath: projectRoot },
      translation: provider,
      review: provider,
      autoCompile: false
    });
    const terminology = await request("/api/file/terminology", { file: "main.tex", force: true });
    assert.equal(generationCalls, 0);
    const pairs = terminology.entries.map((entry) => [entry.chinese, entry.english]);
    assert.ok(pairs.some((pair) => pair[0] === "信标" && pair[1] === "beacon"));
    assert.ok(pairs.some((pair) => pair[0] === "LEO" && pair[1] === "LEO"));
    const document = await request("/api/document?file=main.tex");
    const result = await request("/api/file/translate-to-chinese", {
      file: "main.tex",
      segmentIds: [document.segments[0].id],
      force: true
    });
    assert.equal(result.document.segments[0].chinese, "信标间隔控制同步节奏。");
    assert.equal(translationPrompts.length, 1);
    assert.match(translationPrompts[0].user, /信标 => beacon/);
  } finally {
    await stopServer();
    if (providerServer) await new Promise((resolve) => providerServer.close(resolve));
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("terminology extraction keeps frequent abbreviations and applies first-use definitions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-abbreviation-terminology-"));
  const projectRoot = path.join(root, "project");
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(
      path.join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{Introduction}",
        "ADR improves link adaptation for satellite terminals.",
        "The DtS-IoT scheduler uses ADR during intermittent connectivity.",
        "DtS-IoT improves handover reliability, while Low Earth Orbit (LEO) links use ADR repeatedly.",
        "\\end{document}"
      ].join("\n"),
      "utf8"
    );
    const server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data"),
      projectsRoot: path.join(root, "projects")
    });
    const request = async (url, body, method = body ? "POST" : "GET") => {
      const response = await fetch(`${server.url}${url}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
      const payload = await response.json();
      assert.equal(response.ok, true, payload.error);
      return payload;
    };
    const provider = {
      type: "openai-compatible",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "test-key",
      model: "test-model",
      jsonMode: true
    };
    await request("/api/setup", {
      source: { mode: "local", localPath: projectRoot },
      translation: provider,
      review: provider,
      autoCompile: false
    });

    const terminology = await request("/api/file/terminology", { file: "main.tex", force: true });
    const byEnglish = new Map(terminology.entries.map((entry) => [entry.english, entry]));
    assert.equal(byEnglish.get("ADR")?.frequency, 3);
    assert.equal(byEnglish.get("ADR")?.needsFullName, true);
    assert.equal(byEnglish.get("ADR")?.fullName, "");
    assert.equal(byEnglish.get("DtS-IoT")?.frequency, 2);
    assert.equal(byEnglish.get("DtS-IoT")?.needsFullName, true);
    assert.equal(byEnglish.get("LEO")?.fullName, "Low Earth Orbit");
    assert.equal(byEnglish.get("LEO")?.needsFullName, false);

    const entries = terminology.entries.map((entry) => (
      entry.english === "ADR"
        ? { ...entry, fullName: "Adaptive Data Rate", needsFullName: false }
        : entry.english === "DtS-IoT"
          ? { ...entry, fullName: "Direct-to-Satellite Internet of Things", needsFullName: false }
          : entry
    ));
    const applied = await request("/api/file/terminology/apply", { file: "main.tex", entries });
    assert.deepEqual(applied.applied.map((entry) => entry.english), ["ADR", "DtS-IoT"]);
    assert.ok(applied.skipped.some((entry) => entry.english === "LEO" && entry.reason === "already-defined"));
    const source = await request("/api/source?file=main.tex");
    assert.match(source.content, /Adaptive Data Rate \(ADR\) improves link adaptation/);
    assert.match(source.content, /The Direct-to-Satellite Internet of Things \(DtS-IoT\) scheduler uses ADR/);
    assert.match(source.content, /Low Earth Orbit \(LEO\) links use ADR repeatedly/);
    assert.equal((source.content.match(/Adaptive Data Rate \(ADR\)/g) || []).length, 1);
  } finally {
    await stopServer();
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("terminology extraction scans the full project and writes first-use definitions across files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-project-terminology-"));
  const projectRoot = path.join(root, "project");
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(
      path.join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\input{intro}",
        "\\input{method}",
        "\\end{document}"
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(projectRoot, "intro.tex"),
      [
        "\\section{Introduction}",
        "Low Earth Orbit (LEO) satellite links use ADR during initial access.",
        "The introduction mentions ADR before the method file."
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(projectRoot, "method.tex"),
      [
        "\\section{Method}",
        "The ADR controller is evaluated with a Direct-to-Satellite Internet of Things (DtS-IoT) scheduler.",
        "DtS-IoT keeps the same beacon timing while ADR changes PHY parameters."
      ].join("\n"),
      "utf8"
    );
    const server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data"),
      projectsRoot: path.join(root, "projects")
    });
    const request = async (url, body, method = body ? "POST" : "GET") => {
      const response = await fetch(`${server.url}${url}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
      const payload = await response.json();
      assert.equal(response.ok, true, payload.error);
      return payload;
    };
    const provider = {
      type: "openai-compatible",
      baseUrl: "http://127.0.0.1:1",
      apiKey: "test-key",
      model: "test-model",
      jsonMode: true
    };
    await request("/api/setup", {
      source: { mode: "local", localPath: projectRoot },
      translation: provider,
      review: provider,
      autoCompile: false
    });

    const terminology = await request("/api/file/terminology", { file: "method.tex", force: true });
    assert.equal(terminology.scope, "project");
    assert.deepEqual(terminology.files, ["main.tex", "intro.tex", "method.tex"]);
    const byEnglish = new Map(terminology.entries.map((entry) => [entry.english, entry]));
    assert.equal(byEnglish.get("ADR")?.frequency, 4);
    assert.equal(byEnglish.get("ADR")?.needsFullName, true);
    assert.equal(byEnglish.get("LEO")?.fullName, "Low Earth Orbit");
    assert.equal(byEnglish.get("LEO")?.note, "Low Earth Orbit");
    assert.equal(byEnglish.get("DtS-IoT")?.fullName, "Direct-to-Satellite Internet of Things");
    assert.equal(byEnglish.get("DtS-IoT")?.note, "Direct-to-Satellite Internet of Things");
    assert.ok(terminology.entries.every((entry) => !String(entry.note || "").includes("abbreviation for")));

    const saved = await request("/api/file/terminology", {
      file: "intro.tex",
      entries: terminology.entries.map((entry) => (
        entry.english === "ADR"
          ? { ...entry, fullName: "Adaptive Data Rate", note: "Adaptive Data Rate", needsFullName: false }
          : entry
      ))
    }, "PUT");
    assert.equal(saved.scope, "project");

    const reused = await request("/api/file/terminology?file=method.tex");
    assert.equal(reused.scope, "project");
    assert.equal(new Map(reused.entries.map((entry) => [entry.english, entry])).get("ADR")?.fullName, "Adaptive Data Rate");

    const applied = await request("/api/file/terminology/apply", { file: "method.tex", entries: reused.entries });
    assert.ok(applied.applied.some((entry) => entry.english === "ADR" && entry.file === "intro.tex"));
    const introSource = await request("/api/source?file=intro.tex");
    const methodSource = await request("/api/source?file=method.tex");
    assert.match(introSource.content, /Adaptive Data Rate \(ADR\) during initial access/);
    assert.doesNotMatch(methodSource.content, /Adaptive Data Rate \(ADR\)/);
  } finally {
    await stopServer();
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("manually saved terminology is editable and not overwritten by non-forced generation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-manual-terminology-"));
  const projectRoot = path.join(root, "project");
  let providerServer;
  const translationPrompts = [];
  let generationCalls = 0;
  try {
    await fs.mkdir(projectRoot);
    await fs.writeFile(
      path.join(projectRoot, "main.tex"),
      [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\section{Introduction}",
        "The beacon interval controls the synchronization cadence for low-earth-orbit satellite links.",
        "\\end{document}"
      ].join("\n"),
      "utf8"
    );
    providerServer = http.createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      const system = payload.messages.find((message) => message.role === "system")?.content || "";
      const user = payload.messages.find((message) => message.role === "user")?.content || "";
      response.writeHead(200, { "Content-Type": "application/json" });
      if (system.includes("You build a compact bilingual terminology glossary")) {
        generationCalls += 1;
        response.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ terms: [{ english: "orbit", chinese: "轨道" }] }) } }]
        }));
        return;
      }
      translationPrompts.push(user);
      const input = JSON.parse(user.slice(user.lastIndexOf("\n") + 1));
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              translations: input.map((item) => ({ id: item.id, chinese: "信标间隔控制同步节奏。" }))
            })
          }
        }]
      }));
    });
    await new Promise((resolve) => providerServer.listen(0, "127.0.0.1", resolve));
    const providerPort = providerServer.address().port;
    const server = await startServer({
      port: 0,
      dataRoot: path.join(root, "data"),
      projectsRoot: path.join(root, "projects")
    });
    const request = async (url, body, method = body ? "POST" : "GET") => {
      const response = await fetch(`${server.url}${url}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
      const payload = await response.json();
      assert.equal(response.ok, true, payload.error);
      return payload;
    };
    const provider = {
      type: "openai-compatible",
      baseUrl: `http://127.0.0.1:${providerPort}`,
      apiKey: "test-key",
      model: "test-model",
      jsonMode: true
    };
    await request("/api/setup", {
      source: { mode: "local", localPath: projectRoot },
      translation: provider,
      review: provider,
      autoCompile: false
    });
    const initial = await request("/api/file/terminology?file=main.tex");
    assert.equal(initial.cached, false);
    assert.deepEqual(initial.entries, []);

    const saved = await request("/api/file/terminology", {
      file: "main.tex",
      entries: [{ english: "beacon", chinese: "信标", note: "fixed paper term" }]
    }, "PUT");
    assert.equal(saved.manual, true);
    assert.deepEqual(saved.entries.map((entry) => [entry.chinese, entry.english]), [["信标", "beacon"]]);

    const reused = await request("/api/file/terminology", { file: "main.tex" });
    assert.equal(reused.manual, true);
    assert.equal(generationCalls, 0);
    assert.deepEqual(reused.entries.map((entry) => [entry.chinese, entry.english]), [["信标", "beacon"]]);

    const document = await request("/api/document?file=main.tex");
    await request("/api/file/translate-to-chinese", {
      file: "main.tex",
      segmentIds: [document.segments[0].id],
      force: true
    });
    assert.equal(translationPrompts.length, 1);
    assert.match(translationPrompts[0], /信标 => beacon/);
  } finally {
    await stopServer();
    if (providerServer) await new Promise((resolve) => providerServer.close(resolve));
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});
