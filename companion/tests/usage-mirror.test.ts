import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

async function loadWriter() {
  return (await import("../main/usage-mirror")).writeUsageRateLimits;
}

afterEach(() => {
  vi.doUnmock("node:fs/promises");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("writeUsageRateLimits", () => {
  it("writes the plugin's usage.json schema, replacing on a complete snapshot", async () => {
    const writeUsageRateLimits = await loadWriter();
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
    const writeUsageRateLimits = await loadWriter();
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

  it("rejects older full and partial snapshots without changing the latest cache", async () => {
    const writeUsageRateLimits = await loadWriter();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "usage-mirror-"));
    await writeUsageRateLimits(
      dataDir,
      { fiveHour: { usedPercentage: 80, resetsAt: 10 }, sevenDay: { usedPercentage: 70, resetsAt: 20 } },
      2_000
    );

    await writeUsageRateLimits(
      dataDir,
      { fiveHour: { usedPercentage: 30, resetsAt: 11 }, sevenDay: { usedPercentage: 40, resetsAt: 21 } },
      1_000
    );
    await writeUsageRateLimits(dataDir, { fiveHour: { usedPercentage: 20, resetsAt: 12 } }, 1_500);

    expect(JSON.parse(await readFile(path.join(dataDir, "usage.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      capturedAt: 2_000,
      rateLimits: {
        fiveHour: { usedPercentage: 80, resetsAt: 10 },
        sevenDay: { usedPercentage: 70, resetsAt: 20 }
      }
    });
  });

  it("allows a newer complete snapshot with lower usage after an account switch", async () => {
    const writeUsageRateLimits = await loadWriter();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "usage-mirror-"));
    await writeUsageRateLimits(
      dataDir,
      { fiveHour: { usedPercentage: 80, resetsAt: 10 }, sevenDay: { usedPercentage: 70, resetsAt: 20 } },
      2_000
    );

    await writeUsageRateLimits(
      dataDir,
      { fiveHour: { usedPercentage: 5, resetsAt: 30 }, sevenDay: { usedPercentage: 4, resetsAt: 40 } },
      3_000
    );

    expect(JSON.parse(await readFile(path.join(dataDir, "usage.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      capturedAt: 3_000,
      rateLimits: {
        fiveHour: { usedPercentage: 5, resetsAt: 30 },
        sevenDay: { usedPercentage: 4, resetsAt: 40 }
      }
    });
  });

  it("merges equal-timestamp partial snapshots so neither window is lost", async () => {
    const writeUsageRateLimits = await loadWriter();
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "usage-mirror-"));
    await writeUsageRateLimits(dataDir, { sevenDay: { usedPercentage: 50, resetsAt: 20 } }, 2_000);

    await writeUsageRateLimits(dataDir, { fiveHour: { usedPercentage: 65, resetsAt: 30 } }, 2_000);

    expect(JSON.parse(await readFile(path.join(dataDir, "usage.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      capturedAt: 2_000,
      rateLimits: {
        fiveHour: { usedPercentage: 65, resetsAt: 30 },
        sevenDay: { usedPercentage: 50, resetsAt: 20 }
      }
    });
  });

  it("keeps a newer async writer when an older default-timestamp writer resumes later", async () => {
    const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "usage-mirror-"));
    let releaseOlderMkdir!: () => void;
    const olderMkdirReleased = new Promise<void>((resolve) => {
      releaseOlderMkdir = resolve;
    });
    let olderMkdirStarted!: () => void;
    const olderMkdirReached = new Promise<void>((resolve) => {
      olderMkdirStarted = resolve;
    });
    let mkdirCalls = 0;

    vi.doMock("node:fs/promises", () => ({
      ...actualFs,
      mkdir: async (...args: Parameters<typeof actualFs.mkdir>) => {
        mkdirCalls += 1;
        if (mkdirCalls === 1) {
          olderMkdirStarted();
          await olderMkdirReleased;
        }
        return actualFs.mkdir(...args);
      }
    }));
    const writeUsageRateLimits = await loadWriter();
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(1_000);
    const olderWrite = writeUsageRateLimits(dataDir, {
      fiveHour: { usedPercentage: 30, resetsAt: 10 },
      sevenDay: { usedPercentage: 30, resetsAt: 20 }
    });
    await olderMkdirReached;

    now.mockReturnValueOnce(2_000);
    await writeUsageRateLimits(dataDir, {
      fiveHour: { usedPercentage: 80, resetsAt: 30 },
      sevenDay: { usedPercentage: 80, resetsAt: 40 }
    });

    releaseOlderMkdir();
    await olderWrite;

    expect(JSON.parse(await readFile(path.join(dataDir, "usage.json"), "utf8"))).toEqual({
      schemaVersion: 1,
      capturedAt: 2_000,
      rateLimits: {
        fiveHour: { usedPercentage: 80, resetsAt: 30 },
        sevenDay: { usedPercentage: 80, resetsAt: 40 }
      }
    });
  });
});
