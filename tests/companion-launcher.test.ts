import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCompanionLaunchPlan,
  launchClaudeCompanion,
  resolveCompanionExecutable
} from "../src/services/companion-launcher";

const accessMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
const launchClaudeTerminalMock = vi.hoisted(() => vi.fn());
const validateLaunchFolderMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => ({
  access: accessMock
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock
}));

vi.mock("../src/services/terminal-launcher", () => ({
  launchClaudeTerminal: launchClaudeTerminalMock,
  validateLaunchFolder: validateLaunchFolderMock
}));

type SpawnedProcess = EventEmitter & {
  stdout: EventEmitter;
  pid?: number;
  unref: ReturnType<typeof vi.fn>;
};

function spawnedProcess(pid = 4321): SpawnedProcess {
  const child = new EventEmitter() as SpawnedProcess;
  child.stdout = new EventEmitter();
  child.pid = pid;
  child.unref = vi.fn();
  return child;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  accessMock.mockReset();
  spawnMock.mockReset();
  launchClaudeTerminalMock.mockReset();
  validateLaunchFolderMock.mockReset();
});

describe("resolveCompanionExecutable", () => {
  it("uses the explicit Companion path before installed and repo candidates", async () => {
    accessMock.mockResolvedValue(undefined);

    await expect(
      resolveCompanionExecutable({
        env: { CLAUDE_DECK_COMPANION_PATH: "D:\\Dev\\Companion.exe" },
        localAppData: "C:\\Users\\Me\\AppData\\Local",
        pluginRoot: "D:\\Plugin"
      })
    ).resolves.toBe("D:\\Dev\\Companion.exe");

    expect(accessMock).toHaveBeenCalledWith("D:\\Dev\\Companion.exe");
    expect(accessMock).toHaveBeenCalledTimes(1);
  });

  it("falls through to the repo development artifact after installed path misses", async () => {
    accessMock.mockResolvedValueOnce(undefined);

    await expect(
      resolveCompanionExecutable({
        env: {},
        localAppData: "C:\\Users\\Me\\AppData\\Local",
        pluginRoot: "D:\\Plugin"
      })
    ).resolves.toBe("D:\\Plugin\\companion\\win-unpacked\\Claude Deck Companion.exe");
  });

  it("prefers the current repo release artifact over a stale installed Companion", async () => {
    accessMock
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }))
      .mockResolvedValueOnce(undefined);

    await expect(
      resolveCompanionExecutable({
        env: {},
        localAppData: "C:\\Users\\Me\\AppData\\Local",
        pluginRoot: "D:\\repo\\com.hanbroz.claude-usage.sdPlugin"
      })
    ).resolves.toBe("D:\\repo\\dist\\companion\\win-unpacked\\Claude Deck Companion.exe");
  });

  it("also checks the release dist artifact promised by Code Start", async () => {
    accessMock
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }))
      .mockResolvedValueOnce(undefined);

    await expect(
      resolveCompanionExecutable({
        env: {},
        localAppData: undefined,
        pluginRoot: "D:\\repo\\com.hanbroz.claude-usage.sdPlugin"
      })
    ).resolves.toBe("D:\\repo\\dist\\companion\\win-unpacked\\Claude Deck Companion.exe");
  });
});

describe("createCompanionLaunchPlan", () => {
  it("preserves Stream Deck identity env and adds resume only when present", () => {
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "1");
    vi.stubEnv("ELECTRON_NO_ATTACH_CONSOLE", "1");
    const plan = createCompanionLaunchPlan(
      "D:\\Companion\\Claude Deck Companion.exe",
      "D:\\Projects\\Demo",
      "binding-1",
      "launch-1",
      "C:\\Users\\Me\\.local\\bin\\claude.exe",
      "session-1",
      "020_Source"
    );

    expect(plan).toMatchObject({
      command: "D:\\Companion\\Claude Deck Companion.exe",
      args: [],
      cwd: "D:\\Projects\\Demo"
    });
    expect(plan.env.CLAUDE_STREAM_DECK_BINDING_ID).toBe("binding-1");
    expect(plan.env.CLAUDE_STREAM_DECK_ACTION_ID).toBe("binding-1");
    expect(plan.env.CLAUDE_STREAM_DECK_LAUNCH_ID).toBe("launch-1");
    expect(plan.env.CLAUDE_STREAM_DECK_FOLDER).toBe("D:\\Projects\\Demo");
    expect(plan.env.CLAUDE_STREAM_DECK_CLAUDE_PATH).toBe("C:\\Users\\Me\\.local\\bin\\claude.exe");
    expect(plan.env.CLAUDE_STREAM_DECK_PROJECT_NAME).toBe("020_Source");
    expect(plan.env.CLAUDE_STREAM_DECK_RESUME_SESSION_ID).toBe("session-1");
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(plan.env.ELECTRON_NO_ATTACH_CONSOLE).toBeUndefined();
  });
});

describe("launchClaudeCompanion", () => {
  it("launches the Companion process and tracks its process ID", async () => {
    validateLaunchFolderMock.mockResolvedValue(undefined);
    accessMock.mockResolvedValue(undefined);
    let child!: SpawnedProcess;
    spawnMock.mockImplementation(() => {
      child = spawnedProcess(9876);
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });

    await expect(
      launchClaudeCompanion("D:\\Projects\\Demo", "binding-1", "launch-1", "session-1")
    ).resolves.toEqual({ terminal: "companion", processId: 9876 });

    expect(spawnMock).toHaveBeenCalledWith(
      expect.stringContaining("Claude Deck Companion.exe"),
      [],
      expect.objectContaining({
        cwd: "D:\\Projects\\Demo",
        windowsHide: false,
        stdio: "ignore"
      })
    );
    expect(child.unref).toHaveBeenCalledTimes(1);
  });

  it("uses terminal fallback only when the explicit development flag is set", async () => {
    validateLaunchFolderMock.mockResolvedValue(undefined);
    accessMock.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    launchClaudeTerminalMock.mockResolvedValue({ terminal: "powershell", processId: 777 });

    await expect(
      launchClaudeCompanion("D:\\Projects\\Demo", "binding-1", "launch-1")
    ).rejects.toThrow("Claude Deck Companion executable was not found");
    vi.stubEnv("CLAUDE_DECK_ALLOW_TERMINAL_FALLBACK", "1");
    await expect(
      launchClaudeCompanion("D:\\Projects\\Demo", "binding-1", "launch-1")
    ).resolves.toEqual({ terminal: "powershell", processId: 777 });
  });
});
