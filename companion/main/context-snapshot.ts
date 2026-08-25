import { mkdir, rename, writeFile } from "node:fs/promises";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import { parseModelId } from "../shared/model-name";

/**
 * The Stream Deck Code Start key shows the running model and context usage by
 * reading a snapshot the statusline bridge writes. That bridge only fires for an
 * interactive TUI status line, which a `--print` Companion session never
 * renders — so the key would sit at "MODEL --". The Companion already derives
 * model and context from the stream, so it writes the same snapshot itself and
 * the key comes to life.
 *
 * The record shape and hashed path must match src/io/context-session-cache.ts
 * (parseSnapshot / contextSessionSnapshotPath).
 */
export type ContextSnapshotInput = {
  dataDir: string;
  bindingId: string;
  launchId: string;
  sessionId: string;
  projectDir?: string;
  model?: string;
  /** null = usage not known yet (fresh launch, no message run); the key shows "--". */
  usedTokens: number | null;
  windowTokens: number;
  capturedAt: number;
};

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Format a raw model id like `claude-opus-4-8[1m]` as `Opus 4.8` for the key. */
export function displayModelName(model: string | undefined): string | undefined {
  return parseModelId(model)?.label;
}

/**
 * The session id a key snapshot should carry.
 *
 * A live conversation wins; the launch id is the placeholder until one exists.
 *
 * There used to be a third source between them — the folder's resume id, which
 * kept the key useful before the first message, guarded by a `conversationEnded`
 * flag so an ended conversation could not hand its id back. Both are gone with
 * auto-resume: a window now opens on a new conversation and only ever adopts an
 * old one when the user presses the offer, at which point the first reply
 * supplies a live id. Neither the id nor the guard had a value left to carry.
 */
export function snapshotSessionId(options: {
  liveSessionId?: string;
  launchId: string;
}): string {
  return options.liveSessionId ?? options.launchId;
}

export function buildContextSnapshot(input: ContextSnapshotInput): Record<string, unknown> {
  const usedPercentage = input.usedTokens === null
    ? null
    : Math.min(100, Math.max(0, (input.usedTokens / input.windowTokens) * 100));
  const displayName = displayModelName(input.model);
  return {
    schemaVersion: 2,
    actionId: input.bindingId,
    launchId: input.launchId,
    sessionId: input.sessionId,
    ...(input.projectDir ? { projectDir: input.projectDir } : {}),
    capturedAt: input.capturedAt,
    ...(displayName ? { model: { displayName } } : {}),
    context: {
      usedPercentage,
      ...(input.usedTokens === null ? {} : { totalInputTokens: input.usedTokens }),
      contextWindowSize: input.windowTokens
    }
  };
}

export type CompanionActivity = "idle" | "running" | "waiting" | "ended";

export type RuntimeActivityInput = {
  dataDir: string;
  bindingId: string;
  launchId: string;
  activity: CompanionActivity;
  capturedAt: number;
};

function runtimeActivityPath(input: RuntimeActivityInput): string {
  return path.join(
    input.dataDir,
    "context-sessions",
    digest(input.bindingId),
    `${digest(input.launchId)}.state.json`
  );
}

function runtimeActivityRecord(input: RuntimeActivityInput): string {
  return `${JSON.stringify({
    schemaVersion: 2,
    actionId: input.bindingId,
    launchId: input.launchId,
    activity: input.activity,
    capturedAt: input.capturedAt
  }, null, 2)}\n`;
}

/**
 * The key's activity dot reads a runtime-state file the Companion writes on
 * phase changes. Without it the plugin defaults to "running" for the whole
 * app lifetime, so an idle app still showed the green running dot.
 * Shape and hashed path must match src/io/context-session-cache.ts
 * (parseRuntime / contextSessionRuntimePath, schemaVersion 2).
 *
 * `capturedAt` is also the key's liveness signal: the plugin treats a record
 * that has stopped being refreshed as a closed app, because a live PID proves
 * nothing on Windows, which reuses PIDs.
 */
export async function writeRuntimeActivity(input: RuntimeActivityInput): Promise<void> {
  const target = runtimeActivityPath(input);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${input.capturedAt}.tmp`;
  await writeFile(tmp, runtimeActivityRecord(input), "utf8");
  await rename(tmp, target);
}

/**
 * Synchronous twin for app teardown: Electron's `before-quit` cannot await, and
 * an async write started there is lost when the process exits.
 */
export function writeRuntimeActivitySync(input: RuntimeActivityInput): void {
  const target = runtimeActivityPath(input);
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${input.capturedAt}.tmp`;
  writeFileSync(tmp, runtimeActivityRecord(input), "utf8");
  renameSync(tmp, target);
}

export async function writeContextSnapshot(input: ContextSnapshotInput): Promise<void> {
  const target = path.join(
    input.dataDir,
    "context-sessions",
    digest(input.bindingId),
    `${digest(input.launchId)}.json`
  );
  const record = buildContextSnapshot(input);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${input.capturedAt}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}
