import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ensureBridgeInstalled,
  isBridgeInstalled,
  isStatusLineConflict
} from "../src/bridge/installer";

describe("ensureBridgeInstalled", () => {
  it("preserves an existing status-line command in the Claude settings slot and is idempotent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-usage-deck-"));
    const claudeDir = path.join(root, ".claude");
    const dataDir = path.join(root, "data");
    const settingsPath = path.join(claudeDir, "settings.json");
    const bridgeSourcePath = path.join(root, "statusline-bridge.js");
    const omcCommand = '"C:/Program Files/nodejs/node.exe" "C:/Users/이도한/.claude/hud/omc-hud.mjs"';
    await writeFile(bridgeSourcePath, "console.log('bridge');\n", "utf8");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(claudeDir, { recursive: true }));
    await writeFile(
      settingsPath,
      JSON.stringify({
        statusLine: {
          type: "command",
          command: omcCommand,
          padding: 2
        },
        hooks: {
          Stop: [
            {
              hooks: [{ type: "command", command: "node C:/existing/stop-hook.mjs" }]
            }
          ]
        }
      }),
      "utf8"
    );

    const first = await ensureBridgeInstalled({ settingsPath, dataDir, bridgeSourcePath });
    const second = await ensureBridgeInstalled({ settingsPath, dataDir, bridgeSourcePath });
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    const config = JSON.parse(await readFile(path.join(dataDir, "bridge-config.json"), "utf8"));
    const installedStatus = await isBridgeInstalled(settingsPath, dataDir);
    const conflict = await isStatusLineConflict(settingsPath, dataDir);

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(installedStatus).toBe(false);
    expect(conflict).toBe(true);
    expect(settings.statusLine.padding).toBe(2);
    expect(settings.statusLine.command).toBe(omcCommand);
    expect(settings.statusLine.refreshInterval).toBeUndefined();
    for (const eventName of [
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "StopFailure",
      "Notification",
      "SessionEnd"
    ]) {
      const commands = settings.hooks[eventName].flatMap((group: { hooks: Array<{ command?: string }> }) =>
        group.hooks.map((hook) => hook.command)
      );
      expect(commands.filter((command: string) => command === first.managedCommand)).toHaveLength(1);
    }
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("node C:/existing/stop-hook.mjs");
    expect(config.originalCommand).toBe(omcCommand);
    expect(await readFile(`${settingsPath}.claude-usage-deck.bak`, "utf8")).toContain("omc-hud.mjs");
  });

  it("restores the original status-line command when an older bridge owns the slot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-usage-deck-"));
    const claudeDir = path.join(root, ".claude");
    const dataDir = path.join(root, "data");
    const settingsPath = path.join(claudeDir, "settings.json");
    const bridgeSourcePath = path.join(root, "statusline-bridge.js");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(claudeDir, { recursive: true }));
    await writeFile(bridgeSourcePath, "console.log('bridge');\n", "utf8");
    await writeFile(
      settingsPath,
      JSON.stringify({
        statusLine: { type: "command", command: "node C:/existing/hud.mjs" }
      }),
      "utf8"
    );

    const installed = await ensureBridgeInstalled({ settingsPath, dataDir, bridgeSourcePath });
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    settings.statusLine = {
      type: "command",
      command: installed.managedCommand,
      refreshInterval: 1
    };
    await writeFile(settingsPath, JSON.stringify(settings), "utf8");
    const needsRestore = await isBridgeInstalled(settingsPath, dataDir);

    const upgraded = await ensureBridgeInstalled({ settingsPath, dataDir, bridgeSourcePath });
    const upgradedSettings = JSON.parse(await readFile(settingsPath, "utf8"));
    const config = JSON.parse(await readFile(path.join(dataDir, "bridge-config.json"), "utf8"));
    const unchanged = await ensureBridgeInstalled({ settingsPath, dataDir, bridgeSourcePath });
    const restoredStatus = await isBridgeInstalled(settingsPath, dataDir);
    const restoredConflict = await isStatusLineConflict(settingsPath, dataDir);

    expect(needsRestore).toBe(false);
    expect(upgraded.changed).toBe(true);
    expect(upgradedSettings.statusLine.command).toBe("node C:/existing/hud.mjs");
    expect(upgradedSettings.statusLine.refreshInterval).toBeUndefined();
    expect(config.originalCommand).toBe("node C:/existing/hud.mjs");
    expect(restoredStatus).toBe(false);
    expect(restoredConflict).toBe(true);
    expect(unchanged.changed).toBe(false);
  });

  it("uses the managed status-line bridge when no external command exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-usage-deck-"));
    const claudeDir = path.join(root, ".claude");
    const dataDir = path.join(root, "data");
    const settingsPath = path.join(claudeDir, "settings.json");
    const bridgeSourcePath = path.join(root, "statusline-bridge.js");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(claudeDir, { recursive: true }));
    await writeFile(bridgeSourcePath, "console.log('bridge');\n", "utf8");
    await writeFile(settingsPath, JSON.stringify({ statusLine: { padding: 1 } }), "utf8");

    const installed = await ensureBridgeInstalled({ settingsPath, dataDir, bridgeSourcePath });
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    const config = JSON.parse(await readFile(path.join(dataDir, "bridge-config.json"), "utf8"));
    const unchanged = await ensureBridgeInstalled({ settingsPath, dataDir, bridgeSourcePath });
    const installedStatus = await isBridgeInstalled(settingsPath, dataDir);

    expect(installed.changed).toBe(true);
    expect(installedStatus).toBe(true);
    expect(settings.statusLine.padding).toBe(1);
    expect(settings.statusLine.command).toBe(installed.managedCommand);
    expect(settings.statusLine.refreshInterval).toBe(1);
    expect(config.originalCommand).toBeNull();
    expect(unchanged.changed).toBe(false);
  });

  it("handles malformed status-line settings without crashing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-usage-deck-"));
    const claudeDir = path.join(root, ".claude");
    const dataDir = path.join(root, "data");
    const settingsPath = path.join(claudeDir, "settings.json");
    const bridgeSourcePath = path.join(root, "statusline-bridge.js");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(claudeDir, { recursive: true }));
    await writeFile(bridgeSourcePath, "console.log('bridge');\n", "utf8");
    await writeFile(settingsPath, JSON.stringify({ statusLine: "unexpected" }), "utf8");

    const installed = await ensureBridgeInstalled({ settingsPath, dataDir, bridgeSourcePath });
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));

    expect(installed.changed).toBe(true);
    expect(settings.statusLine).toEqual({
      type: "command",
      command: installed.managedCommand,
      refreshInterval: 1
    });
  });
});
