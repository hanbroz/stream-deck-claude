import { mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { DirectoryEntry } from "../shared/claude-command";
import type { RuntimeProjectMetadata } from "../shared/claude-command";
import { readModelPrefs } from "./model-prefs";

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

export type CompanionRuntimeEnv = {
  rootPath: string;
  claudePath: string;
  metadata: RuntimeProjectMetadata;
  bindingId?: string;
  launchId?: string;
  usageDataDir: string;
  resumeSessionId?: string;
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
  // Code Start continues the folder's most recent conversation when it did not
  // pass an explicit id, so opening a project resumes where it left off.
  const resumeSessionId = explicitResume ?? await newestClaudeConversationId(env, rootPath);
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
    resumeSessionId,
    metadata: {
      folder: rootPath,
      projectName:
        cleanEnvValue(env[COMPANION_PROJECT_NAME_ENV], COMPANION_PROJECT_NAME_ENV) ??
        path.basename(rootPath),
      model: savedPrefs.model ?? cleanEnvValue(env[COMPANION_MODEL_ENV], COMPANION_MODEL_ENV),
      effort: savedPrefs.effort,
      contextPercent,
      resumeSessionId
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

export function revealContainedPath(
  root: string,
  requestedPath: string,
  shell: PathShell
): Promise<void> {
  return resolveExistingContainedPath(root, requestedPath).then((target) => {
    shell.showItemInFolder(target);
  });
}
