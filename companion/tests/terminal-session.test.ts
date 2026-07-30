import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { POWERSHELL_PROMPT_SCRIPT, ProjectTerminalManager } from "../main/terminal-session";
import type { PtyFactory } from "../main/pty-types";

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
  it("does not hand the key's launch identifiers to the project shell", () => {
    const terminal = fakePty();
    const ptyFactory = vi.fn<PtyFactory>(() => terminal);
    const manager = new ProjectTerminalManager({
      ptyFactory,
      env: {
        Path: "test-bin",
        // The Companion is launched with these; passing them on made any `claude`
        // started in this shell write the key's own state files — its SessionEnd
        // hook flipped the key to "Closed" while the app was still open, and its
        // status line overwrote the key's model and context.
        CLAUDE_STREAM_DECK_BINDING_ID: "binding-1",
        CLAUDE_STREAM_DECK_LAUNCH_ID: "launch-1",
        CLAUDE_STREAM_DECK_FOLDER: "D:\\repo",
        CLAUDE_DECK_RUNTIME_OWNER: "companion"
      }
    });

    manager.start({ cwd: "D:\\repo", promptRoot: "D:\\repo" });

    const env = ptyFactory.mock.calls[0][2].env;
    expect(env.Path).toBe("test-bin");
    expect(env.CLAUDE_TERMINAL_ROOT).toBe("D:\\repo");
    for (const leaked of Object.keys(env)) {
      expect(leaked.startsWith("CLAUDE_STREAM_DECK_")).toBe(false);
      expect(leaked.startsWith("CLAUDE_DECK_")).toBe(false);
    }
  });


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
