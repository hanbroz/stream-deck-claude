export type SlashCommand = {
  /** Command name without the leading slash, e.g. "clear" or "omc:plan". */
  name: string;
  description?: string;
  source: "builtin" | "project" | "user" | "plugin";
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
  // Match the full name or any ":" segment, so typing "/commit" also finds
  // the namespaced "commit-commands:commit".
  const hits = commands.filter((command) =>
    command.name.toLowerCase().split(":").some((segment) => segment.startsWith(prefix)) ||
    command.name.toLowerCase().startsWith(prefix)
  );
  return hits.length > 0 ? hits : null;
}

/** Selecting a command stages `/name ` so the user can type arguments. */
export function applySlashCommand(command: SlashCommand): string {
  return `/${command.name} `;
}
