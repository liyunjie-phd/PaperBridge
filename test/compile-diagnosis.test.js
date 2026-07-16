import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer, stopServer } from "../server.js";

test("compile diagnosis sends targeted source context and caches identical errors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-compile-diagnosis-"));
  const projectRoot = path.join(root, "project");
  let providerServer;
  let providerCalls = 0;
  let providerPrompt = "";
  try {
    await fs.mkdir(projectRoot);
    const lines = [
      "\\documentclass{article}",
      "\\usepackage{algorithm}",
      "\\begin{document}",
      "\\badcommand",
      "Nearby body line.",
      ...Array.from({ length: 34 }, (_value, index) => `Filler line ${index + 1}.`),
      "SECRET_DISTANT_BODY_MUST_NOT_BE_SENT",
      "\\end{document}"
    ];
    await fs.writeFile(path.join(projectRoot, "main.tex"), lines.join("\n"), "utf8");

    providerServer = http.createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      providerCalls += 1;
      providerPrompt = JSON.parse(body).messages[1].content;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              summary: "未定义命令导致编译停止。",
              issues: [{
                file: "main.tex",
                line: 4,
                explanation: "第 4 行使用了未定义的命令。",
                suggestion: "删除该命令或加载提供它的宏包。",
                replacement: "% remove \\badcommand"
              }]
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

    const buildError = {
      errors: ["Undefined control sequence."],
      log: "main.tex:4: Undefined control sequence.\nl.4 \\badcommand"
    };
    let diagnosis = await request("/api/compile/diagnose", buildError);
    assert.equal(diagnosis.cached, false);
    assert.equal(diagnosis.issues[0].file, "main.tex");
    assert.equal(diagnosis.issues[0].line, 4);
    assert.match(providerPrompt, /4: \\badcommand/);
    assert.doesNotMatch(providerPrompt, /SECRET_DISTANT_BODY_MUST_NOT_BE_SENT/);

    diagnosis = await request("/api/compile/diagnose", buildError);
    assert.equal(diagnosis.cached, true);
    assert.equal(providerCalls, 1);

    const warningResponse = await fetch(`${server.url}/api/compile/diagnose`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        errors: [],
        log: "LaTeX Warning: Citation `example' on page 1 undefined."
      })
    });
    const warningPayload = await warningResponse.json();
    assert.equal(warningResponse.ok, false);
    assert.match(warningPayload.error, /No fatal LaTeX error/);
    assert.equal(providerCalls, 1);
  } finally {
    await stopServer();
    if (providerServer) await new Promise((resolve) => providerServer.close(resolve));
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});
