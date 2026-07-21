import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { ClaudePtyManager } from "../main/claude-session";

type FakePty = {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write: ReturnType<typeof vi.fn<(data: string) => void>>;
  resize: ReturnType<typeof vi.fn<(cols: number, rows: number) => void>>;
  kill: ReturnType<typeof vi.fn<() => void>>;
  data: EventEmitter;
  exit: EventEmitter;
};

function fakePty(): FakePty {
  const data = new EventEmitter();
  const exit = new EventEmitter();
  return {
    data,
    exit,
    onData: (listener) => data.on("data", listener),
    onExit: (listener) => exit.on("exit", listener),
    write: vi.fn<(data: string) => void>(),
    resize: vi.fn<(cols: number, rows: number) => void>(),
    kill: vi.fn<() => void>()
  };
}

describe("ClaudePtyManager", () => {
  it("spawns Claude in the requested cwd and forwards output/exit events", () => {
    const terminal = fakePty();
    const ptyFactory = vi.fn(() => terminal);
    const manager = new ClaudePtyManager({
      ptyFactory,
      command: "claude.exe",
      env: { Path: "test-bin" }
    });
    const data = vi.fn();
    const exit = vi.fn();
    manager.on("data", data);
    manager.on("exit", exit);

    const started = manager.start({ cwd: "D:\\repo", cols: 100, rows: 40 });
    terminal.data.emit("data", "hello");
    terminal.exit.emit("exit", { exitCode: 0 });

    expect(started).toMatchObject({ cwd: "D:\\repo", mode: "new" });
    expect(ptyFactory).toHaveBeenCalledWith(
      "claude.exe",
      ["--dangerously-skip-permissions"],
      expect.objectContaining({
        cwd: "D:\\repo",
        cols: 100,
        rows: 40,
        env: expect.objectContaining({ Path: "test-bin", TERM: "xterm-256color" })
      })
    );
    expect(data).toHaveBeenCalledWith(started.sessionId, "hello");
    expect(exit).toHaveBeenCalledWith(started.sessionId, 0, undefined);
    expect(manager.has(started.sessionId)).toBe(false);
  });

  it("uses resume args, supports write/resize/kill, and sends ESC-v for clipboard images", () => {
    const terminal = fakePty();
    const manager = new ClaudePtyManager({
      ptyFactory: vi.fn(() => terminal) as never,
      command: "claude.exe"
    });
    const started = manager.start({
      cwd: "D:\\repo",
      mode: "resume",
      sessionId: "claude-session"
    });

    manager.write(started.sessionId, "input");
    manager.resize(started.sessionId, 80, 24);
    const pasted = manager.pasteClipboardImage(started.sessionId, {
      readImage: () => ({ isEmpty: () => false })
    });
    manager.kill(started.sessionId);

    expect(terminal.write).toHaveBeenNthCalledWith(1, "input");
    expect(terminal.write).toHaveBeenNthCalledWith(2, "\u001bv");
    expect(terminal.resize).toHaveBeenCalledWith(80, 24);
    expect(pasted).toBe(true);
    expect(terminal.kill).toHaveBeenCalledTimes(1);
  });

  it("does not write ESC-v when the clipboard has no image", () => {
    const terminal = fakePty();
    const manager = new ClaudePtyManager({
      ptyFactory: vi.fn(() => terminal) as never
    });
    const started = manager.start({ cwd: "D:\\repo" });

    expect(
      manager.pasteClipboardImage(started.sessionId, {
        readImage: () => ({ isEmpty: () => true })
      })
    ).toBe(false);
    expect(terminal.write).not.toHaveBeenCalled();
  });
});
