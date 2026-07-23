import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import {
  CLAUDE_EFFORTS,
  CLAUDE_MODELS,
  type ClaudeEffort,
  type ClaudeModel
} from "../shared/claude-command";

/**
 * The model + effort the user last applied for a project folder, so relaunching
 * Code Start restores their choice instead of resetting to the opus/high
 * default. Kept per folder (hashed) under the shared usage data dir, next to the
 * Stream Deck key snapshots, and written atomically so a crash mid-write cannot
 * leave a half file the next launch reads.
 */
export type ModelPrefs = {
  model?: ClaudeModel;
  effort?: ClaudeEffort;
};

function prefsPath(usageDataDir: string, rootPath: string): string {
  const digest = createHash("sha256").update(rootPath, "utf8").digest("hex");
  return path.join(usageDataDir, "model-prefs", `${digest}.json`);
}

export async function readModelPrefs(usageDataDir: string, rootPath: string): Promise<ModelPrefs> {
  try {
    const raw = JSON.parse(await readFile(prefsPath(usageDataDir, rootPath), "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) {
      return {};
    }
    const record = raw as Record<string, unknown>;
    const model = record.model;
    const effort = record.effort;
    return {
      model: CLAUDE_MODELS.includes(model as ClaudeModel) ? (model as ClaudeModel) : undefined,
      effort: CLAUDE_EFFORTS.includes(effort as ClaudeEffort) ? (effort as ClaudeEffort) : undefined
    };
  } catch {
    // No saved prefs (or an unreadable/partial file): fall back to defaults.
    return {};
  }
}

export async function writeModelPrefs(
  usageDataDir: string,
  rootPath: string,
  prefs: ModelPrefs
): Promise<void> {
  const target = prefsPath(usageDataDir, rootPath);
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(prefs, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}
