import os from "node:os";
import path from "node:path";

/** Claude Code's config directory: `CLAUDE_CONFIG_DIR` when set, else `~/.claude`. */
export function defaultClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
}

export function defaultClaudeSettingsPath(): string {
  return path.join(defaultClaudeConfigDir(), "settings.json");
}

export function defaultClaudeCredentialsPath(): string {
  return path.join(defaultClaudeConfigDir(), ".credentials.json");
}

export function defaultOmcUsageCachePath(): string {
  return path.join(
    defaultClaudeConfigDir(),
    "plugins",
    "oh-my-claudecode",
    ".usage-cache-anthropic.json"
  );
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
export type OmcStdinCacheRoots = {
  /** OMC roots (each holds `state/…` directly). */
  omcRoots: string[];
  /** `OMC_STATE_DIR` values, whose children are per-project OMC roots. */
  stateDirs: string[];
};

export function defaultOmcStdinCacheRoots(): OmcStdinCacheRoots {
  const centralized = process.env.OMC_STATE_DIR?.trim();
  return {
    omcRoots: [path.join(os.homedir(), ".omc")],
    stateDirs: centralized ? [centralized] : []
  };
}
