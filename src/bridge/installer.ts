import { spawn } from "node:child_process";
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
  /** Things left alone because they did not look like Claude Code settings. */
  warnings: string[];
  /** No `node` on PATH: the bridge and hooks are installed but cannot run. */
  nodeMissing: boolean;
};

export const NODE_MISSING_MESSAGE =
  "Node.js was not found on PATH. The status-line bridge and Claude Code hooks run as " +
  "`node …/statusline-bridge.js`, so usage keys and session tracking stay inactive until " +
  "Node.js (https://nodejs.org) is installed and Stream Deck is restarted.";

// Bridge commands installed by any version of this plugin end in this file
// name; older installs may have used a different data dir (renamed user,
// moved LOCALAPPDATA) and must be cleaned up rather than accumulate as dead
// hooks.
const BRIDGE_COMMAND_PATTERN = /[\\/]statusline-bridge\.js"?$/;

export function isBridgeCommand(command: unknown): command is string {
  return typeof command === "string" && BRIDGE_COMMAND_PATTERN.test(command.trim());
}

let nodeOnPath: boolean | undefined;

/**
 * Whether a `node` executable is reachable from a shell the way Claude Code
 * will launch the bridge. Cached once found (a PATH does not lose node during
 * a plugin's lifetime); a miss is re-checked on the next call.
 */
export async function nodeAvailable(): Promise<boolean> {
  if (nodeOnPath) {
    return true;
  }
  const locator = process.platform === "win32" ? "where.exe" : "which";
  nodeOnPath = await new Promise<boolean>((resolve) => {
    const child = spawn(locator, ["node"], { windowsHide: true, stdio: "ignore" });
    // A missing locator says nothing about node itself; do not block on it.
    child.once("error", () => resolve(true));
    child.once("close", (code) => resolve(code === 0));
  });
  return nodeOnPath;
}

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

/**
 * Drop bridge handlers that are not the current managed command (a previous
 * data dir, a previous plugin version) from one event's groups, removing
 * groups that end up empty. Returns whether anything was removed.
 */
function removeStaleBridgeHooks(groups: HookGroup[], keepCommand: string | null): boolean {
  let removed = false;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = asRecord(groups[index]);
    const handlers = group?.hooks;
    if (!group || !Array.isArray(handlers)) {
      continue;
    }
    const kept = handlers.filter((handler) => {
      const command = asRecord(handler)?.command;
      return !(isBridgeCommand(command) && command !== keepCommand);
    });
    if (kept.length !== handlers.length) {
      removed = true;
      if (kept.length === 0) {
        groups.splice(index, 1);
      } else {
        group.hooks = kept;
      }
    }
  }
  return removed;
}

function ensureManagedHooks(
  settings: ClaudeSettings,
  managedCommand: string,
  warnings: string[]
): boolean {
  const hooks = asRecord(settings.hooks) ?? {};
  let changed = settings.hooks !== hooks;
  for (const eventName of MANAGED_HOOK_EVENTS) {
    const existing = hooks[eventName];
    if (existing !== undefined && !Array.isArray(existing)) {
      // Not the shape Claude Code documents; leave it for the user rather
      // than silently discarding whatever they put there.
      warnings.push(`hooks.${eventName} is not an array; left untouched (no bridge hook added).`);
      continue;
    }
    const existingGroups = (existing as HookGroup[] | undefined) ?? [];
    changed = removeStaleBridgeHooks(existingGroups, managedCommand) || changed;
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

/** Remove every bridge hook (managed or stale) from every event. */
function removeAllBridgeHooks(settings: ClaudeSettings): boolean {
  const hooks = asRecord(settings.hooks);
  if (!hooks) {
    return false;
  }
  let changed = false;
  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      continue;
    }
    const removed = removeStaleBridgeHooks(groups as HookGroup[], null);
    changed = removed || changed;
    if (removed && groups.length === 0) {
      delete hooks[eventName];
    }
  }
  if (changed && Object.keys(hooks).length === 0) {
    delete settings.hooks;
  }
  return changed;
}

function parseSettings(raw: string, settingsPath: string): ClaudeSettings {
  // Editors on Windows sometimes leave a BOM; JSON.parse rejects it.
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as unknown;
  const settings = asRecord(parsed);
  if (!settings) {
    throw new Error(`${settingsPath} is not a JSON object; refusing to rewrite it.`);
  }
  return settings as ClaudeSettings;
}

export async function isBridgeInstalled(settingsPath: string, dataDir: string): Promise<boolean> {
  try {
    const settings = parseSettings(await readFile(settingsPath, "utf8"), settingsPath);
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
      MANAGED_HOOK_EVENTS.every((eventName) => {
        const groups = asRecord(settings.hooks)?.[eventName];
        // An entry the installer refuses to touch (not an array) is as
        // installed as it will ever get; otherwise the key would sit on
        // SETUP and re-install on every press.
        return (groups !== undefined && !Array.isArray(groups)) || hasManagedHook(groups, managedCommand);
      })
    );
  } catch {
    return false;
  }
}

export async function isStatusLineConflict(settingsPath: string, dataDir: string): Promise<boolean> {
  try {
    const settings = parseSettings(await readFile(settingsPath, "utf8"), settingsPath);
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
  // Not a gate: Code Start must still launch Claude without Node — only the
  // bridge-backed keys go dark, which the caller reports.
  const nodeMissing = !(await nodeAvailable());
  const warnings: string[] = [];
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
  const settings = parseSettings(rawSettings, settingsPath);
  const existingStatusLine = asStatusLineSettings(settings.statusLine);
  const existingCommand = statusLineCommand(settings.statusLine);
  const existingConfig = await readBridgeConfig(configPath);
  const configuredOriginalCommand = originalCommandFromConfig(existingConfig);
  let changed = false;
  // A recorded original command only matters while the slot still holds a
  // command: once the user has removed their old status line (or it was ours
  // and got cleared), the record is spent, otherwise the managed bridge
  // could never be installed again.
  // A bridge command from another data dir (renamed user, moved
  // LOCALAPPDATA) is ours by lineage, not a foreign command to preserve.
  const slotHeldByBridge = existingCommand === managedCommand || isBridgeCommand(existingCommand);
  const originalCommand =
    existingCommand && !slotHeldByBridge
      ? existingCommand
      : slotHeldByBridge &&
          configuredOriginalCommand &&
          !isBridgeCommand(configuredOriginalCommand)
        ? configuredOriginalCommand
        : null;
  const needsManagedStatusLine = !originalCommand;
  const shouldRestoreOriginalStatusLine = slotHeldByBridge && originalCommand;
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

  changed = ensureManagedHooks(settings, managedCommand, warnings) || changed;
  if (changed) {
    await writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }

  return { changed, managedCommand, cachePath, warnings, nodeMissing };
}

export type BridgeUninstallOptions = {
  settingsPath: string;
  dataDir: string;
};

export type BridgeUninstallResult = {
  changed: boolean;
  restoredCommand: string | null;
};

/**
 * Undo everything the installer put into Claude settings: hand the
 * status-line slot back to the recorded original command (or clear it when
 * there was none) and drop every bridge hook. Cache files under the data dir
 * are left in place; they are the user's to delete.
 */
export function uninstallBridge(options: BridgeUninstallOptions): Promise<BridgeUninstallResult> {
  const run = installChain.then(() => removeBridge(options));
  installChain = run.catch(() => undefined);
  return run;
}

async function removeBridge(options: BridgeUninstallOptions): Promise<BridgeUninstallResult> {
  const { settingsPath, dataDir } = options;
  if (!(await exists(settingsPath))) {
    return { changed: false, restoredCommand: null };
  }
  const rawSettings = await readFile(settingsPath, "utf8");
  const settings = parseSettings(rawSettings, settingsPath);
  const config = await readBridgeConfig(path.join(dataDir, "bridge-config.json"));
  const originalCommand = originalCommandFromConfig(config);
  const existingStatusLine = asStatusLineSettings(settings.statusLine);
  const existingCommand = statusLineCommand(settings.statusLine);
  let changed = false;
  let restoredCommand: string | null = null;

  if (isBridgeCommand(existingCommand)) {
    if (originalCommand && !isBridgeCommand(originalCommand)) {
      const restored = { ...(existingStatusLine ?? {}), type: "command", command: originalCommand };
      delete restored.refreshInterval;
      settings.statusLine = restored;
      restoredCommand = originalCommand;
    } else {
      delete settings.statusLine;
    }
    changed = true;
  }
  changed = removeAllBridgeHooks(settings) || changed;

  if (changed) {
    await writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }
  await rm(path.join(dataDir, "bridge-config.json"), { force: true });
  return { changed, restoredCommand };
}
