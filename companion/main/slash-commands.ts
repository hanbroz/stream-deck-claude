import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { SlashCommand } from "../shared/slash-commands";

/**
 * The commands the composer's "/" menu offers — the same inventory the
 * interactive CLI lists: custom commands (`.claude/commands/*.md`), skills
 * (`.claude/skills/<name>/SKILL.md`), and every installed plugin's commands
 * and skills (namespaced `plugin:name`). All of these are prompt expansions,
 * which `claude --print` executes.
 *
 * Only builtins probed to actually answer in print mode are listed:
 * /status and /release-notes reply "isn't available in this environment",
 * /compact returns empty output (so it stays out until that UX is solved),
 * and interactive-only builtins (/config, /copy, /vim, …) drive the terminal
 * UI. /clear is listed but handled by the Companion itself (new
 * conversation), never sent to the CLI.
 */
const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "clear", description: "새 대화 시작", source: "builtin" },
  { name: "usage", description: "구독 사용량 한도 확인", source: "builtin" },
  { name: "cost", description: "현재 세션 비용·사용량", source: "builtin" },
  { name: "context", description: "컨텍스트 사용량 분석", source: "builtin" },
  // Probed working in print mode ("Reloaded skills: N skills available").
  // /reload-plugins is interactive-only — irrelevant here anyway, since every
  // Companion message spawns a fresh CLI that reloads plugins from disk.
  { name: "reload-skills", description: "스킬 목록 다시 로드", source: "builtin" }
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

async function describeFile(filePath: string): Promise<string | undefined> {
  try {
    return frontmatterDescription((await readFile(filePath, "utf8")).slice(0, 2048));
  } catch {
    return undefined; // a vanished/unreadable file still lists by name
  }
}

/** `<directory>/*.md` → commands. A namespace prefixes names as `ns:name`. */
async function scanCommandDirectory(
  directory: string,
  source: SlashCommand["source"],
  namespace?: string
): Promise<SlashCommand[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const commands: SlashCommand[] = [];
  for (const entry of entries) {
    // ponytail: top-level *.md only; nested namespaced command dirs can come
    // later if anyone actually uses them.
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const bare = entry.name.slice(0, -".md".length);
    commands.push({
      name: namespace ? `${namespace}:${bare}` : bare,
      description: await describeFile(path.join(directory, entry.name)),
      source
    });
  }
  return commands;
}

/** `<directory>/<name>/SKILL.md` → commands, like the CLI's skill slashes. */
async function scanSkillDirectory(
  directory: string,
  source: SlashCommand["source"],
  namespace?: string
): Promise<SlashCommand[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const commands: SlashCommand[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const description = await describeFile(path.join(directory, entry.name, "SKILL.md"));
    if (description === undefined) {
      // No readable SKILL.md → not a skill folder.
      continue;
    }
    commands.push({
      name: namespace ? `${namespace}:${entry.name}` : entry.name,
      description,
      source
    });
  }
  return commands;
}

/** Installed plugins from the CLI's own manifest: name → installPath. */
async function installedPlugins(configDir: string): Promise<Array<{ name: string; installPath: string }>> {
  try {
    const manifest = JSON.parse(
      await readFile(path.join(configDir, "plugins", "installed_plugins.json"), "utf8")
    ) as { plugins?: Record<string, Array<{ installPath?: string }>> };
    const plugins: Array<{ name: string; installPath: string }> = [];
    for (const [key, installs] of Object.entries(manifest.plugins ?? {})) {
      const installPath = installs?.[0]?.installPath;
      if (typeof installPath === "string" && installPath.length > 0) {
        plugins.push({ name: key.split("@")[0], installPath });
      }
    }
    return plugins;
  } catch {
    return []; // no plugins installed (or unreadable manifest)
  }
}

export async function listSlashCommands(options: {
  configDir: string;
  projectRoot: string;
}): Promise<SlashCommand[]> {
  const plugins = await installedPlugins(options.configDir);
  const groups = await Promise.all([
    scanCommandDirectory(path.join(options.projectRoot, ".claude", "commands"), "project"),
    scanSkillDirectory(path.join(options.projectRoot, ".claude", "skills"), "project"),
    scanCommandDirectory(path.join(options.configDir, "commands"), "user"),
    scanSkillDirectory(path.join(options.configDir, "skills"), "user"),
    ...plugins.flatMap((plugin) => [
      scanCommandDirectory(path.join(plugin.installPath, "commands"), "plugin", plugin.name),
      scanSkillDirectory(path.join(plugin.installPath, "skills"), "plugin", plugin.name)
    ])
  ]);

  // Builtins first, then project → user → plugins; first occurrence of a
  // name wins (project shadows user shadows plugins).
  const seen = new Set(BUILTIN_COMMANDS.map((command) => command.name));
  const merged = [...BUILTIN_COMMANDS];
  for (const command of groups.flat()) {
    if (!seen.has(command.name)) {
      seen.add(command.name);
      merged.push(command);
    }
  }
  return merged;
}
