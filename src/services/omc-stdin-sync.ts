import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

import {
  listOmcStdinCacheCandidates,
  readNewestOmcStdinCache,
  type OmcStdinCacheRoots,
  type OmcStdinSnapshot
} from "../io/omc-stdin-cache";
import { readUsageCache, writeUsageCacheIfNewer } from "../io/usage-cache";

/**
 * Mirror OMC's status-line snapshot into usage.json.
 *
 * When OMC HUD owns Claude Code's single status-line slot our own bridge
 * never sees the `rate_limits` payload. OMC persists that payload after every
 * render, so copying it over gives the keys exactly what OMC shows, at the
 * cadence OMC gets it, without touching the status-line slot at all.
 */

const CANDIDATE_LIST_TTL_MS = 60 * 1000;

export type OmcStdinSyncResult = {
  /** The newest OMC snapshot found, whether or not it was copied. */
  snapshot?: OmcStdinSnapshot;
  /** Capture time of usage.json after the sync, from whichever source wrote it. */
  localCapturedAt?: number;
};

export class OmcStdinSync {
  private candidates: string[] = [];
  private candidatesListedAt = -Infinity;
  private lastSeenMtimeMs = -Infinity;
  private lastSnapshot?: OmcStdinSnapshot;
  private inFlight?: Promise<OmcStdinSyncResult>;

  constructor(private readonly roots: OmcStdinCacheRoots) {}

  private async listCandidates(nowMs: number): Promise<string[]> {
    if (nowMs - this.candidatesListedAt >= CANDIDATE_LIST_TTL_MS) {
      this.candidates = await listOmcStdinCacheCandidates(this.roots);
      this.candidatesListedAt = nowMs;
    }
    return this.candidates;
  }

  private async newestMtimeMs(candidates: string[]): Promise<number> {
    const mtimes = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          const info = await stat(candidate);
          return info.isFile() ? info.mtimeMs : -Infinity;
        } catch {
          return -Infinity;
        }
      })
    );
    return Math.max(-Infinity, ...mtimes);
  }

  /**
   * Read the newest snapshot and, when it is newer than usage.json, write it
   * to `<dataDir>/usage.json`. A snapshot carrying both windows is a complete
   * picture of the logged-in account and replaces the file (a merge would
   * keep a previous account's later-resetting window alive); a partial one is
   * merged so the other window is not lost.
   *
   * Both usage actions call this every second; calls coalesce onto one
   * in-flight sync, and nothing is read or written while no candidate file
   * has changed since the last look.
   */
  sync(dataDir: string, nowMs = Date.now()): Promise<OmcStdinSyncResult> {
    if (!this.inFlight) {
      this.inFlight = this.syncOnce(dataDir, nowMs).finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  private async syncOnce(dataDir: string, nowMs: number): Promise<OmcStdinSyncResult> {
    const cachePath = path.join(dataDir, "usage.json");
    const candidates = await this.listCandidates(nowMs);
    const newestMtimeMs = await this.newestMtimeMs(candidates);
    if (newestMtimeMs <= this.lastSeenMtimeMs) {
      return this.unchanged(cachePath);
    }
    const snapshot = await readNewestOmcStdinCache(candidates, nowMs);
    this.lastSeenMtimeMs = newestMtimeMs;
    if (!snapshot) {
      return this.unchanged(cachePath);
    }
    this.lastSnapshot = snapshot;

    // Nothing on the read path creates the data dir; without it the lock
    // file cannot be opened and every tick would fail.
    await mkdir(dataDir, { recursive: true });
    // Never regress usage.json: with our own bridge installed it can be
    // newer than anything OMC wrote (OMC snapshots stop when OMC is not the
    // status line, but the file can linger for a day). The comparison runs
    // under the cache lock so a bridge write cannot slip in between.
    const { fiveHour, sevenDay } = snapshot.cache.rateLimits;
    const written = await writeUsageCacheIfNewer(cachePath, snapshot.cache, {
      merge: !(fiveHour && sevenDay)
    });
    return { snapshot, localCapturedAt: written.capturedAt };
  }

  private async unchanged(cachePath: string): Promise<OmcStdinSyncResult> {
    const existing = await readUsageCache(cachePath).catch(() => undefined);
    return { snapshot: this.lastSnapshot, localCapturedAt: existing?.capturedAt };
  }
}
