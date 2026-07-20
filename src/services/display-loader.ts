import {
  getDisplayState,
  selectRateLimitWindow,
  type RateLimitKind,
  type UsageDisplayState
} from "../domain/rate-limits";
import { readUsageCache } from "../io/usage-cache";

export type DisplayLoaderOptions = {
  cachePath: string;
  bridgeInstalled: boolean;
  nowMs?: number;
};

export async function loadUsageDisplayState(
  kind: RateLimitKind,
  options: DisplayLoaderOptions
): Promise<UsageDisplayState> {
  try {
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
