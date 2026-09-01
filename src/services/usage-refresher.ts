import { readFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";

import type { UsageCache } from "../domain/rate-limits";
import { writeUsageCache } from "../io/usage-cache";

/**
 * Self-serve usage refresh.
 *
 * The OMC statusline cache only updates while an interactive TUI session is
 * open, so the five-hour window regularly outlives it and the key falls to
 * RESET DUE with no way to recover. This calls Anthropic's usage API
 * directly — the same endpoint Claude Code itself reads — and merges the
 * result into its own usage.json, making the keys self-sufficient.
 *
 * This used to spawn `claude --print` and pipe it "/usage", parsing the
 * reply text. That stopped producing any output in print mode (0 tokens,
 * empty stdout) — the built-in command isn't reachable that way — so this
 * talks to the API directly instead.
 */

const USAGE_API_HOSTNAME = "api.anthropic.com";
const USAGE_API_PATH = "/api/oauth/usage";
const API_TIMEOUT_MS = 10_000;

type UsageApiWindow = { utilization?: number; resets_at?: string };
type UsageApiResponse = {
  five_hour?: UsageApiWindow;
  seven_day?: UsageApiWindow;
};

function clampPercentage(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : undefined;
}

function parseResetsAt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed / 1000 : undefined;
}

/** Parse the `/api/oauth/usage` JSON body into the local usage cache schema. */
export function parseUsageApiResponse(
  response: UsageApiResponse,
  nowMs = Date.now()
): UsageCache | undefined {
  const fiveHourPercentage = clampPercentage(response.five_hour?.utilization);
  const fiveHourResetsAt = parseResetsAt(response.five_hour?.resets_at);
  const sevenDayPercentage = clampPercentage(response.seven_day?.utilization);
  const sevenDayResetsAt = parseResetsAt(response.seven_day?.resets_at);

  const fiveHour =
    fiveHourPercentage !== undefined && fiveHourResetsAt !== undefined
      ? { usedPercentage: fiveHourPercentage, resetsAt: fiveHourResetsAt }
      : undefined;
  const sevenDay =
    sevenDayPercentage !== undefined && sevenDayResetsAt !== undefined
      ? { usedPercentage: sevenDayPercentage, resetsAt: sevenDayResetsAt }
      : undefined;

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

/**
 * Resolve a bearer token for the usage API. `CLAUDE_CODE_OAUTH_TOKEN` is a
 * long-lived, non-rotating token some users switch to specifically to avoid
 * refresh-token races on `~/.claude/.credentials.json` — Claude Code then
 * blanks that file's accessToken/refreshToken, so it stops being a usable
 * fallback for that setup. When the env var isn't set, fall back to the
 * file for the standard login flow.
 *
 * ponytail: no refresh-token flow here — an expired file-based token just
 * means no fresh data this cycle (the stale cache stays up), not a crash.
 * Add refresh if that turns out not to be enough.
 */
async function resolveAccessToken(): Promise<string | undefined> {
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken) {
    return envToken;
  }
  try {
    const credentialsPath = path.join(os.homedir(), ".claude", ".credentials.json");
    const raw = await readFile(credentialsPath, "utf8");
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number };
    };
    const creds = parsed.claudeAiOauth;
    if (!creds?.accessToken) {
      return undefined;
    }
    if (typeof creds.expiresAt === "number" && creds.expiresAt <= Date.now()) {
      return undefined;
    }
    return creds.accessToken;
  } catch {
    return undefined;
  }
}

function fetchUsageFromApi(accessToken: string): Promise<UsageApiResponse | undefined> {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: USAGE_API_HOSTNAME,
        path: USAGE_API_PATH,
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "anthropic-beta": "oauth-2025-04-20"
        },
        timeout: API_TIMEOUT_MS
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve(undefined);
            return;
          }
          try {
            resolve(JSON.parse(body) as UsageApiResponse);
          } catch {
            resolve(undefined);
          }
        });
      }
    );
    req.on("error", () => resolve(undefined));
    req.on("timeout", () => {
      req.destroy();
      resolve(undefined);
    });
    req.end();
  });
}

const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

// Shared across the five-hour and weekly actions: one refresh serves both.
let lastAttemptAtMs = 0;
let inFlight: Promise<void> | undefined;

/**
 * Refresh usage.json from Anthropic's usage API directly, at most once per
 * cooldown window across all usage keys. Fire-and-forget: the next 1s render
 * tick picks up the result.
 */
export function maybeRefreshUsageViaApi(dataDir: string, nowMs = Date.now()): Promise<void> {
  if (inFlight) {
    return inFlight;
  }
  if (nowMs - lastAttemptAtMs < REFRESH_COOLDOWN_MS) {
    return Promise.resolve();
  }
  lastAttemptAtMs = nowMs;
  inFlight = (async () => {
    const accessToken = await resolveAccessToken();
    if (!accessToken) {
      return;
    }
    const response = await fetchUsageFromApi(accessToken);
    if (!response) {
      return;
    }
    const cache = parseUsageApiResponse(response);
    if (cache) {
      // Replace, never merge: this is a complete snapshot of the account
      // that is logged in RIGHT NOW. Merging kept the previous account's
      // weekly window (with its later reset) alive after a login switch.
      await writeUsageCache(path.join(dataDir, "usage.json"), cache);
    }
  })().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}
