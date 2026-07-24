import {
  getDisplayState,
  mergeUsageCaches,
  selectRateLimitWindow,
  type RateLimitKind,
  type UsageDisplayState
} from "../domain/rate-limits";
import { readOmcUsageCache, readUsageCache } from "../io/usage-cache";

export type DisplayLoaderOptions = {
  cachePath: string;
  bridgeInstalled: boolean;
  statusLineConflict?: boolean;
  externalUsageCachePath?: string;
  nowMs?: number;
};

export type LastGoodUsage = { state: UsageDisplayState; atMs: number };

const LAST_GOOD_HOLD_MS = 15 * 60 * 1000;
// The refresher keeps usage.json at most ~10 minutes old, so a fresh local
// cache means the CLI pipeline is alive and its numbers are current.
const LOCAL_CACHE_FRESH_MS = 15 * 60 * 1000;

/**
 * Ride out transient cache gaps: a momentary read failure (OMC rewriting its
 * cache file, a one-off poll error) must not flash the key over to the
 * STATUSLINE BUSY / NO DATA cards. Data states refresh the hold; data-less
 * states reuse the last good one for up to 15 minutes. "setup" is never held
 * — that one is a real call to action.
 */
export function withLastGoodHold(
  state: UsageDisplayState,
  lastGood: LastGoodUsage | undefined,
  nowMs = Date.now(),
  holdMs = LAST_GOOD_HOLD_MS
): { state: UsageDisplayState; lastGood: LastGoodUsage | undefined } {
  if (state.kind === "ready" || state.kind === "expired") {
    return { state, lastGood: { state, atMs: nowMs } };
  }
  if (state.kind !== "setup" && lastGood && nowMs - lastGood.atMs < holdMs) {
    return { state: lastGood.state, lastGood };
  }
  return { state, lastGood };
}

export async function loadUsageDisplayState(
  kind: RateLimitKind,
  options: DisplayLoaderOptions
): Promise<UsageDisplayState> {
  try {
    if (options.statusLineConflict) {
      const nowMs = options.nowMs ?? Date.now();
      const localCache = await readUsageCache(options.cachePath).catch(() => undefined);
      // The CLI self-refresh is authoritative (it parses `claude /usage`
      // directly). While it is fresh it wins outright: merging by resetsAt
      // let a poisoned OMC cache (0% with an inflated reset time, seen in
      // the field after an OMC update) beat correct numbers.
      if (localCache && nowMs - localCache.capturedAt <= LOCAL_CACHE_FRESH_MS) {
        const localWindow = selectRateLimitWindow(localCache, kind);
        if (localWindow) {
          return getDisplayState(localWindow, nowMs);
        }
      }
      const externalCache = options.externalUsageCachePath
        ? await readOmcUsageCache(options.externalUsageCachePath, nowMs)
        : undefined;
      const merged = externalCache && localCache
        ? mergeUsageCaches(localCache, externalCache)
        : externalCache ?? localCache;
      const window = merged && selectRateLimitWindow(merged, kind);
      if (window) {
        return getDisplayState(window, nowMs);
      }
      return { kind: "statusline-conflict" };
    }
    const cache = await readUsageCache(options.cachePath);
    if (!cache) {
      return options.bridgeInstalled ? { kind: "waiting" } : { kind: "setup" };
    }

    const window = selectRateLimitWindow(cache, kind);
    if (!window) {
      return { kind: "waiting" };
    }
    return getDisplayState(window, options.nowMs);
  } catch {
    return { kind: "error" };
  }
}
