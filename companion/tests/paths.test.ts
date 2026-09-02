import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  copyIntoContainedDirectory,
  createContainedDirectory,
  createContainedFile,
  COMPANION_CLAUDE_PATH_ENV,
  COMPANION_CONTEXT_PERCENT_ENV,
  COMPANION_FOLDER_ENV,
  COMPANION_LAUNCH_MODE_ENV,
  COMPANION_MODEL_ENV,
  COMPANION_PROJECT_NAME_ENV,
  COMPANION_RESUME_ENV,
  COMPANION_RESUME_SESSION_ID_ENV,
  claudeConversationExists,
  deleteContainedPath,
  listContainedDirectory,
  listProjectFilesRecursive,
  measureCopySources,
  openContainedPath,
  renameContainedPath,
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

function fakeShell() {
  return {
    openPath: vi.fn().mockResolvedValue(""),
    showItemInFolder: vi.fn(),
    trashItem: vi.fn().mockResolvedValue(undefined)
  };
}

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

describe("renameContainedPath", () => {
  it("renames in place, and refuses escapes, collisions and the root", async () => {
    const realRoot = await realpath(root);
    await createContainedFile(realRoot, ".", "old.ts", "content");
    await createContainedFile(realRoot, ".", "taken.ts", "");
    await mkdir(path.join(realRoot, "src"));

    await expect(renameContainedPath(realRoot, "old.ts", "new.ts")).resolves.toBe(
      path.join(realRoot, "new.ts")
    );
    await expect(readFile(path.join(realRoot, "new.ts"), "utf8")).resolves.toBe("content");

    // A directory renames the same way, subtree and all.
    await createContainedFile(realRoot, "src", "index.ts", "x");
    await expect(renameContainedPath(realRoot, "src", "lib")).resolves.toBe(
      path.join(realRoot, "lib")
    );
    await expect(readFile(path.join(realRoot, "lib", "index.ts"), "utf8")).resolves.toBe("x");

    // The new name is a name, never a path: no separators, no traversal.
    await expect(renameContainedPath(realRoot, "new.ts", "../escaped.ts")).rejects.toThrow(
      "Name is invalid"
    );
    await expect(renameContainedPath(realRoot, "new.ts", "sub/escaped.ts")).rejects.toThrow(
      "Name is invalid"
    );
    await expect(renameContainedPath(realRoot, "..", "hijacked")).rejects.toThrow(
      "Path is outside the allowed root"
    );
    await expect(renameContainedPath(realRoot, ".", "hijacked")).rejects.toThrow(
      "Cannot rename the project root"
    );
    // An existing name is never silently overwritten.
    await expect(renameContainedPath(realRoot, "new.ts", "taken.ts")).rejects.toThrow(
      "Name is already taken"
    );
    await expect(readFile(path.join(realRoot, "taken.ts"), "utf8")).resolves.toBe("");
  });
});

describe("contained path operations", () => {
  it("parses the configured root and companion launch env without a silent fallback", async () => {
    const configured = path.join(root, "configured");
    const configDir = path.join(root, "claude-config");
    await mkdir(configured);
    const encodedFolder = (await realpath(configured)).replace(/[^a-zA-Z0-9]/g, "-");
    await mkdir(path.join(configDir, "projects", encodedFolder), { recursive: true });
    await writeFile(
      path.join(configDir, "projects", encodedFolder, "resume-session.jsonl"),
      "{}\n",
      "utf8"
    );
    await writeFile(
      path.join(configDir, "projects", encodedFolder, "legacy-resume-session.jsonl"),
      "{}\n",
      "utf8"
    );

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
        [COMPANION_RESUME_ENV]: "resume-session",
        CLAUDE_CONFIG_DIR: configDir
      })
    ).resolves.toEqual({
      rootPath: await realpath(configured),
      claudePath: "C:\\Tools\\claude.exe",
      bindingId: undefined,
      launchId: undefined,
      usageDataDir: path.join(process.cwd(), "AppData", "Local", "ClaudeUsageDeck"),
      launchMode: "app",
      resumeCandidateId: "resume-session",
      metadata: {
        launchMode: "app",
        folder: await realpath(configured),
        projectName: "Demo Project",
        model: "Opus 4.8",
        contextPercent: 43.7,
        resumeCandidateId: "resume-session"
      }
    });
    await expect(resolveCompanionRoot({})).rejects.toThrow(
      "CLAUDE_STREAM_DECK_FOLDER is required"
    );
    await expect(resolveCompanionRuntimeEnv({
      [COMPANION_FOLDER_ENV]: configured,
      [COMPANION_RESUME_SESSION_ID_ENV]: "legacy-resume-session",
      CLAUDE_CONFIG_DIR: configDir
    })).resolves.toMatchObject({
      metadata: { projectName: path.basename(configured) },
      resumeCandidateId: "legacy-resume-session"
    });
  });

  it("only forwards a resume ID when Claude has a matching transcript", async () => {
    const configured = path.join(root, "configured");
    const configDir = path.join(root, "claude-config");
    await mkdir(configured);
    const encodedFolder = (await realpath(configured)).replace(/[^a-zA-Z0-9]/g, "-");
    await mkdir(path.join(configDir, "projects", encodedFolder), { recursive: true });
    await writeFile(
      path.join(configDir, "projects", encodedFolder, "valid-session.jsonl"),
      "{}\n",
      "utf8"
    );

    await expect(
      claudeConversationExists(
        { CLAUDE_CONFIG_DIR: configDir },
        await realpath(configured),
        "valid-session"
      )
    ).resolves.toBe(true);
    await expect(
      claudeConversationExists(
        { CLAUDE_CONFIG_DIR: configDir },
        await realpath(configured),
        "missing-session"
      )
    ).resolves.toBe(false);

    // An invalid explicit id falls back to the folder's newest transcript as
    // the candidate, so the offer still names a conversation that exists.
    await expect(
      resolveCompanionRuntimeEnv({
        [COMPANION_FOLDER_ENV]: configured,
        [COMPANION_RESUME_SESSION_ID_ENV]: "missing-session",
        CLAUDE_CONFIG_DIR: configDir
      })
    ).resolves.toMatchObject({ resumeCandidateId: "valid-session" });
    await expect(
      resolveCompanionRuntimeEnv({
        [COMPANION_FOLDER_ENV]: configured,
        [COMPANION_RESUME_SESSION_ID_ENV]: "valid-session",
        CLAUDE_CONFIG_DIR: configDir
      })
    ).resolves.toMatchObject({ resumeCandidateId: "valid-session", metadata: { resumeCandidateId: "valid-session" } });
  });

  it("offers the newest transcript when Code Start passes no id", async () => {
    const configured = path.join(root, "auto-resume");
    const configDir = path.join(root, "auto-config");
    await mkdir(configured);
    const encodedFolder = (await realpath(configured)).replace(/[^a-zA-Z0-9]/g, "-");
    const projectDir = path.join(configDir, "projects", encodedFolder);
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, "older.jsonl"), "{}\n", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(path.join(projectDir, "newer.jsonl"), "{}\n", "utf8");

    await expect(
      resolveCompanionRuntimeEnv({ [COMPANION_FOLDER_ENV]: configured, CLAUDE_CONFIG_DIR: configDir })
    ).resolves.toMatchObject({ resumeCandidateId: "newer" });
  });

  it("opens on the terminal surface only when the launch mode says so", async () => {
    const configured = path.join(root, "surface");
    await mkdir(configured);

    const app = await resolveCompanionRuntimeEnv({ [COMPANION_FOLDER_ENV]: configured });
    expect(app.launchMode).toBe("app");
    expect(app.metadata.launchMode).toBe("app");

    const terminal = await resolveCompanionRuntimeEnv({
      [COMPANION_FOLDER_ENV]: configured,
      [COMPANION_LAUNCH_MODE_ENV]: "terminal"
    });
    expect(terminal.launchMode).toBe("terminal");
    expect(terminal.metadata.launchMode).toBe("terminal");

    // Anything else is the app surface, not a third one. The value arrives from
    // a key's saved settings, so an old or hand-edited value must land on the
    // mode that renders a usable window rather than on nothing.
    for (const value of ["", "  ", "Terminal", "powershell", "nonsense"]) {
      const other = await resolveCompanionRuntimeEnv({
        [COMPANION_FOLDER_ENV]: configured,
        [COMPANION_LAUNCH_MODE_ENV]: value
      });
      expect(other.launchMode).toBe("app");
    }
  });

  it("never hands back a conversation to load on its own", async () => {
    // The regression this pins: `resolveCompanionRuntimeEnv` used to return the
    // newest conversation as something to CONTINUE, and the window opened
    // inside it. Because a message respawns the CLI, that inherited prefix was
    // re-bought every turn rather than paid once. The id may only travel as a
    // candidate the renderer offers — no field here may name a live session.
    const configured = path.join(root, "offer-only");
    const configDir = path.join(root, "offer-only-config");
    await mkdir(configured);
    const encodedFolder = (await realpath(configured)).replace(/[^a-zA-Z0-9]/g, "-");
    const projectDir = path.join(configDir, "projects", encodedFolder);
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, "prior.jsonl"), "{}\n", "utf8");

    const env = await resolveCompanionRuntimeEnv({
      [COMPANION_FOLDER_ENV]: configured,
      CLAUDE_CONFIG_DIR: configDir
    });
    expect(env.resumeCandidateId).toBe("prior");
    expect(Object.keys(env)).not.toContain("resumeSessionId");
    expect(Object.keys(env.metadata)).not.toContain("resumeSessionId");
  });

  it("has nothing to offer when the folder has no saved conversation", async () => {
    const configured = path.join(root, "empty-project");
    const configDir = path.join(root, "empty-config");
    await mkdir(configured);
    await expect(
      resolveCompanionRuntimeEnv({ [COMPANION_FOLDER_ENV]: configured, CLAUDE_CONFIG_DIR: configDir })
    ).resolves.toMatchObject({ resumeCandidateId: undefined });
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

  it("reveals executables instead of running them", async () => {
    const shell = fakeShell();
    const exe = path.join(root, "payload.EXE");
    await writeFile(exe, "", "utf8");
    const cmd = path.join(root, "run.cmd");
    await writeFile(cmd, "", "utf8");

    await expect(openContainedPath(root, "payload.EXE", shell)).resolves.toEqual({ action: "revealed" });
    await expect(openContainedPath(root, "run.cmd", shell)).resolves.toEqual({ action: "revealed" });
    expect(shell.openPath).not.toHaveBeenCalled();
    expect(shell.showItemInFolder).toHaveBeenCalledWith(exe);

    // A folder that merely looks like an executable is still opened.
    await mkdir(path.join(root, "build.cmd"), { recursive: true });
    await expect(openContainedPath(root, "build.cmd", shell)).resolves.toEqual({ action: "opened" });
  });

  it("opens and reveals only contained targets", async () => {
    const shell = fakeShell();

    await expect(openContainedPath(root, ".", shell)).resolves.toEqual({ action: "opened" });

    expect(shell.openPath).toHaveBeenCalledWith(root);
    await expect(openContainedPath(root, "..", shell)).rejects.toThrow(
      "Path is outside the allowed root"
    );
    await expect(revealContainedPath(root, "..", shell)).rejects.toThrow(
      "Path is outside the allowed root"
    );
  });

  // Reveal means "show me this". For a file that is the parent folder with the
  // file selected, but showItemInFolder always opens the target's CONTAINER, so
  // on a folder it opened the folder's parent instead of the folder itself.
  it("reveals a directory by opening it, not by selecting it in its parent", async () => {
    const shell = fakeShell();

    await revealContainedPath(root, ".", shell);

    expect(shell.openPath).toHaveBeenCalledWith(root);
    expect(shell.showItemInFolder).not.toHaveBeenCalled();
  });

  it("reveals a file by selecting it in its parent folder", async () => {
    const shell = fakeShell();
    const file = path.join(root, "note.txt");
    await writeFile(file, "n", "utf8");

    await revealContainedPath(root, "note.txt", shell);

    expect(shell.showItemInFolder).toHaveBeenCalledWith(file);
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it("lists project files recursively with ignored directories and a cap", async () => {
    await mkdir(path.join(root, "src", "deep"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(root, "sample.txt"), "s", "utf8");
    await writeFile(path.join(root, "src", "main.ts"), "m", "utf8");
    await writeFile(path.join(root, "src", "deep", "util.ts"), "u", "utf8");
    await writeFile(path.join(root, "node_modules", "pkg", "index.js"), "x", "utf8");

    const files = await listProjectFilesRecursive(root);
    expect(files).toContain("sample.txt");
    expect(files).toContain("src/main.ts");
    expect(files).toContain("src/deep/util.ts");
    expect(files.some((file) => file.includes("node_modules"))).toBe(false);

    const capped = await listProjectFilesRecursive(root, 2);
    expect(capped).toHaveLength(2);
  });

  it("moves contained entries to the trash but never the root or outside paths", async () => {
    const shell = {
      openPath: vi.fn().mockResolvedValue(""),
      showItemInFolder: vi.fn(),
      trashItem: vi.fn().mockResolvedValue(undefined)
    };
    const victim = path.join(root, "victim.txt");
    await writeFile(victim, "bye", "utf8");

    await deleteContainedPath(root, victim, shell);
    expect(shell.trashItem).toHaveBeenCalledWith(await realpath(victim));

    await expect(deleteContainedPath(root, ".", shell)).rejects.toThrow(
      "Cannot delete the project root"
    );
    await expect(deleteContainedPath(root, "..", shell)).rejects.toThrow(
      "Path is outside the allowed root"
    );
    expect(shell.trashItem).toHaveBeenCalledTimes(1);
  });

  it("sums files and bytes across nested folders", async () => {
    await mkdir(path.join(root, "nested", "deep"), { recursive: true });
    await writeFile(path.join(root, "nested", "a.txt"), "12345", "utf8");
    await writeFile(path.join(root, "nested", "deep", "b.txt"), "678", "utf8");

    const measured = await measureCopySources([path.join(root, "nested")]);

    expect(measured.fileCount).toBe(2);
    expect(measured.totalBytes).toBe(8);
    expect(measured.truncated).toBe(false);
  });

  it("stops at the cap and reports the totals as lower bounds", async () => {
    const many = path.join(root, "many");
    await mkdir(many, { recursive: true });
    for (let index = 0; index < 12; index += 1) {
      await writeFile(path.join(many, `f${index}.txt`), "x", "utf8");
    }

    const measured = await measureCopySources([many], 10);

    expect(measured.truncated).toBe(true);
    // Cap of 10 entries: 1 (the "many" dir) + 9 files before stopping
    expect(measured.fileCount).toBe(9);
  });

  it("skips an unreadable source instead of failing the whole measurement", async () => {
    await writeFile(path.join(root, "real.txt"), "abc", "utf8");

    const measured = await measureCopySources([
      path.join(root, "missing.txt"),
      path.join(root, "real.txt")
    ]);

    expect(measured.fileCount).toBe(1);
    expect(measured.totalBytes).toBe(3);
  });

  it("caps at total entry visits (files + directories) to bound directory-heavy trees", async () => {
    const dirs = path.join(root, "dirs");
    await mkdir(dirs, { recursive: true });
    // Create 8 nested directories with no files: d1/d2/d3/d4/d5/d6/d7/d8
    let current = dirs;
    for (let i = 0; i < 8; i += 1) {
      current = path.join(current, `d${i}`);
      await mkdir(current, { recursive: true });
    }

    const measured = await measureCopySources([dirs], 5);

    // Cap is 5 entries: the root + 4 nested dirs before hitting the cap
    expect(measured.truncated).toBe(true);
    expect(measured.fileCount).toBe(0);
  });

  it("copies an external file into a project subfolder", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "companion-drop-"));
    try {
      await writeFile(path.join(outside, "note.txt"), "hello", "utf8");
      await mkdir(path.join(root, "docs"), { recursive: true });

      const result = await copyIntoContainedDirectory(root, "docs", [
        path.join(outside, "note.txt")
      ]);

      expect(result).toEqual({ copied: ["note.txt"], failed: [] });
      expect(await readFile(path.join(root, "docs", "note.txt"), "utf8")).toBe("hello");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("copies a folder with its nested contents", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "companion-drop-"));
    try {
      await mkdir(path.join(outside, "bundle", "inner"), { recursive: true });
      await writeFile(path.join(outside, "bundle", "inner", "deep.txt"), "d", "utf8");

      const result = await copyIntoContainedDirectory(root, ".", [
        path.join(outside, "bundle")
      ]);

      expect(result.copied).toEqual(["bundle"]);
      expect(await readFile(path.join(root, "bundle", "inner", "deep.txt"), "utf8")).toBe("d");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("renames instead of overwriting a name already in the destination", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "companion-drop-"));
    try {
      await writeFile(path.join(outside, "note.txt"), "new", "utf8");
      await writeFile(path.join(root, "note.txt"), "original", "utf8");

      const result = await copyIntoContainedDirectory(root, ".", [
        path.join(outside, "note.txt")
      ]);

      expect(result.copied).toEqual(["note (1).txt"]);
      expect(await readFile(path.join(root, "note.txt"), "utf8")).toBe("original");
      expect(await readFile(path.join(root, "note (1).txt"), "utf8")).toBe("new");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a destination outside the root", async () => {
    await expect(copyIntoContainedDirectory(root, "..", [])).rejects.toThrow(
      "Path is outside the allowed root"
    );
  });

  it("keeps copying after one source fails", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "companion-drop-"));
    try {
      await writeFile(path.join(outside, "ok.txt"), "ok", "utf8");

      const result = await copyIntoContainedDirectory(root, ".", [
        path.join(outside, "missing.txt"),
        path.join(outside, "ok.txt")
      ]);

      expect(result.copied).toEqual(["ok.txt"]);
      expect(result.failed).toEqual(["missing.txt"]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("listProjectFilesRecursive cancellation", () => {
  it("walks nothing when the signal is already aborted", async () => {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "x");
    const controller = new AbortController();
    controller.abort();

    // The walk alone can cover SCAN_MAX_ENTRIES directories, so a superseded
    // search must stop here too, not only before reading file contents.
    await expect(
      listProjectFilesRecursive(root, 2000, 6, controller.signal)
    ).resolves.toEqual([]);
  });
});
