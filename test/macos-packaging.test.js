import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testRoot, "..");
const require = createRequire(import.meta.url);
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
const electronMain = fs.readFileSync(path.join(projectRoot, "electron-main.js"), "utf8");
const workflow = fs.readFileSync(path.join(projectRoot, ".github", "workflows", "build-macos.yml"), "utf8");

test("macOS packaging targets both supported architectures", () => {
  assert.equal(packageJson.build.directories.output, "release/windows");
  assert.match(packageJson.scripts["build:mac"], /electron-builder --config build\/electron-builder\.mac\.cjs --mac dmg zip --universal/);
  assert.match(packageJson.scripts["build:mac:x64"], /electron-builder --config build\/electron-builder\.mac\.cjs --mac dmg zip --x64/);
  assert.match(packageJson.scripts["build:mac:arm64"], /electron-builder --config build\/electron-builder\.mac\.cjs --mac dmg zip --arm64/);
  const mac = packageJson.build.mac;
  assert.equal(mac.category, "public.app-category.productivity");
  assert.deepEqual(mac.target.flatMap((target) => target.arch), ["x64", "arm64", "x64", "arm64"]);
  assert.match(mac.artifactName, /mac-\$\{arch\}/);
  const macConfig = require(path.join(projectRoot, "build", "electron-builder.mac.cjs"));
  assert.equal(macConfig.directories.output, "release/macos");
  assert.deepEqual(macConfig.extraResources[0].filter, ["darwin-x64/tectonic", "darwin-arm64/tectonic"]);
});

test("macOS workflow bundles an architecture-matched Tectonic binary", () => {
  assert.match(workflow, /macos-13/);
  assert.match(workflow, /macos-14/);
  assert.match(workflow, /brew install tectonic/);
  assert.match(workflow, /darwin-\$\{\{ matrix\.arch \}\}/);
  assert.match(workflow, /npm run build:mac:\$\{\{ matrix\.arch \}\}/);
});

test("desktop runtime resolves a platform-appropriate compiler", () => {
  assert.match(electronMain, /function findBundledTectonic\(\)/);
  assert.match(electronMain, /process\.platform === "win32"/);
  assert.match(electronMain, /\$\{process\.platform\}-\$\{process\.arch\}\/tectonic/);
  assert.doesNotMatch(electronMain, /path\.join\(process\.resourcesPath, "bin", "tectonic\.exe"\)/);
  assert.match(electronMain, /process\.platform !== "darwin"/);
});
