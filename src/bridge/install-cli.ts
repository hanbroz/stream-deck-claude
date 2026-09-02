import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureBridgeInstalled, uninstallBridge } from "./installer";
import { defaultClaudeSettingsPath, defaultUsageDataDir } from "./paths";

async function main(): Promise<void> {
  const bridgeDir = path.dirname(fileURLToPath(import.meta.url));
  const settingsPath = defaultClaudeSettingsPath();
  const dataDir = defaultUsageDataDir();

  if (process.argv.includes("--uninstall")) {
    const result = await uninstallBridge({ settingsPath, dataDir });
    process.stdout.write(
      result.changed
        ? `Removed Claude Usage Deck status-line bridge and hooks from ${settingsPath}.\n`
        : `No Claude Usage Deck entries found in ${settingsPath}.\n`
    );
    if (result.restoredCommand) {
      process.stdout.write(`Restored status line: ${result.restoredCommand}\n`);
    }
    process.stdout.write(`Cache files under ${dataDir} were left in place.\n`);
    return;
  }

  const result = await ensureBridgeInstalled({
    settingsPath,
    dataDir,
    bridgeSourcePath: path.join(bridgeDir, "statusline-bridge.js")
  });
  process.stdout.write(
    `${result.changed ? "Installed" : "Already installed"} Claude Usage Deck status-line bridge.\n`
  );
  process.stdout.write(`Cache: ${result.cachePath}\n`);
  for (const warning of result.warnings) {
    process.stderr.write(`Warning: ${warning}\n`);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`Bridge ${process.argv.includes("--uninstall") ? "removal" : "installation"} failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
