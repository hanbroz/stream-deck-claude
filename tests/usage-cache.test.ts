import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readUsageCache, writeMergedUsageCache } from "../src/io/usage-cache";

describe("writeMergedUsageCache", () => {
  it("re-reads inside an exclusive lock before a stale lower update writes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-usage-cache-"));
    const cachePath = path.join(root, "usage.json");
    const lockPath = `${cachePath}.lock`;
    await writeFile(
      cachePath,
      JSON.stringify({
        schemaVersion: 1,
        capturedAt: 100,
        rateLimits: {
          sevenDay: { usedPercentage: 35, resetsAt: 2_000_000_000 }
        }
      }),
      "utf8"
    );
    await writeFile(lockPath, "held by newer update", { encoding: "utf8", flag: "wx" });

    const staleWrite = writeMergedUsageCache(cachePath, {
      schemaVersion: 1,
      capturedAt: 300,
      rateLimits: {
        sevenDay: { usedPercentage: 36, resetsAt: 2_000_000_000 }
      }
    });
    await writeFile(
      cachePath,
      JSON.stringify({
        schemaVersion: 1,
        capturedAt: 200,
        rateLimits: {
          sevenDay: { usedPercentage: 38, resetsAt: 2_000_000_000 }
        }
      }),
      "utf8"
    );
    await rm(lockPath);
    await staleWrite;

    await expect(readUsageCache(cachePath)).resolves.toMatchObject({
      capturedAt: 300,
      rateLimits: {
        sevenDay: { usedPercentage: 38, resetsAt: 2_000_000_000 }
      }
    });
    expect(await readFile(lockPath, "utf8").catch(() => "removed")).toBe("removed");
  });
});
