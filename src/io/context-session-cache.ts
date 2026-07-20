import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ActiveCodeLaunch,
  CodeStartDisplayState,
  ContextSessionRuntime,
  ContextSessionSnapshot
} from "../domain/context-session";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function actionSessionDir(dataDir: string, actionId: string): string {
  return path.join(dataDir, "context-sessions", digest(actionId));
}

function sameFolder(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

export function activeLaunchPath(dataDir: string, actionId: string): string {
  return path.join(actionSessionDir(dataDir, actionId), "active.json");
}

export function contextSessionSnapshotPath(
  dataDir: string,
  actionId: string,
  launchId: string
): string {
  return path.join(actionSessionDir(dataDir, actionId), `${digest(launchId)}.json`);
}

export function contextSessionRuntimePath(
  dataDir: string,
  actionId: string,
  launchId: string
): string {
  return path.join(actionSessionDir(dataDir, actionId), `${digest(launchId)}.state.json`);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

export async function writeActiveLaunch(
  dataDir: string,
  launch: ActiveCodeLaunch
): Promise<void> {
  await writeJsonAtomic(activeLaunchPath(dataDir, launch.actionId), launch);
}

export async function writeContextSessionSnapshot(
  dataDir: string,
  snapshot: ContextSessionSnapshot
): Promise<void> {
  await writeJsonAtomic(
    contextSessionSnapshotPath(dataDir, snapshot.actionId, snapshot.launchId),
    snapshot
  );
}

export async function writeContextSessionRuntime(
  dataDir: string,
  runtime: ContextSessionRuntime
): Promise<void> {
  await writeJsonAtomic(
    contextSessionRuntimePath(dataDir, runtime.actionId, runtime.launchId),
    runtime
  );
}

function parseActiveLaunch(value: unknown): ActiveCodeLaunch {
  const root = asRecord(value);
  if (
    root?.schemaVersion !== 2 ||
    typeof root.actionId !== "string" ||
    typeof root.launchId !== "string" ||
    typeof root.folder !== "string" ||
    typeof root.startedAt !== "number" ||
    (root.terminal !== "windows-terminal" && root.terminal !== "powershell") ||
    typeof root.processId !== "number" ||
    !Number.isInteger(root.processId) ||
    root.processId <= 0
  ) {
    throw new Error("Invalid active Code Start launch");
  }
  return {
    schemaVersion: 2,
    actionId: root.actionId,
    launchId: root.launchId,
    folder: root.folder,
    startedAt: root.startedAt,
    terminal: root.terminal,
    processId: root.processId
  };
}

function parseSnapshot(value: unknown): ContextSessionSnapshot {
  const root = asRecord(value);
  const context = asRecord(root?.context);
  const percentage = context?.usedPercentage;
  if (
    root?.schemaVersion !== 1 ||
    typeof root.actionId !== "string" ||
    typeof root.launchId !== "string" ||
    typeof root.sessionId !== "string" ||
    typeof root.capturedAt !== "number" ||
    !context ||
    (percentage !== null &&
      (typeof percentage !== "number" ||
        !Number.isFinite(percentage) ||
        percentage < 0 ||
        percentage > 100))
  ) {
    throw new Error("Invalid Code Start context snapshot");
  }

  return {
    schemaVersion: 1,
    actionId: root.actionId,
    launchId: root.launchId,
    sessionId: root.sessionId,
    ...(typeof root.projectDir === "string" ? { projectDir: root.projectDir } : {}),
    capturedAt: root.capturedAt,
    context: {
      usedPercentage: percentage,
      ...(typeof context.totalInputTokens === "number"
        ? { totalInputTokens: context.totalInputTokens }
        : {}),
      ...(typeof context.contextWindowSize === "number"
        ? { contextWindowSize: context.contextWindowSize }
        : {})
    }
  };
}

function parseRuntime(value: unknown): ContextSessionRuntime {
  const root = asRecord(value);
  if (
    root?.schemaVersion !== 1 ||
    typeof root.actionId !== "string" ||
    typeof root.launchId !== "string" ||
    (root.activity !== "waiting" &&
      root.activity !== "running" &&
      root.activity !== "responding") ||
    typeof root.capturedAt !== "number"
  ) {
    throw new Error("Invalid Code Start runtime state");
  }
  return {
    schemaVersion: 1,
    actionId: root.actionId,
    launchId: root.launchId,
    activity: root.activity,
    capturedAt: root.capturedAt
  };
}

async function readJson(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function findReconnectableBindingId(
  dataDir: string,
  folder: string,
  unavailableBindingIds: ReadonlySet<string> = new Set<string>()
): Promise<string | undefined> {
  const sessionsDir = path.join(dataDir, "context-sessions");
  let entries;
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry): Promise<string | undefined> => {
        try {
          const value = await readJson(path.join(sessionsDir, entry.name, "active.json"));
          if (!value || asRecord(value)?.schemaVersion === 1) {
            return undefined;
          }
          const active = parseActiveLaunch(value);
          if (
            entry.name !== digest(active.actionId) ||
            unavailableBindingIds.has(active.actionId) ||
            !sameFolder(active.folder, folder) ||
            !isProcessRunning(active.processId)
          ) {
            return undefined;
          }
          return active.actionId;
        } catch {
          return undefined;
        }
      })
  );
  const uniqueCandidates = [...new Set(candidates.filter((value) => value !== undefined))];
  return uniqueCandidates.length === 1 ? uniqueCandidates[0] : undefined;
}

export async function loadCodeStartDisplayState(
  dataDir: string,
  actionId: string,
  folder: string
): Promise<CodeStartDisplayState> {
  try {
    const activeValue = await readJson(activeLaunchPath(dataDir, actionId));
    if (!activeValue) {
      return { kind: "idle", activity: "waiting" };
    }
    const activeRecord = asRecord(activeValue);
    if (activeRecord?.schemaVersion === 1) {
      return { kind: "idle", activity: "waiting" };
    }
    const active = parseActiveLaunch(activeValue);
    if (active.actionId !== actionId) {
      return { kind: "error", activity: "waiting" };
    }
    if (!sameFolder(active.folder, folder)) {
      return { kind: "idle", activity: "waiting" };
    }
    if (!isProcessRunning(active.processId)) {
      return { kind: "closed", activity: "waiting" };
    }

    const runtimeValue = await readJson(
      contextSessionRuntimePath(dataDir, actionId, active.launchId)
    );
    const runtime = runtimeValue === undefined ? undefined : parseRuntime(runtimeValue);
    const activity =
      runtime?.actionId === actionId && runtime.launchId === active.launchId
        ? runtime.activity
        : "running";
    if (activity === "waiting") {
      return { kind: "closed", activity: "waiting" };
    }

    const snapshotValue = await readJson(
      contextSessionSnapshotPath(dataDir, actionId, active.launchId)
    );
    if (!snapshotValue) {
      return { kind: "starting", activity };
    }
    const snapshot = parseSnapshot(snapshotValue);
    if (
      snapshot.actionId !== actionId ||
      snapshot.launchId !== active.launchId ||
      snapshot.context.usedPercentage === null
    ) {
      return { kind: "starting", activity };
    }
    return {
      kind: "ready",
      percentage: Math.round(snapshot.context.usedPercentage),
      activity
    };
  } catch {
    return { kind: "error", activity: "waiting" };
  }
}
