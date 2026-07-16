import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer, stopServer } from "../server.js";
import { stageStorageMigration } from "../lib/storage.js";

async function jsonRequest(baseUrl, url, body) {
  const response = await fetch(`${baseUrl}${url}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json();
  assert.equal(response.ok, true, payload.error);
  return payload;
}

test("changing the storage root migrates managed projects and saved state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-storage-"));
  const oldDataRoot = path.join(root, "legacy-data");
  const oldProjectsRoot = path.join(root, "legacy-projects");
  const oldProjectRoot = path.join(oldProjectsRoot, "managed-paper");
  const targetStorageRoot = path.join(root, "new-storage");
  let persistedRoot = "";
  try {
    await fs.mkdir(oldProjectRoot, { recursive: true });
    await fs.writeFile(
      path.join(oldProjectRoot, "main.tex"),
      "\\documentclass{article}\n\\begin{document}Managed project content.\\end{document}\n",
      "utf8"
    );
    let server = await startServer({
      port: 0,
      dataRoot: oldDataRoot,
      projectsRoot: oldProjectsRoot,
      defaultStorageRoot: targetStorageRoot,
      persistStorageRoot: async (value) => { persistedRoot = value; }
    });
    await jsonRequest(server.url, "/api/config", {
      translation: { apiKey: "translation-key" },
      review: { apiKey: "review-key" }
    });
    await jsonRequest(server.url, "/api/setup", {
      source: { mode: "local", localPath: oldProjectRoot },
      preserveProviders: true,
      autoCompile: false
    });

    const migrated = await jsonRequest(server.url, "/api/storage/migrate", { storageRoot: targetStorageRoot });
    const expectedProjectRoot = path.join(targetStorageRoot, "Projects", "managed-paper");
    assert.equal(migrated.migration.changed, true);
    assert.equal(migrated.project.config.storageRoot, targetStorageRoot);
    assert.equal(migrated.project.config.projectsRoot, path.join(targetStorageRoot, "Projects"));
    assert.equal(migrated.project.config.projectRoot, expectedProjectRoot);
    assert.equal(persistedRoot, targetStorageRoot);
    assert.equal(await fs.readFile(path.join(expectedProjectRoot, "main.tex"), "utf8"), "\\documentclass{article}\n\\begin{document}Managed project content.\\end{document}\n");
    await assert.rejects(fs.access(oldProjectRoot));
    await assert.rejects(fs.access(path.join(oldDataRoot, "config.local.json")));
    await fs.access(path.join(targetStorageRoot, ".paperbridge-storage"));
    await fs.access(path.join(targetStorageRoot, "Settings", "config.local.json"));

    await stopServer();
    server = await startServer({
      port: 0,
      storageRoot: targetStorageRoot,
      dataRoot: path.join(targetStorageRoot, "Settings"),
      projectsRoot: path.join(targetStorageRoot, "Projects"),
      persistStorageRoot: async () => {}
    });
    const restarted = await jsonRequest(server.url, "/api/bootstrap");
    assert.equal(restarted.setupRequired, false);
    assert.equal(restarted.config.projectRoot, expectedProjectRoot);
    assert.equal(restarted.config.translation.hasApiKey, true);
  } finally {
    await stopServer();
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("storage migration refuses a non-empty destination", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperbridge-storage-conflict-"));
  try {
    const dataRoot = path.join(root, "data");
    const projectsRoot = path.join(root, "projects");
    const target = path.join(root, "occupied");
    await fs.mkdir(dataRoot);
    await fs.mkdir(projectsRoot);
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "personal.txt"), "keep", "utf8");
    await assert.rejects(
      stageStorageMigration({ sourceDataRoot: dataRoot, sourceProjectsRoot: projectsRoot, targetStorageRoot: target }),
      /空文件夹/
    );
    assert.equal(await fs.readFile(path.join(target, "personal.txt"), "utf8"), "keep");
  } finally {
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
});
