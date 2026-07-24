import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseOmcUsageCache,
  readUsageCache,
  writeMergedUsageCache,
  writeUsageCache
} from "../src/io/usage-cache";

describe("parseOmcUsageCache", () => {
  it("converts OMC's fresh Anthropic cache to the local usage schema", () => {
    const nowMs = 1_700_000_000_000;
    expect(
      parseOmcUsageCache(
        {
          timestamp: nowMs - 1_000,
          lastSuccessAt: nowMs - 1_000,
          source: "anthropic",
          data: {
            fiveHourPercent: 43,
            fiveHourResetsAt: "2026-07-21T09:49:59.638Z",
            weeklyPercent: 50,
            weeklyResetsAt: "2026-07-21T19:59:59.638Z"
          }
        },
        nowMs
      )
    ).toMatchObject({
      capturedAt: nowMs - 1_000,
      rateLimits: {
        fiveHour: { usedPercentage: 43 },
        sevenDay: { usedPercentage: 50 }
      }
    });
  });

  it("rejects abandoned, failed, or non-Anthropic caches", () => {
    const nowMs = 1_700_000_000_000;
    const base = {
      timestamp: nowMs - 1_000,
      source: "anthropic",
      data: {
        fiveHourPercent: 43,
        fiveHourResetsAt: "2026-07-21T09:49:59.638Z"
      }
    };
    // Idle-but-recent caches stay valid (usage cannot rise while Claude is
    // idle; a 10-minute cutoff used to flip the keys to STATUSLINE BUSY)…
    expect(parseOmcUsageCache({ ...base, timestamp: nowMs - 700_000 }, nowMs)).toBeDefined();
    // …only a cache abandoned for over a day is rejected.
    expect(
      parseOmcUsageCache({ ...base, timestamp: nowMs - 25 * 60 * 60 * 1000 }, nowMs)
    ).toBeUndefined();
    expect(parseOmcUsageCache({ ...base, error: true }, nowMs)).toBeUndefined();
    expect(parseOmcUsageCache({ ...base, source: "zai" }, nowMs)).toBeUndefined();
  });
});

describe("writeUsageCache (replace)", () => {
  it("replaces the previous account's windows even when their reset is later", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-usage-write-"));
    const cachePath = path.join(root, "usage.json");
    try {
      // Field incident: after a login switch the OLD account's weekly window
      // (75%, later reset) kept winning the merge over the new account's 4%.
      await writeFile(
        cachePath,
        JSON.stringify({
          schemaVersion: 1,
          capturedAt: 1_700_000_000_000,
          rateLimits: {
            fiveHour: { usedPercentage: 71, resetsAt: 1_700_010_000 },
            sevenDay: { usedPercentage: 75, resetsAt: 1_700_500_000 }
          }
        }),
        "utf8"
      );
      const newAccount = {
        schemaVersion: 1 as const,
        capturedAt: 1_700_000_600_000,
        rateLimits: {
          fiveHour: { usedPercentage: 18, resetsAt: 1_700_016_000 },
          sevenDay: { usedPercentage: 4, resetsAt: 1_700_400_000 }
        }
      };

      await writeUsageCache(cachePath, newAccount);

      expect(await readUsageCache(cachePath)).toEqual(newAccount);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

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
