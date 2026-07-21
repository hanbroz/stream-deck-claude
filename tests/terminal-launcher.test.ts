import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTerminalLaunchPlan,
  launchClaudeTerminal
} from "../src/services/terminal-launcher";

const spawnMock = vi.hoisted(() => vi.fn());
const accessMock = vi.hoisted(() => vi.fn());
const mkdirMock = vi.hoisted(() => vi.fn());
const readFileMock = vi.hoisted(() => vi.fn());
const rmMock = vi.hoisted(() => vi.fn());
const statMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock
}));

vi.mock("node:fs/promises", () => ({
  access: accessMock,
  mkdir: mkdirMock,
  readFile: readFileMock,
  rm: rmMock,
  stat: statMock
}));

type SpawnedProcess = EventEmitter & {
  stdout: EventEmitter;
  exitCode: number | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
};

function spawnedProcess(): SpawnedProcess {
  const child = new EventEmitter() as SpawnedProcess;
  child.stdout = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  child.unref = vi.fn();
  return child;
}

function runningPidSpy(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process, "kill").mockImplementation(() => true);
}

afterEach(() => {
  vi.restoreAllMocks();
  spawnMock.mockReset();
  accessMock.mockReset();
  mkdirMock.mockReset();
  readFileMock.mockReset();
  rmMock.mockReset();
  statMock.mockReset();
});

describe("createTerminalLaunchPlan", () => {
  it("uses Windows Terminal with the folder as cwd and a separate argument", () => {
    const plan = createTerminalLaunchPlan(
      "D:\\Projects\\Folder & Name",
      "action-1",
      "launch-1",
      true
    );

    expect(plan.command).toBe("wt.exe");
    expect(plan.cwd).toBe("D:\\Projects\\Folder & Name");
    expect(plan.args).toEqual([
      "-d",
      "D:\\Projects\\Folder & Name",
      "powershell.exe",
      "-NoExit",
      "-EncodedCommand",
      expect.any(String)
    ]);
    const encodedCommand = plan.args.at(-1);
    expect(encodedCommand).toBeDefined();
    expect(Buffer.from(encodedCommand!, "base64").toString("utf16le")).toBe(
      "$PID | Set-Content -LiteralPath $env:CLAUDE_STREAM_DECK_PID_FILE -NoNewline; & $env:CLAUDE_STREAM_DECK_CLAUDE_PATH --dangerously-skip-permissions"
    );
    expect(plan.args.join(" ")).not.toContain(";");
    expect(plan.env.CLAUDE_STREAM_DECK_BINDING_ID).toBe("action-1");
    expect(plan.env.CLAUDE_STREAM_DECK_ACTION_ID).toBe("action-1");
    expect(plan.env.CLAUDE_STREAM_DECK_LAUNCH_ID).toBe("launch-1");
    expect(plan.env.CLAUDE_STREAM_DECK_CLAUDE_PATH).toBe("claude.exe");
    expect(plan.env.CLAUDE_STREAM_DECK_PID_FILE).toMatch(/\.pid$/u);
  });

  it("uses cmd start to create a separate visible PowerShell window and report its PID", () => {
    const plan = createTerminalLaunchPlan(
      "D:\\Projects\\Folder & Name",
      "action",
      "launch",
      false,
      "C:\\Users\\Me\\.local\\bin\\claude.exe"
    );

    expect(plan.command).toBe("cmd.exe");
    expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(plan.args[3]).toContain('start "Claude Code" powershell.exe');
    expect(plan.args[3]).toContain("-Command");
    expect(plan.args[3]).toContain('"$PID | Set-Content');
    expect(plan.args[3]).toContain("CLAUDE_STREAM_DECK_PID_FILE");
    expect(plan.args[3]).toContain("CLAUDE_STREAM_DECK_CLAUDE_PATH");
    expect(plan.args[3]).toContain("--dangerously-skip-permissions");
    expect(plan.cwd).toBe("D:\\Projects\\Folder & Name");
    expect(plan.env.CLAUDE_STREAM_DECK_FOLDER).toBe("D:\\Projects\\Folder & Name");
    expect(plan.env.CLAUDE_STREAM_DECK_BINDING_ID).toBe("action");
    expect(plan.env.CLAUDE_STREAM_DECK_CLAUDE_PATH).toBe("C:\\Users\\Me\\.local\\bin\\claude.exe");
    expect(plan.env.CLAUDE_STREAM_DECK_PID_FILE).toMatch(/\.pid$/u);
  });

  it("launches Windows Terminal, reads the reported PowerShell PID, and removes the PID file", async () => {
    runningPidSpy();
    statMock.mockResolvedValue({ isDirectory: () => true });
    accessMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    rmMock.mockResolvedValue(undefined);
    readFileMock.mockResolvedValue("4321");

    let launcher!: SpawnedProcess;
    spawnMock
      .mockImplementationOnce(() => {
        const where = spawnedProcess();
        queueMicrotask(() => where.emit("close", 0));
        return where;
      })
      .mockImplementationOnce(() => {
        launcher = spawnedProcess();
        queueMicrotask(() => launcher.emit("spawn"));
        return launcher;
      });

    await expect(
      launchClaudeTerminal("D:\\Projects\\Demo", "binding-1", "launch-1")
    ).resolves.toEqual({ terminal: "windows-terminal", processId: 4321 });

    expect(spawnMock).toHaveBeenNthCalledWith(1, "where.exe", ["wt.exe"], {
      windowsHide: true,
      stdio: "ignore"
    });
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      "wt.exe",
      expect.arrayContaining(["-d", "D:\\Projects\\Demo", "powershell.exe", "-EncodedCommand"]),
      expect.objectContaining({
        cwd: "D:\\Projects\\Demo",
        detached: true,
        windowsHide: false,
        stdio: "ignore"
      })
    );
    expect(process.kill).toHaveBeenCalledWith(4321, 0);
    expect(launcher.unref).toHaveBeenCalledTimes(1);
    expect(rmMock).toHaveBeenCalledTimes(2);
    expect(rmMock.mock.calls.every(([, options]) => options?.force === true)).toBe(true);
  });

  it("launches the cmd fallback, reads the PowerShell PID, kills the cmd shim, and removes the PID file", async () => {
    runningPidSpy();
    statMock.mockResolvedValue({ isDirectory: () => true });
    accessMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    rmMock.mockResolvedValue(undefined);
    readFileMock.mockResolvedValue("8765");

    let launcher!: SpawnedProcess;
    spawnMock
      .mockImplementationOnce(() => {
        const where = spawnedProcess();
        queueMicrotask(() => where.emit("close", 1));
        return where;
      })
      .mockImplementationOnce(() => {
        launcher = spawnedProcess();
        return launcher;
      });

    await expect(
      launchClaudeTerminal("D:\\Projects\\Demo", "binding-1", "launch-1")
    ).resolves.toEqual({ terminal: "powershell", processId: 8765 });

    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      "cmd.exe",
      expect.arrayContaining(["/d", "/s", "/c"]),
      expect.objectContaining({
        cwd: "D:\\Projects\\Demo",
        windowsHide: true,
        windowsVerbatimArguments: true,
        stdio: "ignore"
      })
    );
    expect(process.kill).toHaveBeenCalledWith(8765, 0);
    expect(launcher.kill).toHaveBeenCalledTimes(1);
    expect(rmMock).toHaveBeenCalledTimes(2);
  });

  it("removes the PID file when Windows Terminal exits before reporting a PowerShell PID", async () => {
    runningPidSpy();
    statMock.mockResolvedValue({ isDirectory: () => true });
    accessMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    rmMock.mockResolvedValue(undefined);
    readFileMock.mockReturnValue(new Promise(() => undefined));

    spawnMock
      .mockImplementationOnce(() => {
        const where = spawnedProcess();
        queueMicrotask(() => where.emit("close", 0));
        return where;
      })
      .mockImplementationOnce(() => {
        const launcher = spawnedProcess();
        queueMicrotask(() => launcher.emit("close", 7));
        return launcher;
      });

    await expect(
      launchClaudeTerminal("D:\\Projects\\Demo", "binding-1", "launch-1")
    ).rejects.toThrow("Windows Terminal launcher failed (7)");

    expect(rmMock).toHaveBeenCalledTimes(2);
  });
});
