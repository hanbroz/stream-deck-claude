import { open, stat } from "node:fs/promises";
import path from "node:path";

export type GitBranchInfo = {
  // false means the folder is not inside a work tree at all. true with no
  // branch means it IS one, but HEAD could not be named.
  tracked: boolean;
  // Branch name for a normal checkout, short commit id when detached.
  branch?: string;
  detached?: boolean;
  // Fetch URL of "origin" (or the first remote when there is no origin).
  // Absent when the repository has no remote configured at all.
  remote?: string;
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
// `[remote "origin"]` in .git/config, and the `url = ...` under it.
const REMOTE_SECTION = /^\[\s*remote\s+"([^"]*)"\s*\]/u;
const URL_ENTRY = /^url\s*=\s*(.*)$/iu;
// A real .git pointer or HEAD is well under this. The indicator re-reads every
// few seconds, so an oversized file must not be pulled into memory each time.
const MAX_READ_BYTES = 4096;
// A config carrying every remote and branch of a large repo still fits here.
const MAX_CONFIG_BYTES = 128 * 1024;

/** Read at most `maxBytes`, so a huge file cannot be slurped on a timer. */
async function readHead(filePath: string, maxBytes = MAX_READ_BYTES): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    // A file that filled the buffer was cut mid-line; that partial tail would
    // otherwise parse as a truncated URL, which is worse than no URL.
    return bytesRead < maxBytes ? text : text.slice(0, text.lastIndexOf("\n") + 1);
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
 * A remote URL may carry credentials as userinfo (https://oauth2:TOKEN@host/x).
 * Strip them: the address is what the user wants to read and paste, and a token
 * must never reach the clipboard or the screen. The scp-like form
 * (git@github.com:org/repo.git) has no "://" and is left alone.
 */
function stripCredentials(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/iu, "$1");
}

/**
 * Fetch URL of "origin", or of the first remote when there is no origin.
 * Undefined when the repository has no remote — the caller shows nothing then.
 */
async function readRemoteUrl(gitDir: string): Promise<string | undefined> {
  // A linked worktree has no config of its own; it points at the shared one.
  let configDir = gitDir;
  try {
    const commonDir = (await readHead(path.join(gitDir, "commondir"))).trim();
    if (commonDir) {
      configDir = path.resolve(gitDir, commonDir);
    }
  } catch {
    // No commondir file — an ordinary .git directory holds its own config.
  }

  let config: string;
  try {
    config = await readHead(path.join(configDir, "config"), MAX_CONFIG_BYTES);
  } catch {
    return undefined;
  }

  let section: string | undefined;
  let origin: string | undefined;
  let first: string | undefined;
  for (const rawLine of config.split("\n")) {
    const line = rawLine.trim();
    // ponytail: no inline-comment handling — a "#" inside a remote URL is not
    // a thing, and a whole-line comment is all git itself writes.
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }
    if (line.startsWith("[")) {
      section = REMOTE_SECTION.exec(line)?.[1];
      continue;
    }
    if (!section) {
      continue;
    }
    const url = URL_ENTRY.exec(line)?.[1]?.trim();
    // First url of a remote wins, the same one `git remote get-url` prints.
    if (!url) {
      continue;
    }
    if (section === "origin") {
      origin ??= stripCredentials(url);
    }
    first ??= stripCredentials(url);
  }
  return origin ?? first;
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
  const head = await readHeadInfo(gitDir);
  const remote = await readRemoteUrl(gitDir);
  return remote ? { ...head, remote } : head;
}

/** HEAD half of readGitBranch: which branch (or commit) this work tree is on. */
async function readHeadInfo(gitDir: string): Promise<GitBranchInfo> {
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
