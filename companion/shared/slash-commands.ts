export type SlashCommand = {
  /** Command name without the leading slash, e.g. "clear" or "review". */
  name: string;
  description?: string;
  source: "builtin" | "project" | "user";
};

/**
 * The composer shows the command menu only while the draft is a single
 * slash-token (no space yet): that is the moment the user is still choosing.
 * Returns the commands matching the typed prefix, or null when the menu
 * should be closed.
 */
export function filterSlashCommands(
  commands: readonly SlashCommand[],
  draft: string
): SlashCommand[] | null {
  const match = /^\/([^\s/]*)$/u.exec(draft);
  if (!match) {
    return null;
  }
  const prefix = match[1].toLowerCase();
  const hits = commands.filter((command) => command.name.toLowerCase().startsWith(prefix));
  return hits.length > 0 ? hits : null;
}

/** Selecting a command stages `/name ` so the user can type arguments. */
export function applySlashCommand(command: SlashCommand): string {
  return `/${command.name} `;
}
