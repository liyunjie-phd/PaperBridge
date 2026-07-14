import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("the Windows uninstaller asks before deleting PaperBridge data", async () => {
  const packageConfig = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  const script = await fs.readFile(new URL("../build/installer.nsh", import.meta.url), "utf8");

  assert.equal(packageConfig.build.nsis.include, "build/installer.nsh");
  assert.equal(packageConfig.build.nsis.deleteAppDataOnUninstall, false);
  assert.match(script, /!macro customUnInstall/);
  assert.match(script, /\$\{ifNot\} \$\{isUpdated\}/);
  assert.match(script, /MB_DEFBUTTON2/);
  assert.match(script, /IDNO paperBridgeKeepData/);
  assert.match(script, /RMDir \/r "\$DOCUMENTS\\PaperBridge Projects"/);
  assert.match(script, /RMDir \/r "\$APPDATA\\paper-bridge"/);
  assert.match(script, /RMDir \/r "\$LOCALAPPDATA\\paper-bridge"/);
});
