const packageJson = require("../package.json");
const productVersions = require("../product-versions.json");

const build = JSON.parse(JSON.stringify(packageJson.build));

// macOS has its own release sequence.  Keep the Windows version in the root
// package.json, but override the packaged app metadata for this target.
build.extraMetadata = {
  ...(build.extraMetadata || {}),
  version: productVersions.macos.version
};

build.directories = {
  ...(build.directories || {}),
  output: "release/macos"
};

// Keep the Windows compiler out of macOS artifacts. The macOS workflow places
// the matching Homebrew Tectonic binary under one of these architecture paths.
build.extraResources = [
  {
    from: "resources/bin",
    to: "bin",
    filter: [
      "darwin-x64/tectonic",
      "darwin-arm64/tectonic"
    ]
  }
];

module.exports = build;
