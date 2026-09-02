import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { ClaudeRateLimitWindows } from "../shared/claude-stream";

/**
 * Mirror a `--print` run's rate-limit windows into the plugin's usage.json.
 *
 * Same file, schema and lock protocol as the plugin's io/usage-cache.ts
 * (`usage.json.lock` created exclusively, temp file + rename); the two
 * bundles are built separately, so the protocol is duplicated here rather
 * than imported. A snapshot carrying both windows replaces the file; a
 * partial one is merged so the other window is not lost.
 */

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 1_000;
const STALE_LOCK_MS = 5_000;

type UsageCacheFile = {
  schemaVersion: 1;
  capturedAt: number;
  rateLimits: ClaudeRateLimitWindows;
};

async function readExisting(cachePath: string): Promise<UsageCacheFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(cachePath, "utf8")) as Partial<UsageCacheFile>;
    return parsed && parsed.schemaVersion === 1 && typeof parsed.capturedAt === "number" &&
      parsed.rateLimits && typeof parsed.rateLimits === "object"
      ? (parsed as UsageCacheFile)
      : undefined;
  } catch {
    return undefined;
  }
}

async function acquireLock(lockPath: string) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      return await open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs >= STALE_LOCK_MS) {
          await rm(lockPath, { force: true });
        }
      } catch {
        // Lock vanished between the failed open and the stat; retry.
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for usage cache lock: ${lockPath}`);
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}

export async function writeUsageRateLimits(
  dataDir: string,
  windows: ClaudeRateLimitWindows,
  capturedAt = Date.now()
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const cachePath = path.join(dataDir, "usage.json");
  const lockPath = `${cachePath}.lock`;
  const lock = await acquireLock(lockPath);
  try {
    const existing = await readExisting(cachePath);
    const complete = windows.fiveHour !== undefined && windows.sevenDay !== undefined;
    const rateLimits: ClaudeRateLimitWindows = complete || !existing
      ? windows
      : { ...existing.rateLimits, ...windows };
    const record: UsageCacheFile = { schemaVersion: 1, capturedAt, rateLimits };
    const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
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
