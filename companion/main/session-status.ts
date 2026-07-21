import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export type CompanionSessionStatus = {
  model?: string;
  contextPercentage?: number | null;
  capturedAt?: number;
};

export type SessionStatusReaderOptions = {
  dataDir: string;
  bindingId?: string;
  launchId?: string;
  fallback?: CompanionSessionStatus;
};

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function finitePercentage(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : undefined;
}

export async function readCompanionSessionStatus(
  options: SessionStatusReaderOptions
): Promise<CompanionSessionStatus> {
  const fallback = options.fallback ?? {};
  if (!options.bindingId || !options.launchId) {
    return fallback;
  }
  const snapshotPath = path.join(
    options.dataDir,
    "context-sessions",
    digest(options.bindingId),
    `${digest(options.launchId)}.json`
  );
  try {
    const root = JSON.parse(await readFile(snapshotPath, "utf8")) as Record<string, unknown>;
    const context = root.context as Record<string, unknown> | undefined;
    const model = root.model as Record<string, unknown> | undefined;
    const percentage = finitePercentage(context?.usedPercentage);
    const displayName = typeof model?.displayName === "string" ? model.displayName.trim() : "";
    return {
      ...(displayName ? { model: displayName } : fallback.model ? { model: fallback.model } : {}),
      ...(percentage !== undefined
        ? { contextPercentage: percentage }
        : fallback.contextPercentage !== undefined
          ? { contextPercentage: fallback.contextPercentage }
          : {}),
      ...(typeof root.capturedAt === "number" ? { capturedAt: root.capturedAt } : {})
    };
  } catch {
    return fallback;
  }
}
