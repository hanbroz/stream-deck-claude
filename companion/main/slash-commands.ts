import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { SlashCommand } from "../shared/slash-commands";

/**
 * The commands the composer's "/" menu offers.
 *
 * Custom commands are the folder's `.claude/commands/*.md` plus the user's
 * `<configDir>/commands/*.md` — both documented to work in `claude --print`.
 * `/clear` is listed too but handled by the Companion itself (new
 * conversation), never sent to the CLI.
 */
// /compact is deliberately absent: probing `claude --print` showed it hangs
// (no result within 60s), which would leave the Companion stuck "working".
const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "clear", description: "새 대화 시작", source: "builtin" }
];

/** First `description:` line of the file's YAML frontmatter, if any. */
function frontmatterDescription(head: string): string | undefined {
  if (!head.startsWith("---")) {
    return undefined;
  }
  const end = head.indexOf("\n---", 3);
  const block = end === -1 ? head : head.slice(0, end);
  const match = /^description:\s*(.+)$/mu.exec(block);
  return match?.[1].trim().replace(/^["']|["']$/gu, "");
}

async function scanCommandDirectory(
  directory: string,
  source: SlashCommand["source"]
): Promise<SlashCommand[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return []; // no commands directory — nothing to offer
  }

  const commands: SlashCommand[] = [];
  for (const entry of entries) {
    // ponytail: top-level *.md only; namespaced subdirectory commands can come
    // later if anyone actually uses them.
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    let description: string | undefined;
    try {
      const head = (await readFile(path.join(directory, entry.name), "utf8")).slice(0, 2048);
      description = frontmatterDescription(head);
    } catch {
      // A vanished/unreadable file still lists by name.
    }
    commands.push({ name: entry.name.slice(0, -".md".length), description, source });
  }
  return commands;
}

export async function listSlashCommands(options: {
  configDir: string;
  projectRoot: string;
}): Promise<SlashCommand[]> {
  const [project, user] = await Promise.all([
    scanCommandDirectory(path.join(options.projectRoot, ".claude", "commands"), "project"),
    scanCommandDirectory(path.join(options.configDir, "commands"), "user")
  ]);

  // Project commands shadow user commands of the same name; builtins first.
  const seen = new Set(BUILTIN_COMMANDS.map((command) => command.name));
  const merged = [...BUILTIN_COMMANDS];
  for (const command of [...project, ...user]) {
    if (!seen.has(command.name)) {
      seen.add(command.name);
      merged.push(command);
    }
  }
  return merged;
}
