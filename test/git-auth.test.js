import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cloneGitProject,
  cloneOverleafProject,
  configureProjectRuntime,
  describeOverleafGitError
} from "../lib/project.js";

test("Overleaf Git operations provide the saved token without an interactive password prompt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-git-auth-"));
  const token = "paperbridge-test-token";
  const expectedAuthorization = `Basic ${Buffer.from(`git:${token}`).toString("base64")}`;
  const authorizations = [];
  const server = http.createServer((request, response) => {
    authorizations.push(request.headers.authorization || "");
    if (request.headers.authorization !== expectedAuthorization) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="PaperBridge test"' });
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });

  try {
    const askPassPath = path.join(root, "git-askpass.cmd");
    await fs.writeFile(askPassPath, [
      "@echo off",
      "echo %~1| findstr /I \"username\" >nul",
      "if %errorlevel%==0 (echo %PAPERBRIDGE_GIT_USERNAME%) else (echo %PAPERBRIDGE_GIT_TOKEN%)"
    ].join("\r\n"), "utf8");
    configureProjectRuntime({ askPassPath, getOverleafToken: () => token });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    await assert.rejects(
      cloneOverleafProject(`http://git@127.0.0.1:${port}/repo`, path.join(root, "clone"), token)
    );
    assert.ok(authorizations.includes(expectedAuthorization));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("generic HTTPS Git operations use the configured username and token", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-generic-git-auth-"));
  const username = "paper-author";
  const token = "generic-test-token";
  const expectedAuthorization = `Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`;
  const authorizations = [];
  const server = http.createServer((request, response) => {
    authorizations.push(request.headers.authorization || "");
    if (request.headers.authorization !== expectedAuthorization) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="PaperBridge test"' });
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });

  try {
    const askPassPath = path.join(root, "git-askpass.cmd");
    await fs.writeFile(askPassPath, [
      "@echo off",
      "echo %~1| findstr /I \"username\" >nul",
      "if %errorlevel%==0 (echo %PAPERBRIDGE_GIT_USERNAME%) else (echo %PAPERBRIDGE_GIT_TOKEN%)"
    ].join("\r\n"), "utf8");
    configureProjectRuntime({ askPassPath });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();

    await assert.rejects(
      cloneGitProject(`http://127.0.0.1:${port}/repo`, path.join(root, "clone"), username, token)
    );
    assert.ok(authorizations.includes(expectedAuthorization));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Overleaf no-git-access errors explain the premium requirement in Chinese", () => {
  const message = describeOverleafGitError(
    "remote error: no git access This Overleaf project currently has no git access"
  );
  assert.match(message, /Overleaf 拒绝了 Git 访问/);
  assert.match(message, /高级功能/);
  assert.match(message, /Overleaf Commons/);
  assert.match(message, /ZIP/);
});
