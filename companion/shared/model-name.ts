import type { ClaudeModel } from "./claude-command";

/**
 * A representative full model id for each picker family. When the user applies a
 * model before any message has run, the stream has not reported an exact id yet,
 * so the Stream Deck key snapshot uses this to show a label (e.g. `Opus 4.8`).
 * The next message overwrites the snapshot with the real streamed id, so a stale
 * minor version here only ever shows until the first reply. Keep the versions in
 * step with the picker options in renderer/index.html.
 */
export const REPRESENTATIVE_MODEL_ID: Record<ClaudeModel, string> = {
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
  fable: "claude-fable-5"
};

/**
 * Single source of truth for turning a raw model id into a display label.
 *
 * The main process (Stream Deck key snapshot) and the renderer (model picker)
 * both need this, so it lives in shared/ with one regex. The minor version is
 * optional so a future single-segment release (e.g. `claude-sonnet-5`) still
 * yields a label instead of a blank.
 */
export function parseModelId(
  model: string | undefined
): { family: string; label: string } | null {
  if (!model) {
    return null;
  }
  const match = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/iu.exec(model.trim());
  if (!match) {
    return null;
  }
  const family = match[1].toLowerCase();
  const capitalised = `${family[0].toUpperCase()}${family.slice(1)}`;
  const version = match[3] ? `${match[2]}.${match[3]}` : match[2];
  return { family, label: `${capitalised} ${version}` };
}
