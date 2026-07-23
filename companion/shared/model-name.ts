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
