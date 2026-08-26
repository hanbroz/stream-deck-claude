import { cp, lstat, mkdir, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DirectoryEntry,
  type CompanionLaunchMode
} from "../shared/claude-command";
import type { RuntimeProjectMetadata } from "../shared/claude-command";
import { readModelPrefs } from "./model-prefs";
import type { CopyMeasurement, CopySummary } from "../shared/copy-guard";

export type PathShell = {
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
  trashItem(path: string): Promise<void>;
};

export const COMPANION_FOLDER_ENV = "CLAUDE_STREAM_DECK_FOLDER";
export const COMPANION_CLAUDE_PATH_ENV = "CLAUDE_STREAM_DECK_CLAUDE_PATH";
export const COMPANION_RESUME_ENV = "CLAUDE_STREAM_DECK_RESUME";
export const COMPANION_RESUME_SESSION_ID_ENV = "CLAUDE_STREAM_DECK_RESUME_SESSION_ID";
export const COMPANION_PROJECT_NAME_ENV = "CLAUDE_STREAM_DECK_PROJECT_NAME";
export const COMPANION_MODEL_ENV = "CLAUDE_STREAM_DECK_MODEL";
export const COMPANION_CONTEXT_PERCENT_ENV = "CLAUDE_STREAM_DECK_CONTEXT_PERCENT";
export const COMPANION_BINDING_ID_ENV = "CLAUDE_STREAM_DECK_BINDING_ID";
export const COMPANION_LAUNCH_ID_ENV = "CLAUDE_STREAM_DECK_LAUNCH_ID";
export const COMPANION_LAUNCH_MODE_ENV = "CLAUDE_STREAM_DECK_LAUNCH_MODE";

export type CompanionRuntimeEnv = {
  rootPath: string;
  claudePath: string;
  metadata: RuntimeProjectMetadata;
  bindingId?: string;
  launchId?: string;
  usageDataDir: string;
  launchMode: CompanionLaunchMode;
  /** Offered at startup, not loaded. See RuntimeProjectMetadata. */
  resumeCandidateId?: string;
};

function claudeProjectDirectoryName(folder: string): string {
  return folder.replace(/[^a-zA-Z0-9]/g, "-");
}

function claudeProjectsDirectory(env: NodeJS.ProcessEnv): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(
    env.USERPROFILE?.trim() || os.homedir(),
    ".claude"
  );
  return path.join(configDir, "projects");
}

/**
 * The id of the folder's most recently modified saved conversation, or
 * undefined when the project has none. Code Start uses this so pressing it
 * continues where the last session left off without the user pasting an id.
 */
export async function newestClaudeConversationId(
  env: NodeJS.ProcessEnv,
  folder: string
): Promise<string | undefined> {
  const directory = path.join(
    claudeProjectsDirectory(env),
    claudeProjectDirectoryName(folder)
  );
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return undefined;
  }

  let newest: { id: string; mtimeMs: number } | undefined;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    try {
      const info = await stat(path.join(directory, entry.name));
      if (!newest || info.mtimeMs > newest.mtimeMs) {
        newest = { id: entry.name.slice(0, -".jsonl".length), mtimeMs: info.mtimeMs };
      }
    } catch {
      // A file that vanished mid-scan simply is not a resume candidate.
    }
  }
  return newest?.id;
}

/**
 * Validate resume IDs again inside Companion. This protects users running a
 * previously installed Stream Deck plugin whose Code Start preflight is not
 * yet updated, and keeps a stale pointer from producing a recovery toast.
 */
export async function claudeConversationExists(
  env: NodeJS.ProcessEnv,
  folder: string,
  sessionId: string
): Promise<boolean> {
  if (
    sessionId.length === 0 ||
    sessionId.includes("/") ||
    sessionId.includes("\\")
  ) {
    return false;
  }

  try {
    const transcriptPath = path.join(
      claudeProjectsDirectory(env),
      claudeProjectDirectoryName(folder),
      `${sessionId}.jsonl`
    );
    const info = await stat(transcriptPath);
    return info.isFile();
  } catch (error) {
    // Missing transcript means there is no previous conversation. Preserve
    // non-ENOENT failures so permission/configuration problems remain visible.
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function isContainedPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertSafeName(name: string, label: string): void {
  const trimmed = name.trim();
  const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
  if (
    trimmed.length === 0 ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed !== name ||
    reserved.test(trimmed) ||
    /[\\/:\u0000\r\n]/u.test(name)
  ) {
    throw new Error(`${label} is invalid`);
  }
}

// Directories that never belong in the "@" file picker.
const MENTION_IGNORED_DIRECTORIES = new Set([
  ".git", "node_modules", "dist", "build", "out", ".next", ".venv", "__pycache__", ".omc"
]);

/**
 * Relative paths (forward slashes) of the project's files for the composer's
 * "@" mention picker. Depth- and count-capped so a giant repository cannot
 * stall the scan; the renderer filters as the user types.
 */
export async function listProjectFilesRecursive(
  root: string,
  maxEntries = 2000,
  maxDepth = 6,
  signal?: { readonly aborted: boolean }
): Promise<string[]> {
  const realRoot = await realpath(path.resolve(root));
  const files: string[] = [];

  async function visit(directory: string, depth: number): Promise<void> {
    // A superseded search must stop walking too, not just stop reading files:
    // the walk alone can cover SCAN_MAX_ENTRIES directories.
    if (files.length >= maxEntries || depth > maxDepth || signal?.aborted) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return; // unreadable folder — skip silently
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxEntries) {
        return;
      }
      if (entry.isDirectory()) {
        if (!MENTION_IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) {
          await visit(path.join(directory, entry.name), depth + 1);
        }
      } else if (entry.isFile()) {
        files.push(
          path.relative(realRoot, path.join(directory, entry.name)).split(path.sep).join("/")
        );
      }
    }
  }

  await visit(realRoot, 0);
  return files;
}

export async function resolveCompanionRoot(
  env: NodeJS.ProcessEnv
): Promise<string> {
  const configuredRoot = cleanEnvValue(env[COMPANION_FOLDER_ENV], COMPANION_FOLDER_ENV);
  if (!configuredRoot) {
    throw new Error(`${COMPANION_FOLDER_ENV} is required`);
  }
  const resolvedRoot = await realpath(path.resolve(configuredRoot));
  const info = await stat(resolvedRoot);
  if (!info.isDirectory()) {
    throw new Error("Companion root is not a directory");
  }
  return resolvedRoot;
}

function cleanEnvValue(value: string | undefined, label: string): string | undefined {
  const cleaned = value?.trim();
  if (!cleaned) {
    return undefined;
  }
  if (/[\u0000\r\n]/u.test(cleaned)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return cleaned;
}

export async function resolveCompanionRuntimeEnv(
  env: NodeJS.ProcessEnv
): Promise<CompanionRuntimeEnv> {
  const rootPath = await resolveCompanionRoot(env);
  const requestedResumeSessionId =
    cleanEnvValue(env[COMPANION_RESUME_ENV], COMPANION_RESUME_ENV) ??
    cleanEnvValue(env[COMPANION_RESUME_SESSION_ID_ENV], COMPANION_RESUME_SESSION_ID_ENV);
  const explicitResume =
    requestedResumeSessionId !== undefined &&
    await claudeConversationExists(env, rootPath, requestedResumeSessionId)
      ? requestedResumeSessionId
      : undefined;
  // A candidate to offer, not a conversation to continue. Opening a project
  // used to resume where it left off, which reads as a convenience and bills
  // like a subscription: the respawn-per-message design re-buys the inherited
  // prefix on every turn, so a launch that inherits 326k tokens paid it 167
  // times over. The renderer puts it behind a button instead.
  const resumeCandidateId = explicitResume ?? await newestClaudeConversationId(env, rootPath);
  const launchMode: CompanionLaunchMode =
    cleanEnvValue(env[COMPANION_LAUNCH_MODE_ENV], COMPANION_LAUNCH_MODE_ENV) === "terminal"
      ? "terminal"
      : "app";
  const contextPercent = parseContextPercent(env[COMPANION_CONTEXT_PERCENT_ENV]);
  const localAppData = env.LOCALAPPDATA ?? path.join(env.USERPROFILE ?? process.cwd(), "AppData", "Local");
  const usageDataDir = path.join(localAppData, "ClaudeUsageDeck");
  // The model + effort the user last applied for this folder win over the env
  // default, so relaunching Code Start restores their choice.
  const savedPrefs = await readModelPrefs(usageDataDir, rootPath);
  return {
    rootPath,
    claudePath: cleanEnvValue(env[COMPANION_CLAUDE_PATH_ENV], COMPANION_CLAUDE_PATH_ENV) ?? "claude",
    bindingId: cleanEnvValue(env[COMPANION_BINDING_ID_ENV], COMPANION_BINDING_ID_ENV),
    launchId: cleanEnvValue(env[COMPANION_LAUNCH_ID_ENV], COMPANION_LAUNCH_ID_ENV),
    usageDataDir,
    launchMode,
    resumeCandidateId,
    metadata: {
      launchMode,
      folder: rootPath,
      projectName:
        cleanEnvValue(env[COMPANION_PROJECT_NAME_ENV], COMPANION_PROJECT_NAME_ENV) ??
        path.basename(rootPath),
      model: savedPrefs.model ?? cleanEnvValue(env[COMPANION_MODEL_ENV], COMPANION_MODEL_ENV),
      effort: savedPrefs.effort,
      contextPercent,
      resumeCandidateId
    }
  };
}

function parseContextPercent(value: string | undefined): number | undefined {
  const cleaned = cleanEnvValue(value, COMPANION_CONTEXT_PERCENT_ENV);
  if (cleaned === undefined) {
    return undefined;
  }
  const parsed = Number.parseFloat(cleaned);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${COMPANION_CONTEXT_PERCENT_ENV} must be a number`);
  }
  return Math.max(0, Math.min(100, parsed));
}

export function resolveContainedPath(root: string, requestedPath = "."): string {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(
    path.isAbsolute(requestedPath)
      ? requestedPath
      : path.join(absoluteRoot, requestedPath)
  );

  if (isContainedPath(absoluteRoot, absoluteTarget)) {
    return absoluteTarget;
  }

  throw new Error("Path is outside the allowed root");
}

export async function resolveExistingContainedPath(
  root: string,
  requestedPath = "."
): Promise<string> {
  const realRoot = await realpath(path.resolve(root));
  const lexicalTarget = resolveContainedPath(realRoot, requestedPath);
  const realTarget = await realpath(lexicalTarget);
  if (!isContainedPath(realRoot, realTarget)) {
    throw new Error("Path is outside the allowed root");
  }
  return realTarget;
}

export async function listContainedDirectory(
  root: string,
  requestedPath = "."
): Promise<DirectoryEntry[]> {
  const directory = await resolveContainedDirectory(root, requestedPath);

  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => !entry.name.includes("\u0000"))
    .map((entry) => ({
      name: entry.name,
      path: path.join(directory, entry.name),
      isDirectory: entry.isDirectory()
    }))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
}

export async function resolveContainedDirectory(
  root: string,
  requestedPath = "."
): Promise<string> {
  const directory = await resolveExistingContainedPath(root, requestedPath);
  const info = await stat(directory);
  if (!info.isDirectory()) {
    throw new Error("Path is not a directory");
  }
  return directory;
}

export async function createContainedDirectory(
  root: string,
  parentPath: string,
  name: string
): Promise<string> {
  assertSafeName(name, "Directory name");
  const realRoot = await realpath(path.resolve(root));
  const parent = await resolveExistingContainedPath(realRoot, parentPath);
  const directory = resolveContainedPath(realRoot, path.join(path.relative(realRoot, parent), name));
  await mkdir(directory, { recursive: false });
  return directory;
}

export async function createContainedFile(
  root: string,
  parentPath: string,
  name: string,
  content = ""
): Promise<string> {
  assertSafeName(name, "File name");
  const realRoot = await realpath(path.resolve(root));
  const parent = await resolveExistingContainedPath(realRoot, parentPath);
  const filePath = resolveContainedPath(realRoot, path.join(path.relative(realRoot, parent), name));
  await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  return filePath;
}

/**
 * Rename a file or folder in place. The replacement is a bare NAME, not a path
 * — `assertSafeName` rejects separators — so a rename can never move an entry
 * out of its folder, let alone out of the project. The project root itself has
 * no parent inside the root and so cannot be renamed.
 *
 * Renaming onto an existing entry is refused rather than overwriting it, which
 * `fs.rename` would happily do for a file. A name that differs only in case is
 * the same entry on Windows, so it is allowed through as a genuine rename.
 */
export async function renameContainedPath(
  root: string,
  requestedPath: string,
  newName: string
): Promise<string> {
  assertSafeName(newName, "Name");
  const realRoot = await realpath(path.resolve(root));
  const target = await resolveExistingContainedPath(realRoot, requestedPath);
  if (target === realRoot) {
    throw new Error("Cannot rename the project root");
  }

  const destination = path.join(path.dirname(target), newName);
  // ponytail: case-insensitive compare matches Windows, the only platform this
  // app ships on. A case-sensitive filesystem would need a real inode compare.
  if (destination.toLowerCase() !== target.toLowerCase()) {
    const taken = await lstat(destination).then(() => true, () => false);
    if (taken) {
      throw new Error("Name is already taken");
    }
  }

  await rename(target, destination);
  return destination;
}

/**
 * Move a file or folder inside the project to the OS Recycle Bin (never a
 * permanent unlink, so a mis-click is recoverable). The project root itself
 * can never be deleted.
 */
export async function deleteContainedPath(
  root: string,
  requestedPath: string,
  shell: PathShell
): Promise<void> {
  const realRoot = await realpath(path.resolve(root));
  const target = await resolveExistingContainedPath(realRoot, requestedPath);
  if (target === realRoot) {
    throw new Error("Cannot delete the project root");
  }
  await shell.trashItem(target);
}

export async function openContainedPath(
  root: string,
  requestedPath: string,
  shell: PathShell
): Promise<void> {
  const target = await resolveExistingContainedPath(root, requestedPath);
  const error = await shell.openPath(target);
  if (error) {
    throw new Error(error);
  }
}

/**
 * Show a tree entry in Windows Explorer.
 *
 * `showItemInFolder` opens the target's CONTAINER and selects the target, which
 * is what reveal means for a file. On a folder it opened the folder's parent —
 * revealing the project root landed the user in its grandparent with the project
 * merely highlighted. A folder reveals by being opened.
 */
export async function revealContainedPath(
  root: string,
  requestedPath: string,
  shell: PathShell
): Promise<void> {
  const target = await resolveExistingContainedPath(root, requestedPath);
  if ((await stat(target)).isDirectory()) {
    const error = await shell.openPath(target);
    if (error) {
      throw new Error(error);
    }
    return;
  }
  shell.showItemInFolder(target);
}

export const MEASURE_ENTRY_CAP = 10_000;

/**
 * Count the files and bytes a drop would copy.
 *
 * `lstat`, not `stat`, because this has to describe what `fs.cp` will actually
 * do and cp defaults to `dereference: false`: a symlink is copied as a link, so
 * its target is neither counted nor walked — which also makes a link cycle
 * impossible to hang on.
 *
 * The walk gives up at `cap`. Reaching it forces confirmation on its own
 * (via `truncated`), which is why an exact total would not change the answer,
 * and measuring a huge tree exactly is the very case where the user would sit
 * in front of a frozen window waiting for the dialog that was supposed to
 * protect them.
 *
 * The cap bounds visited entries (both files and directories), not file count
 * alone, so a directory-heavy tree (thousands of near-empty nested folders)
 * cannot bypass the cap and freeze the walk.
 *
 * Unreadable entries are skipped rather than thrown: this measurement only
 * decides whether to ask, and the copy itself reports per-source failures.
 */
export async function measureCopySources(
  sourcePaths: string[],
  cap = MEASURE_ENTRY_CAP
): Promise<CopyMeasurement> {
  let fileCount = 0;
  let totalBytes = 0;
  let entryCount = 0;
  let truncated = false;

  async function visit(target: string): Promise<void> {
    if (entryCount >= cap) {
      truncated = true;
      return;
    }

    const info = await lstat(target).catch(() => undefined);
    if (!info) {
      return;
    }

    entryCount += 1;

    if (info.isDirectory()) {
      const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entryCount >= cap) {
          truncated = true;
          return;
        }
        await visit(path.join(target, entry.name));
      }
      return;
    }

    fileCount += 1;
    totalBytes += info.size;
  }

  for (const source of sourcePaths) {
    await visit(source);
  }

  return { fileCount, totalBytes, truncated };
}

// Structurally identical to shared/copy-guard's CopySummary; aliased rather
// than redeclared so the two never drift apart. main/ may import from
// shared/ (the reverse is forbidden), so the alias lives here.
export type CopyResult = CopySummary;

/**
 * A free name in `directory` for `name`, suffixing " (n)" before the extension
 * the way Windows Explorer does. There is no overwrite path at all, so a
 * mis-drop can never destroy work that is already in the project.
 */
export async function uniqueDestinationName(
  directory: string,
  name: string
): Promise<string> {
  const extension = path.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;

  for (let index = 0; index <= 1000; index += 1) {
    const candidate = index === 0 ? name : `${stem} (${index})${extension}`;
    const taken = await lstat(path.join(directory, candidate)).then(
      () => true,
      () => false
    );
    if (!taken) {
      return candidate;
    }
  }

  throw new Error(`No free name for ${name}`);
}

/**
 * Copy dropped sources into a folder inside the project.
 *
 * The containment rule inverts here. Every other helper in this file requires
 * both ends inside the root; a drop's source is by definition outside it, so
 * only the destination is sealed. `fs.cp` refuses to copy a directory into its
 * own subtree, which covers a source dragged from within the project itself.
 *
 * One bad source must not cost the user the rest of the drop, so failures are
 * collected per source and the loop continues.
 */
export async function copyIntoContainedDirectory(
  root: string,
  destinationPath: string,
  sourcePaths: string[]
): Promise<CopyResult> {
  const destination = await resolveContainedDirectory(root, destinationPath);
  const copied: string[] = [];
  const failed: string[] = [];

  for (const source of sourcePaths) {
    const sourceName = path.basename(source);
    // Every failure for this source reports the same label: the basename,
    // falling back to the full path only when there is no basename (a drive
    // root such as "D:\").
    const failureLabel = sourceName.length > 0 ? sourceName : source;
    if (sourceName.length === 0) {
      failed.push(failureLabel);
      continue;
    }
    try {
      // The IPC boundary accepts arbitrary strings, unlike a real drop, so a
      // source ending in ".." (or another unsafe name) has to be rejected
      // here the same way every other write helper in this file rejects it —
      // otherwise uniqueDestinationName would probe path.join(destination, "..").
      assertSafeName(sourceName, "Source name");
      const name = await uniqueDestinationName(destination, sourceName);
      // errorOnExist guards the gap between picking the name and writing it.
      await cp(source, path.join(destination, name), {
        recursive: true,
        errorOnExist: true,
        force: false
      });
      copied.push(name);
    } catch {
      failed.push(failureLabel);
    }
  }

  return { copied, failed };
}
