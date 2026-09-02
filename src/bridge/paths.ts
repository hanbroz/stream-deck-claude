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

/**
 * Roots under which OMC keeps its per-render status-line snapshot
 * (`state/hud-stdin-cache.json`, or `state/sessions/<id>/hud-stdin-cache.json`).
 * OMC resolves its state root from the status-line process's cwd, which
 * Claude Code runs from the user's home, so `~/.omc` is where the snapshot
 * lands in practice; `OMC_STATE_DIR/<project-id>` covers centralized setups.
 */
export function defaultOmcStdinCacheRoots(): string[] {
  const roots = [path.join(os.homedir(), ".omc")];
  const centralized = process.env.OMC_STATE_DIR?.trim();
  if (centralized) {
    roots.push(centralized);
  }
  return roots;
}
