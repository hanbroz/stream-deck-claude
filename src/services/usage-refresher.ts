import { spawn } from "node:child_process";
import path from "node:path";

import type { UsageCache } from "../domain/rate-limits";
import { writeMergedUsageCache } from "../io/usage-cache";
import { resolveClaudePath } from "./companion-launcher";

/**
 * Self-serve usage refresh.
 *
 * The OMC statusline cache only updates while an interactive TUI session is
 * open, so the five-hour window regularly outlives it and the key falls to
 * RESET DUE with no way to recover. `claude --print` answers the /usage
 * builtin in ~2s with no model call and no token cost, in a fixed English
 * format — the plugin parses it and merges the result into its own
 * usage.json, making the keys self-sufficient.
 */
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

/** Epoch ms for a wall-clock time in an IANA zone (single-iteration offset). */
function zonedTimeToEpochMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): number | undefined {
  const utcGuess = Date.UTC(year, month, day, hour, minute);
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false
    });
    const parts = Object.fromEntries(
      formatter.formatToParts(utcGuess).map((part) => [part.type, part.value])
    );
    const wallAsUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)
    );
    return utcGuess - (wallAsUtc - utcGuess);
  } catch {
    return undefined; // unknown zone name — skip this window
  }
}

/** `Jul 24, 6:40pm (Asia/Seoul)` → epoch seconds (minutes optional: `5am`). */
function parseResetTime(text: string, nowMs: number): number | undefined {
  const match = /([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/iu.exec(text);
  if (!match) {
    return undefined;
  }
  const month = MONTHS[match[1].toLowerCase()];
  if (month === undefined) {
    return undefined;
  }
  const day = Number(match[2]);
  let hour = Number(match[3]) % 12;
  if (match[5].toLowerCase() === "pm") {
    hour += 12;
  }
  const minute = match[4] === undefined ? 0 : Number(match[4]);
  const zone = match[6].trim();

  // No year in the text: assume the current one, rolling over at new year.
  const year = new Date(nowMs).getUTCFullYear();
  for (const candidate of [year, year + 1]) {
    const epochMs = zonedTimeToEpochMs(candidate, month, day, hour, minute, zone);
    if (epochMs === undefined) {
      return undefined;
    }
    // Resets are always in the future (up to 5h/7d); a "past" hit means the
    // year rolled over between the reset and now.
    if (epochMs > nowMs - 60_000) {
      return Math.round(epochMs / 1000);
    }
  }
  return undefined;
}

function parseWindowLine(
  output: string,
  label: RegExp,
  nowMs: number
): { usedPercentage: number; resetsAt: number } | undefined {
  const match = label.exec(output);
  if (!match) {
    return undefined;
  }
  const percentage = Number(match[1]);
  const resetsAt = parseResetTime(match[2], nowMs);
  return Number.isFinite(percentage) && percentage >= 0 && percentage <= 100 && resetsAt !== undefined
    ? { usedPercentage: percentage, resetsAt }
    : undefined;
}

/** Parse the /usage builtin's text reply into the local usage cache schema. */
export function parseUsageCliOutput(output: string, nowMs = Date.now()): UsageCache | undefined {
  const fiveHour = parseWindowLine(
    output,
    /Current session:\s*(\d+)%\s*used[^\n]*?resets\s+([^\n]+)/iu,
    nowMs
  );
  const sevenDay = parseWindowLine(
    output,
    /Current week \(all models\):\s*(\d+)%\s*used[^\n]*?resets\s+([^\n]+)/iu,
    nowMs
  );
  if (!fiveHour && !sevenDay) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    capturedAt: nowMs,
    rateLimits: {
      ...(fiveHour ? { fiveHour } : {}),
      ...(sevenDay ? { sevenDay } : {})
    }
  };
}

function runUsageCli(claudePath: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // --setting-sources "" keeps the call hermetic: without it the user's
    // hook stack boots for ~2 minutes per call (measured) instead of ~2s.
    const child = spawn(
      claudePath,
      ["--dangerously-skip-permissions", "--print", "--output-format", "text", "--setting-sources", ""],
      { cwd, windowsHide: true }
    );
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("usage refresh timed out"));
    }, 60_000);
    child.stdout.on("data", (data) => { stdout += data; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", () => { clearTimeout(timer); resolve(stdout); });
    child.stdin.write("/usage");
    child.stdin.end();
  });
}

const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

// Shared across the five-hour and weekly actions: one refresh serves both.
let lastAttemptAtMs = 0;
let inFlight: Promise<void> | undefined;

/**
 * Refresh usage.json via the CLI, at most once per cooldown window across all
 * usage keys. Fire-and-forget: the next 1s render tick picks up the result.
 */
export function maybeRefreshUsageViaCli(dataDir: string, nowMs = Date.now()): Promise<void> {
  if (inFlight) {
    return inFlight;
  }
  if (nowMs - lastAttemptAtMs < REFRESH_COOLDOWN_MS) {
    return Promise.resolve();
  }
  lastAttemptAtMs = nowMs;
  inFlight = (async () => {
    const claudePath = await resolveClaudePath();
    const output = await runUsageCli(claudePath, dataDir);
    const cache = parseUsageCliOutput(output);
    if (cache) {
      await writeMergedUsageCache(path.join(dataDir, "usage.json"), cache);
    }
  })().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}
