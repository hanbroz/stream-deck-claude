import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureBridgeInstalled } from "./installer";
import { defaultClaudeSettingsPath, defaultUsageDataDir } from "./paths";

async function main(): Promise<void> {
  const bridgeDir = path.dirname(fileURLToPath(import.meta.url));
  const result = await ensureBridgeInstalled({
    settingsPath: defaultClaudeSettingsPath(),
    dataDir: defaultUsageDataDir(),
    bridgeSourcePath: path.join(bridgeDir, "statusline-bridge.js")
  });
  process.stdout.write(
    `${result.changed ? "Installed" : "Already installed"} Claude Usage Deck status-line bridge.\n`
  );
  process.stdout.write(`Cache: ${result.cachePath}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`Bridge installation failed: ${(error as Error).message}\n`);
  process.exitCode = 1;
});
