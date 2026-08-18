import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  MAX_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  queryLengthVerdict
} from "../shared/search-query";
import { listProjectFilesRecursive } from "./paths";

export type SearchHit = {
  /** 1-based line number, the way an editor counts. */
  line: number;
  /** Offset of the match inside `text`, not inside the original line. */
  column: number;
  /** The matching line, indent stripped and clipped around the match. */
  text: string;
};

export type SearchFileResult = {
  path: string;
  relativePath: string;
  hits: SearchHit[];
  /** The file had more hits than MAX_HITS_PER_FILE. */
  truncated: boolean;
};

export type ProjectSearchResult = {
  files: SearchFileResult[];
  /** Some part of the answer was cut by a cap — the result is a lower bound. */
  truncated: boolean;
  scanned: number;
  /**
   * The search was superseded and stopped early, so an empty `files` means
   * "never finished looking", not "nothing matches". Without this the two are
   * indistinguishable to anyone reading the result on its own.
   */
  cancelled?: boolean;
};

/**
 * Just the part of `AbortSignal` a scan reads.
 *
 * Structural rather than `AbortSignal` so a test can drive the per-batch guard
 * deterministically — timing an abort to land inside the scan loop and not
 * during the directory walk is otherwise a race.
 */
export type CancelSignal = { readonly aborted: boolean };

export const MAX_FILE_BYTES = 1024 * 1024;

export const MAX_HITS_PER_FILE = 20;
export const MAX_RESULT_FILES = 200;
export const SCAN_MAX_ENTRIES = 20_000;
export const SCAN_MAX_DEPTH = 12;

// git calls a blob binary when a NUL byte turns up early in it. Same probe here,
// so "text file" means the same thing in the search as it does in a diff.
const BINARY_PROBE_BYTES = 8192;
const SNIPPET_WIDTH = 200;
const SNIPPET_LEAD = 40;
// ponytail: fixed 16-way read concurrency. Raise it only if a real project
// feels slow — the caps already bound the total work.
const SCAN_CONCURRENCY = 16;

/**
 * The slice of `line` worth showing for a match at `matchIndex`.
 *
 * Indentation is dropped (a match 24 spaces in would otherwise render as an
 * empty row) and a long line is clipped to a window around the match. The
 * returned column is relative to the returned text, so the renderer highlights
 * by slicing and never re-searches.
 */
function snippetFor(
  line: string,
  matchIndex: number,
  matchLength: number
): { text: string; column: number } {
  const indent = line.length - line.trimStart().length;
  const body = line.slice(indent);
  const bodyIndex = matchIndex - indent;

  const width = Math.max(SNIPPET_WIDTH, matchLength + SNIPPET_LEAD);
  if (body.length <= width) {
    return { text: body, column: bodyIndex };
  }

  const start = Math.max(0, Math.min(bodyIndex - SNIPPET_LEAD, body.length - width));
  return { text: body.slice(start, start + width), column: bodyIndex - start };
}

/**
 * Every line of `content` containing `needle`, case-insensitively, up to
 * `maxHits`.
 *
 * ponytail: lowercasing per line is an ASCII/Korean-correct comparison. A few
 * characters change length when lowercased (Turkish dotted I), which would shift
 * the highlight by one; if that ever matters, compare with Intl.Collator instead.
 */
function findHits(
  content: string,
  needle: string,
  maxHits: number
): { hits: SearchHit[]; truncated: boolean } {
  const hits: SearchHit[] = [];
  const lowerNeedle = needle.toLowerCase();
  const lines = content.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!.endsWith("\r") ? lines[index]!.slice(0, -1) : lines[index]!;
    const at = raw.toLowerCase().indexOf(lowerNeedle);
    if (at === -1) {
      continue;
    }
    if (hits.length >= maxHits) {
      return { hits, truncated: true };
    }
    hits.push({ line: index + 1, ...snippetFor(raw, at, needle.length) });
  }

  return { hits, truncated: false };
}

/**
 * Scan one file, or skip it. Unreadable, oversized, and binary files all resolve
 * to undefined rather than throwing: a search must not fail because one file in
 * the project is a locked 4 GB database.
 */
async function scanFile(
  absolutePath: string,
  relativePath: string,
  needle: string
): Promise<SearchFileResult | undefined> {
  try {
    const info = await stat(absolutePath);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) {
      return undefined;
    }

    const buffer = await readFile(absolutePath);
    if (buffer.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
      return undefined;
    }

    // A UTF-8 BOM would otherwise ride along on line 1 and shift its columns.
    const { hits, truncated } = findHits(
      buffer.toString("utf8").replace(/^\uFEFF/u, ""),
      needle,
      MAX_HITS_PER_FILE
    );
    return hits.length === 0
      ? undefined
      : { path: absolutePath, relativePath, hits, truncated };
  } catch {
    return undefined;
  }
}

/**
 * Files under `root` whose text contains `query`.
 *
 * The file inventory comes from the "@" mention picker's walker, called with
 * wider caps: its ignore-list (.git, node_modules, dist, …) and depth limit are
 * already what a content search wants, and a second walker would be a second
 * thing to keep in sync.
 *
 * Every cap folds into a single `truncated` flag, so the UI can say the answer
 * is partial without the caller having to know which limit was hit.
 *
 * `signal` drops a superseded search. Typing runs one of these per debounced
 * keystroke, and without it every one ran to completion: the scans stacked up on
 * the same thread that forwards PTY output. An aborted search resolves empty and
 * never rejects — the renderer shows a rejection as a failed search, and being
 * superseded is not a failure.
 *
 * ponytail: the scan still runs on the main thread, bounded by SCAN_MAX_ENTRIES
 * and MAX_FILE_BYTES. If a large project ever feels janky while searching, move
 * scanFile onto a worker_thread; cancellation already has the shape for it.
 */
export async function searchProjectText(
  root: string,
  query: string,
  signal?: CancelSignal
): Promise<ProjectSearchResult> {
  const needle = query.trim();
  if (signal?.aborted) {
    return { files: [], truncated: false, scanned: 0, cancelled: true };
  }
  if (queryLengthVerdict(needle) !== "ok") {
    return { files: [], truncated: false, scanned: 0 };
  }

  const realRoot = await realpath(path.resolve(root));
  const relativePaths = await listProjectFilesRecursive(
    realRoot,
    SCAN_MAX_ENTRIES,
    SCAN_MAX_DEPTH,
    signal
  );
  if (signal?.aborted) {
    return { files: [], truncated: false, scanned: relativePaths.length, cancelled: true };
  }
  const walkTruncated = relativePaths.length >= SCAN_MAX_ENTRIES;

  const files: SearchFileResult[] = [];
  let capped = false;

  for (let index = 0; index < relativePaths.length; index += SCAN_CONCURRENCY) {
    // Checked per batch, not per file: a batch is 16 reads, so this drops a
    // superseded search within one batch of the keystroke that replaced it.
    if (signal?.aborted) {
      return {
        files: [],
        truncated: false,
        scanned: relativePaths.length,
        cancelled: true
      };
    }
    if (files.length >= MAX_RESULT_FILES) {
      capped = true;
      break;
    }
    const batch = await Promise.all(
      relativePaths
        .slice(index, index + SCAN_CONCURRENCY)
        .map((relativePath) =>
          scanFile(path.join(realRoot, relativePath), relativePath, needle)
        )
    );
    for (const result of batch) {
      if (result) {
        files.push(result);
      }
    }
  }

  // The last batch can overshoot the cap by up to SCAN_CONCURRENCY - 1.
  if (files.length > MAX_RESULT_FILES) {
    capped = true;
    files.length = MAX_RESULT_FILES;
  }

  return { files, truncated: walkTruncated || capped, scanned: relativePaths.length };
}
