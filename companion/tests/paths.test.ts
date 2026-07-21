import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createContainedDirectory,
  createContainedFile,
  COMPANION_CLAUDE_PATH_ENV,
  COMPANION_CONTEXT_PERCENT_ENV,
  COMPANION_FOLDER_ENV,
  COMPANION_MODEL_ENV,
  COMPANION_PROJECT_NAME_ENV,
  COMPANION_RESUME_ENV,
  COMPANION_RESUME_SESSION_ID_ENV,
  listContainedDirectory,
  openContainedPath,
  resolveCompanionRuntimeEnv,
  resolveCompanionRoot,
  resolveContainedPath,
  revealContainedPath
} from "../main/paths";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "companion-paths-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveContainedPath", () => {
  it("allows paths inside the configured root", () => {
    expect(resolveContainedPath(root, "project")).toBe(path.join(root, "project"));
  });

  it("rejects traversal outside the configured root", () => {
    expect(() => resolveContainedPath(root, "..")).toThrow(
      "Path is outside the allowed root"
    );
  });
});

describe("contained path operations", () => {
  it("parses the configured root and companion launch env without a silent fallback", async () => {
    const configured = path.join(root, "configured");
    await mkdir(configured);

    await expect(
      resolveCompanionRoot({ [COMPANION_FOLDER_ENV]: configured })
    ).resolves.toBe(await realpath(configured));
    await expect(
      resolveCompanionRuntimeEnv({
        [COMPANION_FOLDER_ENV]: configured,
        [COMPANION_CLAUDE_PATH_ENV]: "C:\\Tools\\claude.exe",
        [COMPANION_PROJECT_NAME_ENV]: "Demo Project",
        [COMPANION_MODEL_ENV]: "Opus 4.8",
        [COMPANION_CONTEXT_PERCENT_ENV]: "43.7",
        [COMPANION_RESUME_ENV]: "resume-session"
      })
    ).resolves.toEqual({
      rootPath: await realpath(configured),
      claudePath: "C:\\Tools\\claude.exe",
      bindingId: undefined,
      launchId: undefined,
      usageDataDir: path.join(process.cwd(), "AppData", "Local", "ClaudeUsageDeck"),
      resumeSessionId: "resume-session",
      metadata: {
        folder: await realpath(configured),
        projectName: "Demo Project",
        model: "Opus 4.8",
        contextPercent: 43.7,
        resumeSessionId: "resume-session"
      }
    });
    await expect(resolveCompanionRoot({})).rejects.toThrow(
      "CLAUDE_STREAM_DECK_FOLDER is required"
    );
    await expect(resolveCompanionRuntimeEnv({
      [COMPANION_FOLDER_ENV]: configured,
      [COMPANION_RESUME_SESSION_ID_ENV]: "legacy-resume-session"
    })).resolves.toMatchObject({
      metadata: { projectName: path.basename(configured) },
      resumeSessionId: "legacy-resume-session"
    });
  });

  it("lists directories before files and creates child folders/files", async () => {
    const directory = await createContainedDirectory(root, ".", "alpha");
    const file = await createContainedFile(root, ".", "note.txt", "hello");

    const entries = await listContainedDirectory(root, ".");

    expect(directory).toBe(path.join(root, "alpha"));
    expect(file).toBe(path.join(root, "note.txt"));
    await expect(readFile(file, "utf8")).resolves.toBe("hello");
    expect(entries).toEqual([
      { name: "alpha", path: path.join(root, "alpha"), isDirectory: true },
      { name: "note.txt", path: path.join(root, "note.txt"), isDirectory: false }
    ]);
  });

  it("rejects nested or absolute directory names on create", async () => {
    await expect(createContainedDirectory(root, ".", "..\\escape")).rejects.toThrow(
      "Directory name is invalid"
    );
    await expect(createContainedFile(root, ".", "CON")).rejects.toThrow(
      "File name is invalid"
    );
  });

  it("opens and reveals only contained targets", async () => {
    const shell = {
      openPath: vi.fn().mockResolvedValue(""),
      showItemInFolder: vi.fn()
    };

    await openContainedPath(root, ".", shell);
    await revealContainedPath(root, ".", shell);

    expect(shell.openPath).toHaveBeenCalledWith(root);
    expect(shell.showItemInFolder).toHaveBeenCalledWith(root);
    await expect(openContainedPath(root, "..", shell)).rejects.toThrow(
      "Path is outside the allowed root"
    );
  });
});
