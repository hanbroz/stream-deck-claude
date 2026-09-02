import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { writeUsageRateLimits } from "../main/usage-mirror";

describe("writeUsageRateLimits", () => {
  it("writes the plugin's usage.json schema, replacing on a complete snapshot", async () => {
    const dataDir = path.join(await mkdtemp(path.join(os.tmpdir(), "usage-mirror-")), "ClaudeUsageDeck");
    await writeUsageRateLimits(
      dataDir,
      {
        fiveHour: { usedPercentage: 50, resetsAt: 1_788_342_600 },
        sevenDay: { usedPercentage: 22, resetsAt: 1_788_865_200 }
      },
      1_788_333_000_000
    );
    expect(JSON.parse(await readFile(path.join(dataDir, "usage.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      capturedAt: 1_788_333_000_000,
      rateLimits: {
        fiveHour: { usedPercentage: 50, resetsAt: 1_788_342_600 },
        sevenDay: { usedPercentage: 22, resetsAt: 1_788_865_200 }
      }
    });
  });

  it("merges a partial snapshot and survives a corrupt file", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "usage-mirror-"));
    await writeUsageRateLimits(
      dataDir,
      { fiveHour: { usedPercentage: 10, resetsAt: 1 }, sevenDay: { usedPercentage: 20, resetsAt: 2 } },
      1
    );
    await writeUsageRateLimits(dataDir, { fiveHour: { usedPercentage: 55, resetsAt: 3 } }, 2);
    expect(JSON.parse(await readFile(path.join(dataDir, "usage.json"), "utf8")).rateLimits).toEqual({
      fiveHour: { usedPercentage: 55, resetsAt: 3 },
      sevenDay: { usedPercentage: 20, resetsAt: 2 }
    });

    await writeFile(path.join(dataDir, "usage.json"), "{corrupt", "utf8");
    await writeUsageRateLimits(dataDir, { sevenDay: { usedPercentage: 30, resetsAt: 4 } }, 3);
    expect(JSON.parse(await readFile(path.join(dataDir, "usage.json"), "utf8")).rateLimits).toEqual({
      sevenDay: { usedPercentage: 30, resetsAt: 4 }
    });
  });
});
