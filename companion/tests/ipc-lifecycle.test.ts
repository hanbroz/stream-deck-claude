import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { ClaudePtyManager } from "../main/claude-session";
import { registerCompanionIpc } from "../main/ipc";
import { ProjectTerminalManager } from "../main/terminal-session";
import { COMPANION_IPC } from "../shared/claude-command";

function harness() {
  const lifecycle = new EventEmitter();
  const ptyData = new EventEmitter();
  const ptyExit = new EventEmitter();
  const terminal = {
    onData: (listener: (data: string) => void) => ptyData.on("data", listener),
    onExit: (listener: (event: { exitCode: number }) => void) => ptyExit.on("exit", listener),
    write: vi.fn(), resize: vi.fn(), kill: vi.fn()
  };
  const ptyManager = new ClaudePtyManager();
  const terminalManager = new ProjectTerminalManager({ ptyFactory: () => terminal });
  let windowDestroyed = false;
  let contentsDestroyed = false;
  const send = vi.fn((_channel: string, ..._args: unknown[]) => {
    if (contentsDestroyed) throw new TypeError("Object has been destroyed");
  });
  const contents = { isDestroyed: () => contentsDestroyed, send };
  const readContents = vi.fn(() => {
    if (windowDestroyed) throw new TypeError("Object has been destroyed");
    return contents;
  });
  const window = {
    isDestroyed: () => windowDestroyed,
    once: (event: "closed", handler: () => void) => { lifecycle.once(event, handler); },
    get webContents() { return readContents(); }
  };
  registerCompanionIpc({
    ipcMain: { handle: vi.fn(), on: vi.fn() }, window,
    rootPath: process.cwd(), ptyManager, terminalManager,
    clipboard: { readImage: () => ({ isEmpty: () => true }) },
    shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), trashItem: vi.fn() }
  });
  const emitAll = () => {
    ptyManager.emit("data", "claude", [{ kind: "text", text: "late" }]);
    ptyManager.emit("exit", "claude", 0);
    terminalManager.emit("data", "terminal", "late");
    terminalManager.emit("exit", "terminal", 0);
  };
  return {
    ptyManager, terminalManager, terminal, ptyData, ptyExit, send, readContents, emitAll,
    destroyWindow: () => { windowDestroyed = true; },
    destroyContents: () => { contentsDestroyed = true; },
    close: () => { windowDestroyed = true; contentsDestroyed = true; lifecycle.emit("closed"); }
  };
}

describe("Companion IPC window lifecycle", () => {
  it("forwards all four streams while the window is alive", () => {
    const h = harness();
    h.emitAll();
    expect(h.send.mock.calls.map((args) => args[0])).toEqual([
      COMPANION_IPC.claudeData, COMPANION_IPC.claudeExit,
      COMPANION_IPC.terminalData, COMPANION_IPC.terminalExit
    ]);
  });

  it("does not access webContents once the window is destroyed", () => {
    const h = harness();
    h.destroyWindow();
    h.readContents.mockClear();
    expect(h.emitAll).not.toThrow();
    expect(h.readContents).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("drops late events when webContents is destroyed before the window", () => {
    const h = harness();
    h.destroyContents();
    expect(h.emitAll).not.toThrow();
    expect(h.send).not.toHaveBeenCalled();
  });

  it("detaches only renderer listeners on close and survives delayed PTY shutdown output", () => {
    const h = harness();
    const otherData = vi.fn();
    const otherExit = vi.fn();
    h.terminalManager.on("data", otherData);
    h.terminalManager.on("exit", otherExit);
    h.terminalManager.start({ cwd: process.cwd() });
    h.close();
    expect(h.ptyManager.listenerCount("data")).toBe(0);
    expect(h.ptyManager.listenerCount("exit")).toBe(0);
    expect(h.terminalManager.listenerCount("data")).toBe(1);
    expect(h.terminalManager.listenerCount("exit")).toBe(1);
    h.terminalManager.killAll();
    expect(h.terminal.kill).toHaveBeenCalledOnce();
    expect(() => {
      h.ptyData.emit("data", "buffered after kill");
      h.ptyExit.emit("exit", { exitCode: 0 });
      h.emitAll();
    }).not.toThrow();
    expect(otherData).toHaveBeenCalledTimes(2);
    expect(otherExit).toHaveBeenCalledTimes(2);
    expect(h.send).not.toHaveBeenCalled();
  });

  it("allows synchronous PTY kill events to finish before the closed callback arrives", () => {
    const h = harness();
    const exit = vi.fn();
    h.terminalManager.on("exit", exit);
    const { sessionId } = h.terminalManager.start({ cwd: process.cwd() });
    h.terminal.kill.mockImplementation(() => {
      h.ptyData.emit("data", "last output");
      h.ptyExit.emit("exit", { exitCode: 0 });
    });
    h.destroyWindow();
    h.terminalManager.killAll();
    expect(exit).toHaveBeenCalledWith(sessionId, 0, undefined);
    expect(h.send).not.toHaveBeenCalled();
  });
});
