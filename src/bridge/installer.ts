import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type StatusLineSettings = {
  type?: string;
  command?: string;
  refreshInterval?: number;
  [key: string]: unknown;
};

type HookHandler = {
  type?: string;
  command?: string;
  [key: string]: unknown;
};

type HookGroup = {
  hooks?: HookHandler[];
  [key: string]: unknown;
};

type ClaudeHooks = Record<string, unknown>;

type ClaudeSettings = {
  statusLine?: unknown;
  hooks?: ClaudeHooks;
  [key: string]: unknown;
};

type BridgeConfig = {
  schemaVersion?: number;
  originalCommand?: string | null;
  installedAt?: number;
};

const MANAGED_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "Notification",
  "SessionEnd"
] as const;
const STATUS_LINE_REFRESH_INTERVAL_SECONDS = 1;

export type BridgeInstallOptions = {
  settingsPath: string;
  dataDir: string;
  bridgeSourcePath: string;
};

export type BridgeInstallResult = {
  changed: boolean;
  managedCommand: string;
  cachePath: string;
};

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function nodeCommand(scriptPath: string): string {
  return `node "${scriptPath.replaceAll("\\", "/")}"`;
}

export function managedBridgeCommand(dataDir: string): string {
  return nodeCommand(path.join(dataDir, "statusline-bridge.js"));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asStatusLineSettings(value: unknown): StatusLineSettings | undefined {
  return asRecord(value) as StatusLineSettings | undefined;
}

function statusLineCommand(value: unknown): string | undefined {
  const command = asStatusLineSettings(value)?.command;
  return typeof command === "string" && command.length > 0 ? command : undefined;
}

async function readBridgeConfig(configPath: string): Promise<BridgeConfig> {
  try {
    return JSON.parse(await readFile(configPath, "utf8")) as BridgeConfig;
  } catch {
    return {};
  }
}

function originalCommandFromConfig(config: BridgeConfig): string | null {
  return typeof config.originalCommand === "string" && config.originalCommand.length > 0
    ? config.originalCommand
    : null;
}

function hasManagedHook(groups: unknown, managedCommand: string): boolean {
  if (!Array.isArray(groups)) {
    return false;
  }
  return groups.some((group) => {
    const handlers = asRecord(group)?.hooks;
    return Array.isArray(handlers) && handlers.some((handler) => {
      return asRecord(handler)?.command === managedCommand;
    });
  });
}

function ensureManagedHooks(settings: ClaudeSettings, managedCommand: string): boolean {
  const hooks = asRecord(settings.hooks) ?? {};
  let changed = settings.hooks !== hooks;
  for (const eventName of MANAGED_HOOK_EVENTS) {
    const existingGroups = Array.isArray(hooks[eventName])
      ? (hooks[eventName] as HookGroup[])
      : [];
    if (!hasManagedHook(existingGroups, managedCommand)) {
      existingGroups.push({
        hooks: [
          {
            type: "command",
            command: managedCommand,
            timeout: 5
          }
        ]
      });
      changed = true;
    }
    hooks[eventName] = existingGroups;
  }
  settings.hooks = hooks;
  return changed;
}

export async function isBridgeInstalled(settingsPath: string, dataDir: string): Promise<boolean> {
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as ClaudeSettings;
    const managedCommand = managedBridgeCommand(dataDir);
    const currentCommand = statusLineCommand(settings.statusLine);
    const config = await readBridgeConfig(path.join(dataDir, "bridge-config.json"));
    const originalCommand = originalCommandFromConfig(config);
    const statusLineInstalled =
      (
        currentCommand === managedCommand &&
        originalCommand === null &&
        asStatusLineSettings(settings.statusLine)?.refreshInterval === STATUS_LINE_REFRESH_INTERVAL_SECONDS
      );
    return (
      statusLineInstalled &&
      MANAGED_HOOK_EVENTS.every((eventName) =>
        hasManagedHook(asRecord(settings.hooks)?.[eventName], managedCommand)
      )
    );
  } catch {
    return false;
  }
}

export async function isStatusLineConflict(settingsPath: string, dataDir: string): Promise<boolean> {
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as ClaudeSettings;
    const currentCommand = statusLineCommand(settings.statusLine);
    return currentCommand !== undefined && currentCommand !== managedBridgeCommand(dataDir);
  } catch {
    return false;
  }
}

export async function ensureBridgeInstalled(
  options: BridgeInstallOptions
): Promise<BridgeInstallResult> {
  const { settingsPath, dataDir, bridgeSourcePath } = options;
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const bridgeDestination = path.join(dataDir, "statusline-bridge.js");
  const configPath = path.join(dataDir, "bridge-config.json");
  const cachePath = path.join(dataDir, "usage.json");
  const managedCommand = managedBridgeCommand(dataDir);
  await copyFile(bridgeSourcePath, bridgeDestination);

  const rawSettings = (await exists(settingsPath))
    ? await readFile(settingsPath, "utf8")
    : "{}";
  const settings = JSON.parse(rawSettings) as ClaudeSettings;
  const existingStatusLine = asStatusLineSettings(settings.statusLine);
  const existingCommand = statusLineCommand(settings.statusLine);
  const existingConfig = await readBridgeConfig(configPath);
  const configuredOriginalCommand = originalCommandFromConfig(existingConfig);
  let changed = false;
  const originalCommand =
    existingCommand && existingCommand !== managedCommand
      ? existingCommand
      : configuredOriginalCommand && configuredOriginalCommand !== managedCommand
        ? configuredOriginalCommand
        : null;
  const needsManagedStatusLine = !originalCommand;
  const shouldRestoreOriginalStatusLine = existingCommand === managedCommand && originalCommand;
  const managedRefreshIntervalChanged =
    needsManagedStatusLine &&
    existingStatusLine?.refreshInterval !== STATUS_LINE_REFRESH_INTERVAL_SECONDS;
  const statusLineCommandChanged =
    shouldRestoreOriginalStatusLine || (needsManagedStatusLine && existingCommand !== managedCommand);
  const configChanged = existingConfig.originalCommand !== originalCommand;

  if (statusLineCommandChanged || managedRefreshIntervalChanged || configChanged) {
    const backupPath = `${settingsPath}.claude-usage-deck.bak`;
    if (!(await exists(backupPath))) {
      await writeFile(backupPath, rawSettings, "utf8");
    }

    if (configChanged) {
      await writeFile(
        configPath,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            originalCommand,
            installedAt: Date.now()
          },
          null,
          2
        )}\n`,
        "utf8"
      );
    }

    if (shouldRestoreOriginalStatusLine) {
      const restoredStatusLine = {
        ...(existingStatusLine ?? {}),
        type: "command",
        command: originalCommand
      };
      delete restoredStatusLine.refreshInterval;
      settings.statusLine = restoredStatusLine;
    } else if (needsManagedStatusLine && (statusLineCommandChanged || managedRefreshIntervalChanged)) {
      settings.statusLine = {
        ...(existingStatusLine ?? {}),
        type: "command",
        command: managedCommand,
        refreshInterval: STATUS_LINE_REFRESH_INTERVAL_SECONDS
      };
    }
    changed = true;
  }

  changed = ensureManagedHooks(settings, managedCommand) || changed;
  if (changed) {
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }

  return { changed, managedCommand, cachePath };
}
