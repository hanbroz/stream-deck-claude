import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

/**
 * settings.json is the user's Claude Code configuration; write it through a
 * temp file + rename so a plugin restart mid-write can never truncate it.
 */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

// Key presses on several keys can call the installer at once; serialise the
// read-modify-write so one press cannot drop another's edit.
let installChain: Promise<unknown> = Promise.resolve();

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

export function ensureBridgeInstalled(
  options: BridgeInstallOptions
): Promise<BridgeInstallResult> {
  const run = installChain.then(() => installBridge(options));
  installChain = run.catch(() => undefined);
  return run;
}

async function installBridge(options: BridgeInstallOptions): Promise<BridgeInstallResult> {
  const { settingsPath, dataDir, bridgeSourcePath } = options;
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const bridgeDestination = path.join(dataDir, "statusline-bridge.js");
  const configPath = path.join(dataDir, "bridge-config.json");
  const cachePath = path.join(dataDir, "usage.json");
  const managedCommand = managedBridgeCommand(dataDir);
  await copyFile(bridgeSourcePath, bridgeDestination);
  // The bridge is an ES module; the package.json beside the source marks it
  // as such for whichever `node` is on PATH (Node 20 and 22.0–22.6 do not
  // detect module syntax on their own, and would refuse the bare .js file).
  const modulePackagePath = path.join(path.dirname(bridgeSourcePath), "package.json");
  if (await exists(modulePackagePath)) {
    await copyFile(modulePackagePath, path.join(dataDir, "package.json"));
  } else {
    await writeFile(path.join(dataDir, "package.json"), '{ "type": "module" }\n', "utf8");
  }

  const rawSettings = (await exists(settingsPath))
    ? await readFile(settingsPath, "utf8")
    : "{}";
  const settings = JSON.parse(rawSettings) as ClaudeSettings;
  const existingStatusLine = asStatusLineSettings(settings.statusLine);
  const existingCommand = statusLineCommand(settings.statusLine);
  const existingConfig = await readBridgeConfig(configPath);
  const configuredOriginalCommand = originalCommandFromConfig(existingConfig);
  let changed = false;
  // A recorded original command only matters while the slot still holds a
  // command: once the user has removed their old status line (or it was ours
  // and got cleared), the record is spent, otherwise the managed bridge
  // could never be installed again.
  const originalCommand =
    existingCommand && existingCommand !== managedCommand
      ? existingCommand
      : existingCommand === managedCommand &&
          configuredOriginalCommand &&
          configuredOriginalCommand !== managedCommand
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
    await writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }

  return { changed, managedCommand, cachePath };
}
