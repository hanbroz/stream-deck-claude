import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadUsageDisplayState } from "../src/services/display-loader";

describe("loadUsageDisplayState", () => {
  it("distinguishes setup from waiting when the cache is absent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-usage-display-"));
    const cachePath = path.join(root, "usage.json");

    await expect(
      loadUsageDisplayState("fiveHour", { cachePath, bridgeInstalled: false, nowMs: 0 })
    ).resolves.toEqual({ kind: "setup" });
    await expect(
      loadUsageDisplayState("fiveHour", { cachePath, bridgeInstalled: true, nowMs: 0 })
    ).resolves.toEqual({ kind: "waiting" });
  });

  it("loads each window independently from the cache", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-usage-display-"));
    const cachePath = path.join(root, "usage.json");
    await writeFile(
      cachePath,
      JSON.stringify({
        schemaVersion: 1,
        capturedAt: 1_700_000_000_000,
        rateLimits: {
          fiveHour: { usedPercentage: 10.1, resetsAt: 1_700_010_000 },
          sevenDay: { usedPercentage: 72.6, resetsAt: 1_700_100_000 }
        }
      }),
      "utf8"
    );

    await expect(
      loadUsageDisplayState("fiveHour", {
        cachePath,
        bridgeInstalled: true,
        nowMs: 1_700_000_000_000
      })
    ).resolves.toEqual({ kind: "ready", percentage: 10, remaining: "2h 46m" });
    await expect(
      loadUsageDisplayState("sevenDay", {
        cachePath,
        bridgeInstalled: true,
        nowMs: 1_700_000_000_000
      })
    ).resolves.toEqual({ kind: "ready", percentage: 73, remaining: "1d 3h" });
  });

  it("renders an error for malformed cache data", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-usage-display-"));
    const cachePath = path.join(root, "usage.json");
    await writeFile(cachePath, "not-json", "utf8");

    await expect(
      loadUsageDisplayState("fiveHour", { cachePath, bridgeInstalled: true, nowMs: 0 })
    ).resolves.toEqual({ kind: "error" });
  });
});
