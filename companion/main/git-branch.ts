import { open, stat } from "node:fs/promises";
import path from "node:path";

export type GitBranchInfo = {
  // false means the folder is not inside a work tree at all. true with no
  // branch means it IS one, but HEAD could not be named.
  tracked: boolean;
  // Branch name for a normal checkout, short commit id when detached.
  branch?: string;
  detached?: boolean;
};

const NOT_TRACKED: GitBranchInfo = { tracked: false };
// A work tree was found but could not be named. Saying "not a repository"
// here would assert the opposite of what we know.
const TRACKED_UNKNOWN: GitBranchInfo = { tracked: true };

const GITDIR_PREFIX = "gitdir:";
const HEAD_REF_PREFIX = "ref:";
const HEADS_PREFIX = "refs/heads/";
// sha1 today, sha256 once a repo opts into it.
const COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/iu;
// A real .git pointer or HEAD is well under this. The indicator re-reads every
// few seconds, so an oversized file must not be pulled into memory each time.
const MAX_READ_BYTES = 4096;

/** Read at most MAX_READ_BYTES, so a huge file cannot be slurped on a timer. */
async function readHead(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(MAX_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_READ_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Walk up from `startPath` to the first `.git`, mirroring how git itself finds
 * a repository. Returns the git directory that holds HEAD, or undefined when
 * the path is outside any work tree.
 *
 * Throws when a `.git` exists here but cannot be understood: continuing up
 * would report an ENCLOSING repository's branch as this folder's own, which is
 * worse than admitting we do not know.
 */
async function resolveGitDir(startPath: string): Promise<string | undefined> {
  let directory = path.resolve(startPath);
  for (;;) {
    const candidate = path.join(directory, ".git");
    let entry;
    try {
      entry = await stat(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      // Genuinely nothing here — that is ordinary, keep walking up.
      const parent = path.dirname(directory);
      if (parent === directory) {
        return undefined;
      }
      directory = parent;
      continue;
    }
    if (entry.isDirectory()) {
      return candidate;
    }
    // A linked worktree or a submodule stores a "gitdir: <path>" pointer file
    // instead of a directory; its HEAD lives at the far end of that pointer.
    // Submodules write that path relative to the .git file's own directory.
    const pointer = (await readHead(candidate)).trim();
    if (!pointer.startsWith(GITDIR_PREFIX)) {
      throw new Error(`.git at ${candidate} is neither a directory nor a gitdir pointer`);
    }
    return path.resolve(directory, pointer.slice(GITDIR_PREFIX.length).trim());
  }
}

/**
 * Read-only branch lookup for the status bar. Reads .git/HEAD directly rather
 * than spawning git, so it costs one small read per poll and works even when
 * git is not on PATH.
 */
export async function readGitBranch(rootPath: string): Promise<GitBranchInfo> {
  let gitDir: string | undefined;
  try {
    gitDir = await resolveGitDir(rootPath);
  } catch {
    return TRACKED_UNKNOWN;
  }
  if (!gitDir) {
    return NOT_TRACKED;
  }
  try {
    const head = (await readHead(path.join(gitDir, "HEAD"))).trim();
    if (head.startsWith(HEAD_REF_PREFIX)) {
      const ref = head.slice(HEAD_REF_PREFIX.length).trim();
      // Branch names keep their own slashes: refs/heads/feat/a -> feat/a.
      const branch = ref.startsWith(HEADS_PREFIX) ? ref.slice(HEADS_PREFIX.length) : ref;
      return branch ? { tracked: true, branch } : TRACKED_UNKNOWN;
    }
    // Detached HEAD holds a raw commit id; show the short form git itself uses.
    return COMMIT_ID.test(head)
      ? { tracked: true, branch: head.slice(0, 7), detached: true }
      : TRACKED_UNKNOWN;
  } catch {
    // The work tree was found; HEAD just would not read — a checkout swapping
    // it under us on Windows, or a permission error. Still a repository.
    return TRACKED_UNKNOWN;
  }
}
