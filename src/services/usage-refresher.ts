import { readFile } from "node:fs/promises";
import https from "node:https";
import path from "node:path";

import { streamDeck } from "@elgato/streamdeck";

import { defaultClaudeCredentialsPath } from "../bridge/paths";
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
    const raw = await readFile(defaultClaudeCredentialsPath(), "utf8");
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

type FetchOutcome =
  | { ok: true; response: UsageApiResponse }
  | { ok: false; reason: string; retryAfterMs?: number };

function parseRetryAfterMs(header: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) {
    return undefined;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function fetchUsageFromApi(accessToken: string): Promise<FetchOutcome> {
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
        // The request's 'error' does not cover the response stream: a
        // connection dropped mid-body emits here, and unhandled it would
        // take the plugin process down.
        res.on("error", (error) => resolve({ ok: false, reason: `network:${error.message}` }));
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve({
              ok: false,
              reason: `http_${res.statusCode}`,
              retryAfterMs: parseRetryAfterMs(res.headers["retry-after"])
            });
            return;
          }
          try {
            resolve({ ok: true, response: JSON.parse(body) as UsageApiResponse });
          } catch {
            resolve({ ok: false, reason: "invalid_json" });
          }
        });
      }
    );
    req.on("error", (error) => resolve({ ok: false, reason: `network:${error.message}` }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, reason: "timeout" });
    });
    req.end();
  });
}

const REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
// The endpoint buckets its rate limit by User-Agent and a bare Node request
// lands in a bucket that allows roughly one call per hour; with the bucket
// exhausted it answers 429 (with a retry-after), and it has also been seen
// answering 403 outright. Neither is worth re-asking every five minutes.
const RATE_LIMITED_COOLDOWN_MS = 60 * 60 * 1000;
const FORBIDDEN_COOLDOWN_MS = 6 * 60 * 60 * 1000;
// A usage.json this young (from our bridge, OMC's snapshot, or a previous
// API success) means the keys already have live data and the API call would
// only spend the hourly budget.
const LOCAL_CACHE_FRESH_MS = 15 * 60 * 1000;

export function cooldownAfterFailure(reason: string, retryAfterMs?: number): number {
  if (reason === "http_429") {
    return Math.max(REFRESH_COOLDOWN_MS, retryAfterMs ?? RATE_LIMITED_COOLDOWN_MS);
  }
  if (reason === "http_403" || reason === "http_401") {
    return FORBIDDEN_COOLDOWN_MS;
  }
  return REFRESH_COOLDOWN_MS;
}

// Shared across the five-hour and weekly actions: one refresh serves both.
let nextAttemptAtMs = 0;
let lastLoggedReason: string | undefined;
let inFlight: Promise<void> | undefined;

export type RefreshOptions = {
  /** Capture time of the current usage.json, if any. */
  localCapturedAt?: number;
};

/**
 * Refresh usage.json from Anthropic's usage API directly, at most once per
 * cooldown window across all usage keys, and not at all while usage.json is
 * fresh. Fire-and-forget: the next 1s render tick picks up the
 * result.
 */
export function maybeRefreshUsageViaApi(
  dataDir: string,
  nowMs = Date.now(),
  options: RefreshOptions = {}
): Promise<void> {
  if (inFlight) {
    return inFlight;
  }
  if (nowMs < nextAttemptAtMs) {
    return Promise.resolve();
  }
  if (
    options.localCapturedAt !== undefined &&
    nowMs - options.localCapturedAt <= LOCAL_CACHE_FRESH_MS
  ) {
    return Promise.resolve();
  }
  nextAttemptAtMs = nowMs + REFRESH_COOLDOWN_MS;
  inFlight = (async () => {
    const accessToken = await resolveAccessToken();
    if (!accessToken) {
      streamDeck.logger.info("Usage API refresh skipped: no access token available.");
      return;
    }
    const outcome = await fetchUsageFromApi(accessToken);
    if (!outcome.ok) {
      const cooldownMs = cooldownAfterFailure(outcome.reason, outcome.retryAfterMs);
      nextAttemptAtMs = Date.now() + cooldownMs;
      if (outcome.reason !== lastLoggedReason) {
        lastLoggedReason = outcome.reason;
        streamDeck.logger.info(
          `Usage API refresh failed: ${outcome.reason}; next attempt in ${Math.round(cooldownMs / 60_000)} min.`
        );
      }
      return;
    }
    lastLoggedReason = undefined;
    const cache = parseUsageApiResponse(outcome.response);
    if (cache) {
      // Replace, never merge: this is a complete snapshot of the account
      // that is logged in RIGHT NOW. Merging kept the previous account's
      // weekly window (with its later reset) alive after a login switch.
      await writeUsageCache(path.join(dataDir, "usage.json"), cache);
    } else {
      streamDeck.logger.info("Usage API refresh returned no usable rate-limit windows.");
    }
  })().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}
