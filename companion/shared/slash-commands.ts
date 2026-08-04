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

/**
 * Slash commands the interactive TUI owns, but which Claude Code also ships as
 * a real non-interactive subcommand (`claude plugin …`, `claude mcp …`). The
 * Companion runs those through the CLI instead of refusing them; every other
 * terminal-only builtin is pure TUI or session-scoped and stays refused.
 *
 * `/agents` is deliberately absent: the CLI does have `claude agents`, but it
 * manages BACKGROUND agents, not the subagent roster `/agents` edits.
 */
export const BRIDGED_CLI_COMMANDS = ["plugin", "mcp"] as const;

export type BridgedCliCommand = (typeof BRIDGED_CLI_COMMANDS)[number];

export function isBridgedCliCommand(name: string): name is BridgedCliCommand {
  return (BRIDGED_CLI_COMMANDS as readonly string[]).includes(name);
}

/**
 * Terminal-only builtins whose effect does NOT depend on which conversation
 * they run in -- settings, account, install health. Handing these to an
 * interactive `claude` in the TERMINAL tab gives the real answer.
 *
 * The rest of the terminal-only roster is conversation-scoped (/export,
 * /rewind, /copy, /todos, /add-dir, /ide, /resume, /vim, /reload-plugins):
 * a terminal session is a DIFFERENT conversation, so handing those off would
 * quietly act on the wrong one. They keep their refusal.
 */
export const TERMINAL_HANDOFF_COMMANDS = [
  "agents",
  "bug",
  "config",
  "doctor",
  "help",
  "hooks",
  "install-github-app",
  "login",
  "logout",
  "memory",
  "output-style",
  "permissions",
  "pr-comments",
  "privacy-settings",
  "release-notes",
  "status",
  "statusline",
  "terminal-setup",
  "upgrade"
] as const;

export function isTerminalHandoffCommand(name: string): boolean {
  return (TERMINAL_HANDOFF_COMMANDS as readonly string[]).includes(name);
}

/**
 * Split a composer line into argv, honouring quotes the way a shell would --
 * but no shell is involved. The pieces go to execFile as an array, so nothing
 * typed here can chain a second command or expand a variable.
 */
export function splitArguments(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let open = false;
  for (const char of text) {
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      // An empty "" is still an argument, so remember that one started.
      quote = char;
      open = true;
      continue;
    }
    if (/\s/u.test(char)) {
      if (open) {
        args.push(current);
        current = "";
        open = false;
      }
      continue;
    }
    current += char;
    open = true;
  }
  if (open) {
    args.push(current);
  }
  return args;
}
