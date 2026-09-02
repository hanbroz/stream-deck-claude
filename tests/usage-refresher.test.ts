import { describe, expect, it } from "vitest";

import { parseUsageApiResponse } from "../src/services/usage-refresher";

// A verbatim /api/oauth/usage reply shape.
const SAMPLE = {
  five_hour: { utilization: 69, resets_at: "2026-07-24T09:40:00Z" },
  seven_day: { utilization: 75, resets_at: "2026-07-28T19:59:00Z" }
};

describe("parseUsageApiResponse", () => {
  const nowMs = Date.UTC(2026, 6, 24, 5, 0);

  it("parses both windows into epoch-second resets", () => {
    const cache = parseUsageApiResponse(SAMPLE, nowMs);
    expect(cache?.rateLimits.fiveHour).toEqual({
      usedPercentage: 69,
      resetsAt: Date.UTC(2026, 6, 24, 9, 40) / 1000
    });
    expect(cache?.rateLimits.sevenDay).toEqual({
      usedPercentage: 75,
      resetsAt: Date.UTC(2026, 6, 28, 19, 59) / 1000
    });
    expect(cache?.capturedAt).toBe(nowMs);
  });

  it("parses a five_hour-only response", () => {
    const cache = parseUsageApiResponse(
      { five_hour: { utilization: 10, resets_at: "2027-01-01T17:00:00Z" } },
      nowMs
    );
    expect(cache?.rateLimits.fiveHour).toEqual({
      usedPercentage: 10,
      resetsAt: Date.UTC(2027, 0, 1, 17, 0) / 1000
    });
    expect(cache?.rateLimits.sevenDay).toBeUndefined();
  });

  it("clamps out-of-range utilization into 0-100", () => {
    const cache = parseUsageApiResponse(
      { five_hour: { utilization: 142, resets_at: "2026-07-24T09:40:00Z" } },
      nowMs
    );
    expect(cache?.rateLimits.fiveHour?.usedPercentage).toBe(100);
  });

  it("returns undefined when the response has no parsable windows", () => {
    expect(parseUsageApiResponse({}, nowMs)).toBeUndefined();
    expect(parseUsageApiResponse({ five_hour: { utilization: 5 } }, nowMs)).toBeUndefined();
  });
});

describe("cooldownAfterFailure", () => {
  it("honours retry-after on 429 and never retries sooner than the base cooldown", async () => {
    const { cooldownAfterFailure } = await import("../src/services/usage-refresher");
    expect(cooldownAfterFailure("http_429", 348_000)).toBe(348_000);
    expect(cooldownAfterFailure("http_429", 1_000)).toBe(5 * 60 * 1000);
    expect(cooldownAfterFailure("http_429")).toBe(60 * 60 * 1000);
  });

  it("backs off for hours on 403/401 and keeps the base cooldown for transient errors", async () => {
    const { cooldownAfterFailure } = await import("../src/services/usage-refresher");
    expect(cooldownAfterFailure("http_403")).toBe(6 * 60 * 60 * 1000);
    expect(cooldownAfterFailure("http_401")).toBe(6 * 60 * 60 * 1000);
    expect(cooldownAfterFailure("timeout")).toBe(5 * 60 * 1000);
    expect(cooldownAfterFailure("network:ECONNRESET")).toBe(5 * 60 * 1000);
  });
});
