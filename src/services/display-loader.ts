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
      const externalCache = options.externalUsageCachePath
        ? await readOmcUsageCache(options.externalUsageCachePath, options.nowMs)
        : undefined;
      // usage.json also carries the CLI self-refresh, so merge both sources
      // and let the newer window win (merge keeps the later resetsAt).
      const localCache = await readUsageCache(options.cachePath).catch(() => undefined);
      const merged = externalCache && localCache
        ? mergeUsageCaches(localCache, externalCache)
        : externalCache ?? localCache;
      const window = merged && selectRateLimitWindow(merged, kind);
      if (window) {
        return getDisplayState(window, options.nowMs);
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
