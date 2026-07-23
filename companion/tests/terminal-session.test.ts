import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { POWERSHELL_PROMPT_SCRIPT, ProjectTerminalManager } from "../main/terminal-session";

function fakePty() {
  const data = new EventEmitter();
  const exit = new EventEmitter();
  return {
    data,
    exit,
    onData: (listener: (data: string) => void) => data.on("data", listener),
    onExit: (listener: (event: { exitCode: number; signal?: number }) => void) =>
      exit.on("exit", listener),
    write: vi.fn<(data: string) => void>(),
    resize: vi.fn<(cols: number, rows: number) => void>(),
    kill: vi.fn<() => void>()
  };
}

describe("ProjectTerminalManager", () => {
  it("starts a real interactive PowerShell PTY in the project folder", () => {
    const terminal = fakePty();
    const ptyFactory = vi.fn(() => terminal);
    const manager = new ProjectTerminalManager({
      ptyFactory,
      env: { Path: "test-bin" }
    });
    const data = vi.fn();
    const exit = vi.fn();
    manager.on("data", data);
    manager.on("exit", exit);

    const started = manager.start({ cwd: "D:\\repo", cols: 90, rows: 28 });
    terminal.data.emit("data", "ready");
    terminal.exit.emit("exit", { exitCode: 0 });

    expect(started).toMatchObject({
      cwd: "D:\\repo",
      shell: "powershell"
    });
    expect(ptyFactory).toHaveBeenCalledWith(
      "powershell.exe",
      ["-NoLogo"],
      expect.objectContaining({
        cwd: "D:\\repo",
        cols: 90,
        rows: 28,
        env: expect.objectContaining({ Path: "test-bin", TERM: "xterm-256color" })
      })
    );
    expect(data).toHaveBeenCalledWith(started.sessionId, "ready");
    expect(exit).toHaveBeenCalledWith(started.sessionId, 0, undefined);
  });

  it("injects a project-relative prompt and passes the root via the environment", () => {
    const terminal = fakePty();
    const ptyFactory = vi.fn(() => terminal);
    const manager = new ProjectTerminalManager({ ptyFactory, env: { Path: "test-bin" } });

    manager.start({ cwd: "G:\\내 드라이브\\2ndBrain\\2ndBrain", promptRoot: "G:\\내 드라이브\\2ndBrain\\2ndBrain" });

    const call = ptyFactory.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
    expect(call[0]).toBe("powershell.exe");
    // -NoExit keeps it interactive after the prompt override; the root is not on
    // the command line, so its Korean/space/backslash chars avoid quoting.
    expect(call[1]).toEqual(["-NoLogo", "-NoExit", "-Command", POWERSHELL_PROMPT_SCRIPT]);
    expect(call[1].join(" ")).not.toContain("2ndBrain");
    expect(call[2].env.CLAUDE_TERMINAL_ROOT).toBe("G:\\내 드라이브\\2ndBrain\\2ndBrain");
  });

  it("supports cmd sessions plus write, resize, and kill", () => {
    const terminal = fakePty();
    const manager = new ProjectTerminalManager({
      ptyFactory: vi.fn(() => terminal)
    });
    const started = manager.start({ cwd: "D:\\repo", shell: "cmd" });

    manager.write(started.sessionId, "dir\r");
    manager.resize(started.sessionId, 120, 32);
    manager.kill(started.sessionId);

    expect(terminal.write).toHaveBeenCalledWith("dir\r");
    expect(terminal.resize).toHaveBeenCalledWith(120, 32);
    expect(terminal.kill).toHaveBeenCalledTimes(1);
  });
});
