import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadUsageDisplayState, withLastGoodHold } from "../src/services/display-loader";

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

  it("reports a status-line conflict instead of claiming usage data is live", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-usage-display-"));
    const cachePath = path.join(root, "usage.json");
    await expect(
      loadUsageDisplayState("fiveHour", {
        cachePath,
        bridgeInstalled: false,
        statusLineConflict: true,
        nowMs: 0
      })
    ).resolves.toEqual({ kind: "statusline-conflict" });
  });

  it("falls back to the CLI-refreshed usage.json when the OMC cache is absent (conflict path)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-usage-display-"));
    const cachePath = path.join(root, "usage.json");
    const nowMs = 1_700_000_000_000;
    await writeFile(
      cachePath,
      JSON.stringify({
        schemaVersion: 1,
        capturedAt: nowMs,
        rateLimits: { fiveHour: { usedPercentage: 69, resetsAt: nowMs / 1000 + 3_600 } }
      }),
      "utf8"
    );

    await expect(
      loadUsageDisplayState("fiveHour", {
        cachePath,
        bridgeInstalled: false,
        statusLineConflict: true,
        externalUsageCachePath: path.join(root, "missing-omc-cache.json"),
        nowMs
      })
    ).resolves.toEqual({ kind: "ready", percentage: 69, remaining: "1h 0m" });
  });

  it("prefers the newer window when both OMC and usage.json exist (conflict path)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-usage-display-"));
    const cachePath = path.join(root, "usage.json");
    const externalPath = path.join(root, ".usage-cache-anthropic.json");
    const nowMs = 1_700_000_000_000;
    // OMC last saw the previous five-hour window (already reset)…
    await writeFile(
      externalPath,
      JSON.stringify({
        timestamp: nowMs - 60_000,
        source: "anthropic",
        data: {
          fiveHourPercent: 99,
          fiveHourResetsAt: (nowMs / 1000 - 600) * 1000
        }
      }),
      "utf8"
    );
    // …while the CLI self-refresh already captured the new window.
    await writeFile(
      cachePath,
      JSON.stringify({
        schemaVersion: 1,
        capturedAt: nowMs,
        rateLimits: { fiveHour: { usedPercentage: 12, resetsAt: nowMs / 1000 + 9_000 } }
      }),
      "utf8"
    );

    await expect(
      loadUsageDisplayState("fiveHour", {
        cachePath,
        bridgeInstalled: false,
        statusLineConflict: true,
        externalUsageCachePath: externalPath,
        nowMs
      })
    ).resolves.toEqual({ kind: "ready", percentage: 12, remaining: "2h 30m" });
  });

  it("uses a fresh OMC Anthropic cache when OMC owns the status-line slot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "claude-usage-display-"));
    const cachePath = path.join(root, "usage.json");
    const externalPath = path.join(root, ".usage-cache-anthropic.json");
    const nowMs = 1_700_000_000_000;
    await writeFile(
      externalPath,
      JSON.stringify({
        timestamp: nowMs - 1_000,
        lastSuccessAt: nowMs - 1_000,
        error: false,
        source: "anthropic",
        data: {
          fiveHourPercent: 43,
          fiveHourResetsAt: new Date(nowMs + 2 * 3600 * 1000).toISOString(),
          weeklyPercent: 50,
          weeklyResetsAt: new Date(nowMs + 24 * 3600 * 1000).toISOString()
        }
      }),
      "utf8"
    );

    await expect(
      loadUsageDisplayState("fiveHour", {
        cachePath,
        bridgeInstalled: false,
        statusLineConflict: true,
        externalUsageCachePath: externalPath,
        nowMs
      })
    ).resolves.toEqual({ kind: "ready", percentage: 43, remaining: "2h 0m" });
    await expect(
      loadUsageDisplayState("sevenDay", {
        cachePath,
        bridgeInstalled: false,
        statusLineConflict: true,
        externalUsageCachePath: externalPath,
        nowMs
      })
    ).resolves.toEqual({ kind: "ready", percentage: 50, remaining: "1d 0h" });
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

describe("withLastGoodHold", () => {
  const ready = { kind: "ready", percentage: 58, remaining: "2h 10m" } as const;
  const nowMs = 1_700_000_000_000;

  it("remembers data states and rides out transient data-less states", () => {
    const first = withLastGoodHold(ready, undefined, nowMs);
    expect(first.state).toEqual(ready);

    // A momentary conflict/error/waiting keeps showing the last good value…
    for (const flap of [
      { kind: "statusline-conflict" } as const,
      { kind: "error" } as const,
      { kind: "waiting" } as const
    ]) {
      expect(withLastGoodHold(flap, first.lastGood, nowMs + 60_000).state).toEqual(ready);
    }
  });

  it("gives up the hold after 15 minutes and never holds over setup", () => {
    const { lastGood } = withLastGoodHold(ready, undefined, nowMs);
    const conflict = { kind: "statusline-conflict" } as const;
    expect(withLastGoodHold(conflict, lastGood, nowMs + 16 * 60 * 1000).state).toEqual(conflict);
    // "setup" is a real call to action — always shown immediately.
    const setup = { kind: "setup" } as const;
    expect(withLastGoodHold(setup, lastGood, nowMs + 1_000).state).toEqual(setup);
  });
});
