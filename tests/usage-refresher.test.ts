import { describe, expect, it } from "vitest";

import { parseUsageCliOutput } from "../src/services/usage-refresher";

// A verbatim /usage reply (fixed English format, IANA zone in parentheses).
const SAMPLE = [
  "You are currently using your subscription to power your Claude Code usage",
  "",
  "Current session: 69% used · resets Jul 24, 6:40pm (Asia/Seoul)",
  "Current week (all models): 75% used · resets Jul 29, 4:59am (Asia/Seoul)",
  "Current week (Fable): 52% used · resets Jul 29, 5am (Asia/Seoul)",
  "",
  "What's contributing to your limits usage?"
].join("\n");

describe("parseUsageCliOutput", () => {
  const nowMs = Date.UTC(2026, 6, 24, 5, 0); // 2026-07-24 14:00 KST

  it("parses both windows with zone-correct epoch reset times", () => {
    const cache = parseUsageCliOutput(SAMPLE, nowMs);
    expect(cache?.rateLimits.fiveHour).toEqual({
      usedPercentage: 69,
      // 6:40pm KST = 09:40 UTC
      resetsAt: Date.UTC(2026, 6, 24, 9, 40) / 1000
    });
    expect(cache?.rateLimits.sevenDay).toEqual({
      usedPercentage: 75,
      resetsAt: Date.UTC(2026, 6, 28, 19, 59) / 1000
    });
    expect(cache?.capturedAt).toBe(nowMs);
  });

  it("handles minute-less times and rolls the year over past December", () => {
    // 2026-12-31 22:00 KST — the "Jan 1, 2am" reset lands in the next year.
    const decemberNow = Date.UTC(2026, 11, 31, 13, 0);
    const cache = parseUsageCliOutput(
      "Current session: 10% used · resets Jan 1, 2am (Asia/Seoul)",
      decemberNow
    );
    // Jan 1, 2am KST is already 2027 relative to a Dec 31 "now".
    expect(cache?.rateLimits.fiveHour).toEqual({
      usedPercentage: 10,
      resetsAt: Date.UTC(2026, 11, 31, 17, 0) / 1000
    });
  });

  it("returns undefined when the reply has no parsable windows", () => {
    expect(parseUsageCliOutput("Unknown command: /usage", nowMs)).toBeUndefined();
    expect(parseUsageCliOutput("", nowMs)).toBeUndefined();
  });
});
