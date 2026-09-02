import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  listOmcStdinCacheCandidates,
  parseOmcStdinCache,
  readNewestOmcStdinCache
} from "../src/io/omc-stdin-cache";
import { readUsageCache, writeUsageCache } from "../src/io/usage-cache";
import { OmcStdinSync } from "../src/services/omc-stdin-sync";

// A verbatim (trimmed) `~/.omc/state/hud-stdin-cache.json` as OMC 5 writes it:
// the status-line payload Claude Code piped to the HUD, persisted as-is.
const SNAPSHOT = {
  session_id: "b15383a7-566a-4d42-a07f-5432ffd856ed",
  cwd: "D:\\tmp\\rr",
  model: { id: "claude-fable-5", display_name: "Fable 5" },
  version: "2.1.258",
  context_window: { used_percentage: 7, remaining_percentage: 93 },
  rate_limits: {
    five_hour: { used_percentage: 41, resets_at: 1_788_324_600 },
    seven_day: { used_percentage: 6, resets_at: 1_788_865_200 }
  }
};

async function writeSnapshot(filePath: string, payload: unknown, mtimeMs: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(payload), "utf8");
  await utimes(filePath, mtimeMs / 1000, mtimeMs / 1000);
}

describe("parseOmcStdinCache", () => {
  it("lifts rate_limits and the Claude Code version out of the payload", () => {
    expect(parseOmcStdinCache(SNAPSHOT, 1_788_319_000_000)).toEqual({
      capturedAt: 1_788_319_000_000,
      clientVersion: "2.1.258",
      cache: {
        schemaVersion: 1,
        capturedAt: 1_788_319_000_000,
        rateLimits: {
          fiveHour: { usedPercentage: 41, resetsAt: 1_788_324_600 },
          sevenDay: { usedPercentage: 6, resetsAt: 1_788_865_200 }
        }
      }
    });
  });

  it("ignores payloads without rate limits (a hook event, an empty render)", () => {
    expect(parseOmcStdinCache({ version: "2.1.258" }, 1)).toBeUndefined();
    expect(parseOmcStdinCache("{}", 1)).toBeUndefined();
  });
});

describe("listOmcStdinCacheCandidates", () => {
  it("covers the flat path, per-session paths, and OMC_STATE_DIR project roots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omc-stdin-"));
    const home = path.join(root, ".omc");
    const central = path.join(root, "central");
    await mkdir(path.join(home, "state", "sessions", "abc-123"), { recursive: true });
    await mkdir(path.join(central, "proj-1", "state", "sessions", "s1"), { recursive: true });

    const candidates = await listOmcStdinCacheCandidates([home, central]);
    expect(candidates).toEqual(
      expect.arrayContaining([
        path.join(home, "state", "hud-stdin-cache.json"),
        path.join(home, "state", "sessions", "abc-123", "hud-stdin-cache.json"),
        path.join(central, "proj-1", "state", "hud-stdin-cache.json"),
        path.join(central, "proj-1", "state", "sessions", "s1", "hud-stdin-cache.json")
      ])
    );
  });
});

describe("readNewestOmcStdinCache", () => {
  it("returns the most recently written valid snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omc-stdin-"));
    const nowMs = 1_788_319_000_000;
    const flat = path.join(root, "state", "hud-stdin-cache.json");
    const scoped = path.join(root, "state", "sessions", "s1", "hud-stdin-cache.json");
    await writeSnapshot(flat, SNAPSHOT, nowMs - 60_000);
    await writeSnapshot(
      scoped,
      { ...SNAPSHOT, rate_limits: { five_hour: { used_percentage: 55, resets_at: 1_788_324_600 } } },
      nowMs - 1_000
    );

    const snapshot = await readNewestOmcStdinCache([flat, scoped], nowMs);
    expect(snapshot?.path).toBe(scoped);
    expect(snapshot?.cache.rateLimits.fiveHour?.usedPercentage).toBe(55);
  });

  it("skips corrupt and over-age files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omc-stdin-"));
    const nowMs = 1_788_319_000_000;
    const corrupt = path.join(root, "a", "hud-stdin-cache.json");
    const old = path.join(root, "b", "hud-stdin-cache.json");
    const good = path.join(root, "c", "hud-stdin-cache.json");
    await mkdir(path.dirname(corrupt), { recursive: true });
    await writeFile(corrupt, "{not json", "utf8");
    await utimes(corrupt, (nowMs - 1_000) / 1000, (nowMs - 1_000) / 1000);
    await writeSnapshot(old, SNAPSHOT, nowMs - 2 * 24 * 60 * 60 * 1000);
    await writeSnapshot(good, SNAPSHOT, nowMs - 10_000);

    const snapshot = await readNewestOmcStdinCache([corrupt, old, good], nowMs);
    expect(snapshot?.path).toBe(good);
    expect(await readNewestOmcStdinCache([old], nowMs)).toBeUndefined();
    expect(await readNewestOmcStdinCache([path.join(root, "missing.json")], nowMs)).toBeUndefined();
  });
});

describe("OmcStdinSync", () => {
  it("copies a newer snapshot into usage.json and leaves a newer usage.json alone", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omc-stdin-sync-"));
    const omcRoot = path.join(root, ".omc");
    const dataDir = path.join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const nowMs = 1_788_319_000_000;
    const snapshotPath = path.join(omcRoot, "state", "hud-stdin-cache.json");
    await writeSnapshot(snapshotPath, SNAPSHOT, nowMs - 5_000);
    // A stale usage.json from a previous window (what the field looked like).
    await writeUsageCache(path.join(dataDir, "usage.json"), {
      schemaVersion: 1,
      capturedAt: nowMs - 6 * 24 * 60 * 60 * 1000,
      rateLimits: {
        fiveHour: { usedPercentage: 5, resetsAt: 1_787_805_540 },
        sevenDay: { usedPercentage: 17, resetsAt: 1_788_260_340 }
      }
    });

    const sync = new OmcStdinSync([omcRoot]);
    const synced = await sync.sync(dataDir, nowMs);
    expect(synced.snapshot?.path).toBe(snapshotPath);
    expect(synced.localCapturedAt).toBe(nowMs - 5_000);
    expect(await readUsageCache(path.join(dataDir, "usage.json"))).toEqual({
      schemaVersion: 1,
      capturedAt: nowMs - 5_000,
      rateLimits: {
        fiveHour: { usedPercentage: 41, resetsAt: 1_788_324_600 },
        sevenDay: { usedPercentage: 6, resetsAt: 1_788_865_200 }
      }
    });

    // Our own bridge (or the API) wrote something newer: the older OMC
    // snapshot must not regress it.
    await writeUsageCache(path.join(dataDir, "usage.json"), {
      schemaVersion: 1,
      capturedAt: nowMs,
      rateLimits: { fiveHour: { usedPercentage: 44, resetsAt: 1_788_324_600 } }
    });
    await new OmcStdinSync([omcRoot]).sync(dataDir, nowMs + 1_000);
    expect((await readUsageCache(path.join(dataDir, "usage.json")))?.rateLimits.fiveHour?.usedPercentage).toBe(44);
  });

  it("merges a partial snapshot instead of dropping the other window", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omc-stdin-sync-"));
    const omcRoot = path.join(root, ".omc");
    const dataDir = path.join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const nowMs = 1_788_319_000_000;
    await writeUsageCache(path.join(dataDir, "usage.json"), {
      schemaVersion: 1,
      capturedAt: nowMs - 60_000,
      rateLimits: { sevenDay: { usedPercentage: 6, resetsAt: 1_788_865_200 } }
    });
    await writeSnapshot(
      path.join(omcRoot, "state", "hud-stdin-cache.json"),
      { ...SNAPSHOT, rate_limits: { five_hour: { used_percentage: 41, resets_at: 1_788_324_600 } } },
      nowMs - 1_000
    );

    await new OmcStdinSync([omcRoot]).sync(dataDir, nowMs);
    expect((await readUsageCache(path.join(dataDir, "usage.json")))?.rateLimits).toEqual({
      fiveHour: { usedPercentage: 41, resetsAt: 1_788_324_600 },
      sevenDay: { usedPercentage: 6, resetsAt: 1_788_865_200 }
    });
  });

  it("does nothing when OMC has written no snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omc-stdin-sync-"));
    const dataDir = path.join(root, "data");
    await mkdir(dataDir, { recursive: true });
    await expect(new OmcStdinSync([path.join(root, ".omc")]).sync(dataDir)).resolves.toEqual({
      snapshot: undefined,
      localCapturedAt: undefined
    });
    await expect(readUsageCache(path.join(dataDir, "usage.json"))).resolves.toBeUndefined();
  });

  it("creates the data dir on first sync (nothing on the read path does)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omc-stdin-sync-"));
    const omcRoot = path.join(root, ".omc");
    const dataDir = path.join(root, "not-yet-created", "ClaudeUsageDeck");
    const nowMs = 1_788_319_000_000;
    await writeSnapshot(path.join(omcRoot, "state", "hud-stdin-cache.json"), SNAPSHOT, nowMs - 5_000);

    await new OmcStdinSync([omcRoot]).sync(dataDir, nowMs);
    expect((await readUsageCache(path.join(dataDir, "usage.json")))?.capturedAt).toBe(nowMs - 5_000);
  });

  it("coalesces concurrent calls and does not re-read an unchanged snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omc-stdin-sync-"));
    const omcRoot = path.join(root, ".omc");
    const dataDir = path.join(root, "data");
    const nowMs = 1_788_319_000_000;
    const snapshotPath = path.join(omcRoot, "state", "hud-stdin-cache.json");
    await writeSnapshot(snapshotPath, SNAPSHOT, nowMs - 5_000);

    const sync = new OmcStdinSync([omcRoot]);
    const [a, b] = await Promise.all([sync.sync(dataDir, nowMs), sync.sync(dataDir, nowMs)]);
    expect(a).toBe(b);

    // Corrupt the file without touching its mtime: an unchanged mtime must
    // not trigger a re-read, so the earlier snapshot is still reported.
    await writeFile(snapshotPath, "{corrupt", "utf8");
    await utimes(snapshotPath, (nowMs - 5_000) / 1000, (nowMs - 5_000) / 1000);
    const again = await sync.sync(dataDir, nowMs + 1_000);
    expect(again.snapshot?.cache.rateLimits.fiveHour?.usedPercentage).toBe(41);
    expect(again.localCapturedAt).toBe(nowMs - 5_000);
  });

  it("clamps a future mtime to now so it cannot outrank later writes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "omc-stdin-"));
    const nowMs = 1_788_319_000_000;
    const file = path.join(root, "hud-stdin-cache.json");
    await writeSnapshot(file, SNAPSHOT, nowMs + 60 * 60 * 1000);
    expect((await readNewestOmcStdinCache([file], nowMs))?.capturedAt).toBe(nowMs);
  });
});
