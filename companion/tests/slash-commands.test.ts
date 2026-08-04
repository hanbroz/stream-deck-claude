import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applySlashCommand,
  filterSlashCommands,
  isTerminalHandoffCommand,
  TERMINAL_HANDOFF_COMMANDS,
  type SlashCommand
} from "../shared/slash-commands";
import { listSlashCommands } from "../main/slash-commands";

const COMMANDS: SlashCommand[] = [
  { name: "clear", description: "새 대화 시작", source: "builtin" },
  { name: "review", source: "project" },
  { name: "release", source: "user" },
  { name: "commit-commands:commit", source: "plugin" }
];

describe("slash command filtering", () => {
  it("shows the menu only while typing a single slash token", () => {
    expect(filterSlashCommands(COMMANDS, "/")?.map((c) => c.name)).toEqual([
      "clear", "review", "release", "commit-commands:commit"
    ]);
    expect(filterSlashCommands(COMMANDS, "/re")?.map((c) => c.name)).toEqual(["review", "release"]);
    expect(filterSlashCommands(COMMANDS, "/REV")?.map((c) => c.name)).toEqual(["review"]);
    // Not a command draft: plain text, args already present, or no match.
    expect(filterSlashCommands(COMMANDS, "hello")).toBeNull();
    expect(filterSlashCommands(COMMANDS, "/clear now")).toBeNull();
    expect(filterSlashCommands(COMMANDS, "/nope")).toBeNull();
    expect(filterSlashCommands(COMMANDS, "")).toBeNull();
  });

  it("matches namespaced plugin commands by any segment", () => {
    expect(filterSlashCommands(COMMANDS, "/commit")?.map((c) => c.name)).toEqual([
      "commit-commands:commit"
    ]);
  });

  it("stages the command with a trailing space for arguments", () => {
    expect(applySlashCommand(COMMANDS[0])).toBe("/clear ");
  });
});

describe("listSlashCommands", () => {
  let configDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(os.tmpdir(), "companion-cfg-"));
    projectRoot = await mkdtemp(path.join(os.tmpdir(), "companion-proj-"));
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("merges builtins with project and user commands, project shadowing user", async () => {
    const projectCommands = path.join(projectRoot, ".claude", "commands");
    const userCommands = path.join(configDir, "commands");
    await mkdir(projectCommands, { recursive: true });
    await mkdir(userCommands, { recursive: true });
    await writeFile(
      path.join(projectCommands, "deploy.md"),
      "---\ndescription: 배포 실행\n---\nbody",
      "utf8"
    );
    await writeFile(path.join(userCommands, "deploy.md"), "user version", "utf8");
    await writeFile(path.join(userCommands, "handoff.md"), "no frontmatter", "utf8");

    const commands = await listSlashCommands({ configDir, projectRoot });
    const byName = new Map(commands.map((command) => [command.name, command]));

    expect(byName.get("clear")?.source).toBe("builtin");
    expect(byName.get("deploy")).toMatchObject({ source: "project", description: "배포 실행" });
    expect(byName.get("handoff")).toMatchObject({ source: "user", description: undefined });
  });

  it("returns the full builtin roster when no commands directories exist", async () => {
    const commands = await listSlashCommands({ configDir, projectRoot });
    const byName = new Map(commands.map((command) => [command.name, command]));

    // Print-mode-capable builtins carry plain descriptions. /compact runs in
    // print mode (verified against the CLI); /plugin and /mcp are served by
    // `claude plugin|mcp` through the Companion's CLI bridge.
    // /reload-skills and /reload-plugins are served by the Companion itself:
    // a fresh --print process per message already re-reads both from disk.
    for (const name of [
      "clear", "usage", "cost", "context", "model", "compact", "plugin", "mcp",
      "reload-skills", "reload-plugins"
    ]) {
      expect(byName.get(name)?.description).not.toContain("터미널 전용");
    }
    // …terminal-only ones are tagged but still listed (terminal parity).
    for (const name of ["help", "config", "resume", "vim", "status"]) {
      expect(byName.get(name)?.description).toContain("터미널 전용");
    }
    expect(commands.length).toBeGreaterThanOrEqual(35);
    expect(commands.every((command) => command.source === "builtin")).toBe(true);
  });

  it("hands off only terminal-only commands whose result is conversation-independent", async () => {
    const commands = await listSlashCommands({ configDir, projectRoot });
    const byName = new Map(commands.map((command) => [command.name, command]));

    // Every handoff target must still exist and still be terminal-only: if one
    // ever becomes print-capable, it should be sent to Claude, not the shell.
    for (const name of TERMINAL_HANDOFF_COMMANDS) {
      expect(byName.get(name)?.description, name).toContain("터미널 전용");
    }
    // Conversation-scoped commands must never be handed off — a terminal
    // session is a different conversation, so they would act on the wrong one.
    for (const name of ["export", "rewind", "copy", "todos", "add-dir", "ide", "resume", "vim"]) {
      expect(isTerminalHandoffCommand(name), name).toBe(false);
    }
  });

  it("lists skills and installed plugin commands/skills with namespaced names", async () => {
    // user skill
    const skillDir = path.join(configDir, "skills", "seo-audit");
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), "---\ndescription: SEO 감사\n---\nbody", "utf8");
    // installed plugin with one command and one skill
    const pluginPath = path.join(configDir, "plugins", "cache", "market", "tools", "1.0.0");
    await mkdir(path.join(pluginPath, "commands"), { recursive: true });
    await writeFile(path.join(pluginPath, "commands", "commit.md"), "---\ndescription: 커밋 생성\n---\n", "utf8");
    await mkdir(path.join(pluginPath, "skills", "review"), { recursive: true });
    await writeFile(path.join(pluginPath, "skills", "review", "SKILL.md"), "---\ndescription: 리뷰\n---\n", "utf8");
    await mkdir(path.join(configDir, "plugins"), { recursive: true });
    await writeFile(
      path.join(configDir, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "tools@market": [{ scope: "user", installPath: pluginPath }] } }),
      "utf8"
    );

    const commands = await listSlashCommands({ configDir, projectRoot });
    const byName = new Map(commands.map((command) => [command.name, command]));

    expect(byName.get("seo-audit")).toMatchObject({ source: "user", description: "SEO 감사" });
    expect(byName.get("tools:commit")).toMatchObject({ source: "plugin", description: "커밋 생성" });
    expect(byName.get("tools:review")).toMatchObject({ source: "plugin", description: "리뷰" });
  });
});
