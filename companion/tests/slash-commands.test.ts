import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applySlashCommand, filterSlashCommands, type SlashCommand } from "../shared/slash-commands";
import { listSlashCommands } from "../main/slash-commands";

const COMMANDS: SlashCommand[] = [
  { name: "clear", description: "새 대화 시작", source: "builtin" },
  { name: "review", source: "project" },
  { name: "release", source: "user" }
];

describe("slash command filtering", () => {
  it("shows the menu only while typing a single slash token", () => {
    expect(filterSlashCommands(COMMANDS, "/")?.map((c) => c.name)).toEqual(["clear", "review", "release"]);
    expect(filterSlashCommands(COMMANDS, "/re")?.map((c) => c.name)).toEqual(["review", "release"]);
    expect(filterSlashCommands(COMMANDS, "/REV")?.map((c) => c.name)).toEqual(["review"]);
    // Not a command draft: plain text, args already present, or no match.
    expect(filterSlashCommands(COMMANDS, "hello")).toBeNull();
    expect(filterSlashCommands(COMMANDS, "/clear now")).toBeNull();
    expect(filterSlashCommands(COMMANDS, "/nope")).toBeNull();
    expect(filterSlashCommands(COMMANDS, "")).toBeNull();
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

  it("returns only builtins when no commands directories exist", async () => {
    const commands = await listSlashCommands({ configDir, projectRoot });
    expect(commands.map((command) => command.name)).toEqual(["clear"]);
  });
});
