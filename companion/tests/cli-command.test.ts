import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runBridgedCliCommand } from "../main/cli-command";
import { isBridgedCliCommand, splitArguments } from "../shared/slash-commands";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "companion-cli-command-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("isBridgedCliCommand", () => {
  it("accepts only the commands the CLI serves outside print mode", () => {
    expect(isBridgedCliCommand("plugin")).toBe(true);
    expect(isBridgedCliCommand("mcp")).toBe(true);
    // Pure TUI, and `claude agents` is a different feature entirely.
    for (const name of ["config", "vim", "agents", "compact", "clear"]) {
      expect(isBridgedCliCommand(name)).toBe(false);
    }
  });
});

describe("splitArguments", () => {
  it("splits on whitespace", () => {
    expect(splitArguments("marketplace remove eastarjet-harness")).toEqual([
      "marketplace",
      "remove",
      "eastarjet-harness"
    ]);
  });

  it("keeps quoted arguments whole and drops the quotes", () => {
    expect(splitArguments(`add "my server" --scope user`)).toEqual([
      "add",
      "my server",
      "--scope",
      "user"
    ]);
    expect(splitArguments("add 'other server'")).toEqual(["add", "other server"]);
  });

  it("preserves an explicitly empty argument", () => {
    expect(splitArguments('set name ""')).toEqual(["set", "name", ""]);
  });

  it("collapses padding and returns nothing for a blank line", () => {
    expect(splitArguments("   list   ")).toEqual(["list"]);
    expect(splitArguments("   ")).toEqual([]);
  });

  it("treats shell metacharacters as ordinary text", () => {
    // No shell is involved downstream, so these stay a single literal argument
    // instead of chaining a second command.
    expect(splitArguments("remove a;rm -rf /")).toEqual(["remove", "a;rm", "-rf", "/"]);
  });
});

describe("runBridgedCliCommand", () => {
  it("refuses a command outside the allowlist", async () => {
    await expect(
      runBridgedCliCommand({ claudePath: "claude", cwd: process.cwd() }, "config", "")
    ).rejects.toThrow(/not a bridged CLI command/u);
  });

  it("hands arguments to the child as argv, never through a shell", async () => {
    // node resolves a bare "plugin" against cwd and runs it as CommonJS, which
    // gives a stand-in for the claude CLI that reports its own argv back.
    const cwd = await makeTemporaryDirectory();
    await writeFile(
      path.join(cwd, "plugin"),
      'console.log(JSON.stringify(process.argv.slice(2)));console.error("notice");',
      "utf8"
    );

    const result = await runBridgedCliCommand(
      { claudePath: process.execPath, cwd },
      "plugin",
      'marketplace remove "a;rm -rf /"'
    );

    expect(result.ok).toBe(true);
    // The semicolon stays inside one argument instead of starting a command.
    expect(JSON.parse(result.output.split("\n")[0])).toEqual([
      "marketplace",
      "remove",
      "a;rm -rf /"
    ]);
    // stderr is part of the answer even on success.
    expect(result.output).toContain("notice");
  });

  it("returns the CLI's own error text with an exit failure instead of throwing", async () => {
    const cwd = await makeTemporaryDirectory();
    await writeFile(
      path.join(cwd, "mcp"),
      'console.log("out");console.error("boom");process.exit(3);',
      "utf8"
    );

    await expect(
      runBridgedCliCommand({ claudePath: process.execPath, cwd }, "mcp", "")
    ).resolves.toEqual({ ok: false, failure: "exit", output: "out\nboom" });
  });

  it("marks an unlaunchable CLI as a spawn failure rather than an exit code", async () => {
    const cwd = await makeTemporaryDirectory();

    const result = await runBridgedCliCommand(
      { claudePath: path.join(cwd, "definitely-not-here"), cwd },
      "plugin",
      "list"
    );

    expect(result.ok).toBe(false);
    // Without this the renderer cannot tell "claude is missing" from "the
    // command ran and failed", and shows the raw errno either way.
    expect(result.failure).toBe("spawn");
  });
});
