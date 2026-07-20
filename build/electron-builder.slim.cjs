const packageJson = require("../package.json");

const build = JSON.parse(JSON.stringify(packageJson.build));

build.artifactName = "PaperBridge-Setup-Slim.${ext}";
build.asarUnpack = (build.asarUnpack || []).filter((pattern) => !String(pattern).includes("node_modules/dugite/git"));
build.files = [
  ...(build.files || []),
  "!node_modules/dugite/git/**/*"
];

module.exports = build;
