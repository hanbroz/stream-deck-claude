import os from "node:os";
import path from "node:path";

export function defaultClaudeSettingsPath(): string {
  return path.join(os.homedir(), ".claude", "settings.json");
}

export function defaultOmcUsageCachePath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  return path.join(configDir, "plugins", "oh-my-claudecode", ".usage-cache-anthropic.json");
}

export function defaultUsageDataDir(): string {
  return path.join(process.env.LOCALAPPDATA ?? os.homedir(), "ClaudeUsageDeck");
}
