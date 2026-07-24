import { mkdir, rename, writeFile } from "node:fs/promises";
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
