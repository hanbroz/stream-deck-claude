import { describe, expect, it } from "vitest";

import {
  extractUsageCache,
  formatRemaining,
  getDisplayState,
  selectRateLimitWindow
} from "../src/domain/rate-limits";

describe("extractUsageCache", () => {
  it("extracts only the documented five-hour and weekly fields", () => {
    const cache = extractUsageCache(
      {
        session_id: "secret-session",
        transcript_path: "C:/secret/transcript.jsonl",
        prompt: "do not persist me",
        rate_limits: {
          five_hour: { used_percentage: 23.5, resets_at: 2_000_000_000 },
          seven_day: { used_percentage: 41.2, resets_at: 2_000_100_000 }
        }
      },
      1_700_000_000_000
    );

    expect(cache).toEqual({
      schemaVersion: 1,
      capturedAt: 1_700_000_000_000,
      rateLimits: {
        fiveHour: { usedPercentage: 23.5, resetsAt: 2_000_000_000 },
        sevenDay: { usedPercentage: 41.2, resetsAt: 2_000_100_000 }
      }
    });
    expect(JSON.stringify(cache)).not.toContain("secret");
    expect(JSON.stringify(cache)).not.toContain("prompt");
  });

  it("returns undefined when no valid rate-limit window is present", () => {
    expect(extractUsageCache({ rate_limits: {} }, 0)).toBeUndefined();
    expect(extractUsageCache(null, 0)).toBeUndefined();
  });

  it("clamps percentages and rejects invalid reset epochs", () => {
    expect(
      extractUsageCache(
        {
          rate_limits: {
            five_hour: { used_percentage: 125, resets_at: 2_000_000_000 },
            seven_day: { used_percentage: 20, resets_at: -1 }
          }
        },
        100
      )
    ).toEqual({
      schemaVersion: 1,
      capturedAt: 100,
      rateLimits: {
        fiveHour: { usedPercentage: 100, resetsAt: 2_000_000_000 }
      }
    });
  });
});

describe("window selection and display", () => {
  const cache = {
    schemaVersion: 1 as const,
    capturedAt: 1_700_000_000_000,
    rateLimits: {
      fiveHour: { usedPercentage: 23.5, resetsAt: 1_700_010_000 },
      sevenDay: { usedPercentage: 41.2, resetsAt: 1_700_100_000 }
    }
  };

  it("selects independent five-hour and weekly windows", () => {
    expect(selectRateLimitWindow(cache, "fiveHour")?.usedPercentage).toBe(23.5);
    expect(selectRateLimitWindow(cache, "sevenDay")?.usedPercentage).toBe(41.2);
  });

  it("formats reset countdowns for hours and days", () => {
    const now = Date.UTC(2026, 6, 16, 0, 0, 0);
    expect(formatRemaining(now / 1000 + 2 * 3600 + 14 * 60, now)).toBe("2h 14m");
    expect(formatRemaining(now / 1000 + 4 * 86400 + 8 * 3600, now)).toBe("4d 8h");
  });

  it("marks an elapsed window as refresh-required", () => {
    const state = getDisplayState(
      { usedPercentage: 87, resetsAt: 1_700_000_000 },
      1_700_000_001_000
    );
    expect(state).toEqual({ kind: "expired", remaining: "REFRESH" });
  });

  it("rounds the displayed percentage while retaining reset time", () => {
    const state = getDisplayState(
      { usedPercentage: 23.5, resetsAt: 1_700_010_000 },
      1_700_000_000_000
    );
    expect(state).toEqual({ kind: "ready", percentage: 24, remaining: "2h 46m" });
  });
});
