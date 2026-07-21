import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ensureBridgeInstalled } from "../src/bridge/installer";

describe("ensureBridgeInstalled", () => {
  it("preserves an existing status-line command and is idempotent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-usage-deck-"));
    const claudeDir = path.join(root, ".claude");
    const dataDir = path.join(root, "data");
    const settingsPath = path.join(claudeDir, "settings.json");
    const bridgeSourcePath = path.join(root, "statusline-bridge.js");
    await writeFile(bridgeSourcePath, "console.log('bridge');\n", "utf8");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(claudeDir, { recursive: true }));
    await writeFile(
      settingsPath,
      JSON.stringify({
        statusLine: {
          type: "command",
          command: "node C:/existing/hud.mjs",
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

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(settings.statusLine.padding).toBe(2);
    expect(settings.statusLine.command).toBe(first.managedCommand);
    expect(settings.statusLine.refreshInterval).toBe(1);
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
    expect(config.originalCommand).toBe("node C:/existing/hud.mjs");
    expect(await readFile(`${settingsPath}.claude-usage-deck.bak`, "utf8")).toContain("existing/hud.mjs");
  });

  it("upgrades an installed bridge refresh interval without forwarding to itself", async () => {
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
    delete settings.statusLine.refreshInterval;
    await writeFile(settingsPath, JSON.stringify(settings), "utf8");

    const upgraded = await ensureBridgeInstalled({ settingsPath, dataDir, bridgeSourcePath });
    const upgradedSettings = JSON.parse(await readFile(settingsPath, "utf8"));
    const config = JSON.parse(await readFile(path.join(dataDir, "bridge-config.json"), "utf8"));
    const unchanged = await ensureBridgeInstalled({ settingsPath, dataDir, bridgeSourcePath });

    expect(upgraded.changed).toBe(true);
    expect(upgradedSettings.statusLine.command).toBe(installed.managedCommand);
    expect(upgradedSettings.statusLine.refreshInterval).toBe(1);
    expect(config.originalCommand).toBe("node C:/existing/hud.mjs");
    expect(unchanged.changed).toBe(false);
  });
});
