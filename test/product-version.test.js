import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("product lines keep independent versions and release tag prefixes", async () => {
  const root = process.cwd();
  const versions = JSON.parse(await fs.readFile(path.join(root, "product-versions.json"), "utf8"));
  const windows = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const plugin = JSON.parse(await fs.readFile(path.join(root, "pblatex-vscode", "package.json"), "utf8"));
  const macConfig = await fs.readFile(path.join(root, "build", "electron-builder.mac.cjs"), "utf8");
  const macWorkflow = await fs.readFile(path.join(root, ".github", "workflows", "build-macos.yml"), "utf8");
  const windowsWorkflow = await fs.readFile(path.join(root, ".github", "workflows", "build-windows.yml"), "utf8");

  assert.equal(versions.windows.version, windows.version);
  assert.equal(versions.plugin.version, plugin.version);
  assert.equal(versions.windows.tagPrefix, "windows-v");
  assert.equal(versions.macos.tagPrefix, "macos-v");
  assert.deepEqual(Object.keys(versions).sort(), ["macos", "plugin", "windows"]);
  assert.equal(versions.plugin.tagPrefix, "pblatex-v");
  assert.match(macConfig, /productVersions\.macos\.version/);
  assert.match(macWorkflow, /"macos-v\*"/);
  assert.doesNotMatch(macWorkflow, /"v\*"/);
  assert.match(windowsWorkflow, /"windows-v\*"/);
});
