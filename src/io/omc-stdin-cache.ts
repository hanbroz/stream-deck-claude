import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { extractUsageCache, type UsageCache } from "../domain/rate-limits";

/**
 * OMC's status-line snapshot.
 *
 * OMC HUD does not get the five-hour / weekly numbers from Anthropic's usage
 * API — it reads `rate_limits` straight out of the JSON Claude Code pipes to
 * the status-line command, and persists that whole payload to
 * `<omc-root>/state/hud-stdin-cache.json` on every render (its `--watch`
 * mode reads it back). That file is therefore the same data OMC displays,
 * refreshed as often as the status line is, and it keeps working when the
 * usage API is unreachable (throttled, 403, expired credentials file).
 *
 * The payload carries no timestamp of its own; the file mtime is the capture
 * time. OMC may write it to the flat path or to a per-session directory, so
 * every candidate is scanned and the newest valid one wins.
 */

const STDIN_CACHE_FILE = "hud-stdin-cache.json";
// Generous on purpose, matching the OMC API cache cutoff: percentages cannot
// rise while Claude is idle and getDisplayState flips to RESET DUE once
// resetsAt passes, so this only needs to reject a machine where OMC stopped
// writing entirely.
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type OmcStdinSnapshot = {
  path: string;
  capturedAt: number;
  cache: UsageCache;
  /** Claude Code version from the payload, when present. */
  clientVersion?: string;
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

async function listDirectories(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && SESSION_ID_PATTERN.test(entry.name))
      .map((entry) => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

async function candidatesUnderStateRoot(omcRoot: string): Promise<string[]> {
  const stateDir = path.join(omcRoot, "state");
  const sessions = await listDirectories(path.join(stateDir, "sessions"));
  return [
    path.join(stateDir, STDIN_CACHE_FILE),
    ...sessions.map((sessionDir) => path.join(sessionDir, STDIN_CACHE_FILE))
  ];
}

/**
 * Every file OMC might have written the snapshot to under the given roots.
 * A root is either an OMC root (`~/.omc`, `<project>/.omc`) or an
 * `OMC_STATE_DIR`, whose immediate children are per-project OMC roots.
 */
export async function listOmcStdinCacheCandidates(roots: string[]): Promise<string[]> {
  const candidates: string[] = [];
  for (const root of roots) {
    candidates.push(...(await candidatesUnderStateRoot(root)));
    for (const projectRoot of await listDirectories(root)) {
      if (path.basename(projectRoot) === "state") {
        continue;
      }
      candidates.push(...(await candidatesUnderStateRoot(projectRoot)));
    }
  }
  return [...new Set(candidates)];
}

/** Parse one snapshot payload; `capturedAt` is the file's mtime. */
export function parseOmcStdinCache(
  payload: unknown,
  capturedAt: number
): Omit<OmcStdinSnapshot, "path"> | undefined {
  const cache = extractUsageCache(payload, capturedAt);
  if (!cache) {
    return undefined;
  }
  const version = asRecord(payload)?.version;
  return {
    capturedAt,
    cache,
    ...(typeof version === "string" && version.length > 0 ? { clientVersion: version } : {})
  };
}

/**
 * The newest usable snapshot among the candidates, or undefined when none is
 * present, parseable, or younger than `maxAgeMs`.
 */
export async function readNewestOmcStdinCache(
  candidates: string[],
  nowMs = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS
): Promise<OmcStdinSnapshot | undefined> {
  const stats = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const info = await stat(candidate);
        return info.isFile() ? { path: candidate, mtimeMs: info.mtimeMs } : undefined;
      } catch {
        return undefined;
      }
    })
  );
  const ordered = stats
    .filter((entry): entry is { path: string; mtimeMs: number } => entry !== undefined)
    .filter((entry) => nowMs - entry.mtimeMs <= maxAgeMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const entry of ordered) {
    try {
      const payload = JSON.parse(await readFile(entry.path, "utf8")) as unknown;
      // A clock jump or a synced folder can hand us an mtime in the future;
      // clamp it so the snapshot cannot outrank everything written after it.
      const parsed = parseOmcStdinCache(payload, Math.min(Math.floor(entry.mtimeMs), nowMs));
      if (parsed) {
        return { path: entry.path, ...parsed };
      }
    } catch {
      // A corrupt newest file must not hide an older valid one.
    }
  }
  return undefined;
}
