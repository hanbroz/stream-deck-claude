export type RateLimitKind = "fiveHour" | "sevenDay";

export type RateLimitWindow = {
  usedPercentage: number;
  resetsAt: number;
};

export type UsageCache = {
  schemaVersion: 1;
  capturedAt: number;
  rateLimits: {
    fiveHour?: RateLimitWindow;
    sevenDay?: RateLimitWindow;
  };
};

export type UsageDisplayState =
  | { kind: "ready"; percentage: number; remaining: string }
  | { kind: "expired"; remaining: "REFRESH" }
  | { kind: "setup" }
  | { kind: "waiting" }
  | { kind: "error" };

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function parseWindow(value: unknown): RateLimitWindow | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const percentage = record.used_percentage;
  const resetsAt = record.resets_at;
  if (
    typeof percentage !== "number" ||
    !Number.isFinite(percentage) ||
    typeof resetsAt !== "number" ||
    !Number.isFinite(resetsAt) ||
    resetsAt <= 0
  ) {
    return undefined;
  }

  return {
    usedPercentage: Math.min(100, Math.max(0, percentage)),
    resetsAt
  };
}

export function extractUsageCache(
  statusLinePayload: unknown,
  capturedAt = Date.now()
): UsageCache | undefined {
  const root = asRecord(statusLinePayload);
  const rateLimits = asRecord(root?.rate_limits);
  if (!rateLimits) {
    return undefined;
  }

  const fiveHour = parseWindow(rateLimits.five_hour);
  const sevenDay = parseWindow(rateLimits.seven_day);
  if (!fiveHour && !sevenDay) {
    return undefined;
  }

  return {
    schemaVersion: 1,
    capturedAt,
    rateLimits: {
      ...(fiveHour ? { fiveHour } : {}),
      ...(sevenDay ? { sevenDay } : {})
    }
  };
}

export function selectRateLimitWindow(
  cache: UsageCache,
  kind: RateLimitKind
): RateLimitWindow | undefined {
  return cache.rateLimits[kind];
}

export function formatRemaining(resetAtEpochSeconds: number, nowMs = Date.now()): string {
  const remainingSeconds = Math.floor(resetAtEpochSeconds - nowMs / 1000);
  if (remainingSeconds <= 0) {
    return "REFRESH";
  }

  const totalMinutes = Math.floor(remainingSeconds / 60);
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours >= 24) {
    return `${Math.floor(totalHours / 24)}d ${totalHours % 24}h`;
  }

  if (totalHours >= 1) {
    return `${totalHours}h ${totalMinutes % 60}m`;
  }

  return `${Math.max(1, totalMinutes)}m`;
}

export function getDisplayState(
  window: RateLimitWindow,
  nowMs = Date.now()
): UsageDisplayState {
  const remaining = formatRemaining(window.resetsAt, nowMs);
  if (remaining === "REFRESH") {
    return { kind: "expired", remaining };
  }

  return {
    kind: "ready",
    percentage: Math.round(window.usedPercentage),
    remaining
  };
}
