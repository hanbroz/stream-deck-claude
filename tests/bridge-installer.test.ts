import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ensureBridgeInstalled,
  isBridgeInstalled,
  isStatusLineConflict,
  uninstallBridge
} from "../src/bridge/installer";

async function scaffold() {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-usage-deck-"));
  const claudeDir = path.join(root, ".claude");
  const dataDir = path.join(root, "data");
  const settingsPath = path.join(claudeDir, "settings.json");
  const bridgeSourcePath = path.join(root, "statusline-bridge.js");
  await writeFile(bridgeSourcePath, "console.log('bridge');\n", "utf8");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(claudeDir, { recursive: true }));
  return { root, claudeDir, dataDir, settingsPath, bridgeSourcePath };
}

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

  it("installs the managed bridge once the recorded original command has left the slot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-usage-deck-"));
    const claudeDir = path.join(root, ".claude");
    const dataDir = path.join(root, "data");
    const settingsPath = path.join(claudeDir, "settings.json");
    const bridgeSourcePath = path.join(root, "statusline-bridge.js");
    await writeFile(bridgeSourcePath, "console.log('bridge');\n", "utf8");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(claudeDir, { recursive: true }));
    await import("node:fs/promises").then(({ mkdir }) => mkdir(dataDir, { recursive: true }));
    // An earlier install recorded OMC as the original command…
    await writeFile(
      path.join(dataDir, "bridge-config.json"),
      JSON.stringify({ schemaVersion: 1, originalCommand: "node C:/omc/hud.mjs", installedAt: 1 }),
      "utf8"
    );
    // …but the user has since removed their status line entirely.
    await writeFile(settingsPath, JSON.stringify({ permissions: {} }), "utf8");

    const result = await ensureBridgeInstalled({ settingsPath, dataDir, bridgeSourcePath });
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(result.changed).toBe(true);
    expect(settings.statusLine.command).toBe(result.managedCommand);
    expect(await isBridgeInstalled(settingsPath, dataDir)).toBe(true);
    // The bridge runs as an ES module under whatever node is on PATH.
    expect(JSON.parse(await readFile(path.join(dataDir, "package.json"), "utf8"))).toEqual({ type: "module" });
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

describe("ensureBridgeInstalled hygiene", () => {
  it("replaces bridge hooks left by an older data dir instead of accumulating them", async () => {
    const { dataDir, settingsPath, bridgeSourcePath } = await scaffold();
    const stale = 'node "C:/Users/old-name/AppData/Local/ClaudeUsageDeck/statusline-bridge.js"';
    await writeFile(
      settingsPath,
      JSON.stringify({
        statusLine: { type: "command", command: stale, refreshInterval: 1 },
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: stale, timeout: 5 }] },
            { hooks: [{ type: "command", command: "node C:/existing/stop-hook.mjs" }] }
          ]
        }
      }),
      "utf8"
    );

    const result = await ensureBridgeInstalled({ settingsPath, dataDir, bridgeSourcePath });
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    const stopCommands = settings.hooks.Stop.flatMap((g: { hooks: Array<{ command: string }> }) =>
      g.hooks.map((h) => h.command)
    );
    expect(stopCommands).toEqual(["node C:/existing/stop-hook.mjs", result.managedCommand]);
    // The stale bridge in the slot is ours by lineage, not a foreign command
    // to preserve: the managed bridge takes the slot.
    expect(settings.statusLine.command).toBe(result.managedCommand);
    expect(result.warnings).toEqual([]);
  });

  it("tolerates a BOM and refuses a settings file that is not an object", async () => {
    const { dataDir, settingsPath, bridgeSourcePath } = await scaffold();
    await writeFile(settingsPath, "\uFEFF" + JSON.stringify({ permissions: {} }), "utf8");
    await expect(ensureBridgeInstalled({ settingsPath, dataDir, bridgeSourcePath })).resolves.toMatchObject({
      changed: true
    });
    expect(JSON.parse(await readFile(settingsPath, "utf8")).permissions).toEqual({});

    await writeFile(settingsPath, "[]", "utf8");
    await expect(ensureBridgeInstalled({ settingsPath, dataDir, bridgeSourcePath })).rejects.toThrow(
      "not a JSON object"
    );
    expect(await readFile(settingsPath, "utf8")).toBe("[]");
  });

  it("leaves a malformed hooks entry alone and reports it", async () => {
    const { dataDir, settingsPath, bridgeSourcePath } = await scaffold();
    await writeFile(settingsPath, JSON.stringify({ hooks: { Stop: { oops: true } } }), "utf8");

    const result = await ensureBridgeInstalled({ settingsPath, dataDir, bridgeSourcePath });
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.hooks.Stop).toEqual({ oops: true });
    expect(result.warnings).toEqual([
      "hooks.Stop is not an array; left untouched (no bridge hook added)."
    ]);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(result.managedCommand);
  });
});

describe("uninstallBridge", () => {
  it("hands the slot back to the recorded command and removes every bridge hook", async () => {
    const { dataDir, settingsPath, bridgeSourcePath } = await scaffold();
    const omcCommand = "node C:/omc/hud.mjs";
    // Older bridge owns the slot with OMC recorded as the original.
    await writeFile(
      settingsPath,
      JSON.stringify({
        statusLine: { type: "command", command: omcCommand, padding: 2 },
        hooks: { Stop: [{ hooks: [{ type: "command", command: "node C:/existing/stop-hook.mjs" }] }] }
      }),
      "utf8"
    );
    await ensureBridgeInstalled({ settingsPath, dataDir, bridgeSourcePath });
    // Simulate an older install that took the slot itself.
    const installed = JSON.parse(await readFile(settingsPath, "utf8"));
    const managed = installed.hooks.SessionStart[0].hooks[0].command;
    installed.statusLine = { type: "command", command: managed, refreshInterval: 1, padding: 2 };
    await writeFile(settingsPath, JSON.stringify(installed), "utf8");

    const result = await uninstallBridge({ settingsPath, dataDir });
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(result).toEqual({ changed: true, restoredCommand: omcCommand });
    expect(settings.statusLine).toEqual({ type: "command", command: omcCommand, padding: 2 });
    expect(settings.hooks).toEqual({
      Stop: [{ hooks: [{ type: "command", command: "node C:/existing/stop-hook.mjs" }] }]
    });
    expect(await isBridgeInstalled(settingsPath, dataDir)).toBe(false);
    // Idempotent.
    await expect(uninstallBridge({ settingsPath, dataDir })).resolves.toEqual({
      changed: false,
      restoredCommand: null
    });
  });

  it("clears the slot when there was no original command", async () => {
    const { dataDir, settingsPath, bridgeSourcePath } = await scaffold();
    await writeFile(settingsPath, "{}", "utf8");
    await ensureBridgeInstalled({ settingsPath, dataDir, bridgeSourcePath });
    expect(await isBridgeInstalled(settingsPath, dataDir)).toBe(true);

    await uninstallBridge({ settingsPath, dataDir });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({});
  });
});
