import {
  getDisplayState,
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

export async function loadUsageDisplayState(
  kind: RateLimitKind,
  options: DisplayLoaderOptions
): Promise<UsageDisplayState> {
  try {
    if (options.statusLineConflict) {
      if (options.externalUsageCachePath) {
        const externalCache = await readOmcUsageCache(
          options.externalUsageCachePath,
          options.nowMs
        );
        const externalWindow = externalCache && selectRateLimitWindow(externalCache, kind);
        if (externalWindow) {
          return getDisplayState(externalWindow, options.nowMs);
        }
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
