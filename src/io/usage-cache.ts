import { open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import {
  mergeUsageCaches,
  type RateLimitWindow,
  type UsageCache
} from "../domain/rate-limits";

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 1_000;
const STALE_LOCK_MS = 5_000;

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

async function removeStaleLock(lockPath: string): Promise<void> {
  try {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs >= STALE_LOCK_MS) {
      await rm(lockPath, { force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function acquireUsageCacheLock(lockPath: string) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      return await open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      await removeStaleLock(lockPath);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for usage cache lock: ${lockPath}`);
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}

export async function writeMergedUsageCache(
  cachePath: string,
  incoming: UsageCache
): Promise<void> {
  const lockPath = `${cachePath}.lock`;
  const lock = await acquireUsageCacheLock(lockPath);
  try {
    const current = await readUsageCache(cachePath);
    const cache = mergeUsageCaches(current, incoming);
    const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
      await rename(temporaryPath, cachePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  } finally {
    try {
      await lock.close();
    } finally {
      await rm(lockPath, { force: true });
    }
  }
}
