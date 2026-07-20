import { readFile } from "node:fs/promises";

import type { RateLimitWindow, UsageCache } from "../domain/rate-limits";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function parseWindow(value: unknown): RateLimitWindow | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const usedPercentage = record.usedPercentage;
  const resetsAt = record.resetsAt;
  if (
    typeof usedPercentage !== "number" ||
    !Number.isFinite(usedPercentage) ||
    usedPercentage < 0 ||
    usedPercentage > 100 ||
    typeof resetsAt !== "number" ||
    !Number.isFinite(resetsAt) ||
    resetsAt <= 0
  ) {
    return undefined;
  }
  return { usedPercentage, resetsAt };
}

export function parseUsageCache(value: unknown): UsageCache {
  const root = asRecord(value);
  const rateLimits = asRecord(root?.rateLimits);
  if (root?.schemaVersion !== 1 || typeof root.capturedAt !== "number" || !rateLimits) {
    throw new Error("Invalid Claude usage cache schema");
  }

  const fiveHour = parseWindow(rateLimits.fiveHour);
  const sevenDay = parseWindow(rateLimits.sevenDay);
  if (!fiveHour && !sevenDay) {
    throw new Error("Claude usage cache has no valid windows");
  }

  return {
    schemaVersion: 1,
    capturedAt: root.capturedAt,
    rateLimits: {
      ...(fiveHour ? { fiveHour } : {}),
      ...(sevenDay ? { sevenDay } : {})
    }
  };
}

export async function readUsageCache(cachePath: string): Promise<UsageCache | undefined> {
  try {
    const raw = await readFile(cachePath, "utf8");
    return parseUsageCache(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
