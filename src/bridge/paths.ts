import os from "node:os";
import path from "node:path";

export function defaultClaudeSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

export function defaultUsageDataDir(): string {
  return path.join(process.env.LOCALAPPDATA ?? os.homedir(), "ClaudeUsageDeck");
}
