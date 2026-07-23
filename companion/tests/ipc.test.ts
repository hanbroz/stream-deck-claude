import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClaudePtyManager } from "../main/claude-session";
import { registerCompanionIpc } from "../main/ipc";
import { ProjectTerminalManager } from "../main/terminal-session";
import { COMPANION_IPC } from "../shared/claude-command";
import { encodeClaudeUserMessage } from "../shared/claude-stream";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "companion-ipc-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fakeIpcMain() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      listeners.set(channel, listener);
    }),
    handlers,
    listeners
  };
}

describe("registerCompanionIpc", () => {
  it("registers typed channels, forwards PTY events, and contains terminal folders", async () => {
    const ipcMain = fakeIpcMain();
    const send = vi.fn();
    const openTerminalFolder = vi.fn();
    const terminalWrite = vi.fn();
    const terminalResize = vi.fn();
    const terminalKill = vi.fn();
    const claudeWrite = vi.fn();
    const ptyManager = new ClaudePtyManager({
      runFactory: vi.fn(() => ({
        onData: vi.fn(),
        onError: vi.fn(),
        onExit: vi.fn(),
        writeStdin: claudeWrite,
        endStdin: vi.fn(),
        kill: vi.fn()
      }))
    });
    const terminalManager = new ProjectTerminalManager({
      ptyFactory: vi.fn(() => ({
        onData: vi.fn(),
        onExit: vi.fn(),
        write: terminalWrite,
        resize: terminalResize,
        kill: terminalKill
      }))
    });

    registerCompanionIpc({
      ipcMain,
      window: { webContents: { send } },
      rootPath: root,
      ptyManager,
      terminalManager,
      clipboard: { readImage: () => ({ isEmpty: () => true }) },
      shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
      openTerminalFolder
    });

    expect(ipcMain.handle).toHaveBeenCalledWith(
      COMPANION_IPC.claudeStart,
      expect.any(Function)
    );
    expect(ipcMain.handle).toHaveBeenCalledWith(
      COMPANION_IPC.pathCreateFile,
      expect.any(Function)
    );
    expect(ipcMain.handle).toHaveBeenCalledWith(
      COMPANION_IPC.claudeWrite,
      expect.any(Function)
    );
    expect(ipcMain.handle).toHaveBeenCalledWith(
      COMPANION_IPC.terminalStart,
      expect.any(Function)
    );
    expect(ipcMain.on).toHaveBeenCalledWith(
      COMPANION_IPC.terminalWrite,
      expect.any(Function)
    );

    ptyManager.emit("data", "session-1", [{ kind: "text", text: "chunk" }]);
    ptyManager.emit("exit", "session-1", 0);
    terminalManager.emit("data", "term-1", "prompt");
    terminalManager.emit("exit", "term-1", 1);

    expect(send).toHaveBeenCalledWith(COMPANION_IPC.claudeData, {
      sessionId: "session-1",
      events: [{ kind: "text", text: "chunk" }]
    });
    expect(send).toHaveBeenCalledWith(COMPANION_IPC.claudeExit, {
      sessionId: "session-1",
      exitCode: 0,
      signal: undefined
    });
    expect(send).toHaveBeenCalledWith(COMPANION_IPC.terminalData, {
      sessionId: "term-1",
      data: "prompt"
    });
    expect(send).toHaveBeenCalledWith(COMPANION_IPC.terminalExit, {
      sessionId: "term-1",
      exitCode: 1,
      signal: undefined
    });

    await ipcMain.handlers.get(COMPANION_IPC.terminalOpenFolder)?.({}, ".");
    expect(openTerminalFolder).toHaveBeenCalledWith(root);
    await expect(
      ipcMain.handlers.get(COMPANION_IPC.terminalOpenFolder)?.({}, "..")
    ).rejects.toThrow("Path is outside the allowed root");
    await expect(
      ipcMain.handlers.get(COMPANION_IPC.claudeStart)?.({}, { cwd: ".." })
    ).rejects.toThrow("Path is outside the allowed root");
    const claudeStarted = (await ipcMain.handlers.get(COMPANION_IPC.claudeStart)?.(
      {},
      { cwd: "." }
    )) as { sessionId: string };
    await ipcMain.handlers.get(COMPANION_IPC.claudeWrite)?.(
      {},
      claudeStarted.sessionId,
      "hello"
    );
    expect(claudeWrite).toHaveBeenCalledWith(encodeClaudeUserMessage("hello"));
    const terminalStarted = (await ipcMain.handlers.get(COMPANION_IPC.terminalStart)?.(
      {},
      { cwd: ".", shell: "cmd" }
    )) as { sessionId: string };
    ipcMain.listeners.get(COMPANION_IPC.terminalWrite)?.({}, terminalStarted.sessionId, "dir\r");
    ipcMain.listeners.get(COMPANION_IPC.terminalResize)?.({}, terminalStarted.sessionId, 80, 24);
    ipcMain.listeners.get(COMPANION_IPC.terminalKill)?.({}, terminalStarted.sessionId);
    expect(terminalWrite).toHaveBeenCalledWith("dir\r");
    expect(terminalResize).toHaveBeenCalledWith(80, 24);
    expect(terminalKill).toHaveBeenCalledTimes(1);
  });

  it("writes a renderer image data URL to the native clipboard before pasting", async () => {
    const ipcMain = fakeIpcMain();
    const write = vi.fn();
    const writeImage = vi.fn();
    const createFromDataURL = vi.fn(() => ({ native: true }));
    const ptyManager = new ClaudePtyManager({
      runFactory: vi.fn(() => ({
        onData: vi.fn(),
        onError: vi.fn(),
        onExit: vi.fn(),
        writeStdin: write,
        endStdin: vi.fn(),
        kill: vi.fn()
      }))
    });

    registerCompanionIpc({
      ipcMain,
      window: { webContents: { send: vi.fn() } },
      rootPath: root,
      ptyManager,
      clipboard: {
        readImage: () => ({
          isEmpty: () => false,
          toDataURL: () => "data:image/png;base64,AAAA"
        }),
        writeImage
      },
      nativeImage: { createFromDataURL },
      shell: { openPath: vi.fn(), showItemInFolder: vi.fn() }
    });

    const started = ptyManager.start({ cwd: root });
    expect(
      ipcMain.handlers.get(COMPANION_IPC.claudePasteClipboardImage)?.(
        {},
        started.sessionId,
        "data:image/png;base64,AAAA"
      )
    ).toBe(true);

    expect(createFromDataURL).toHaveBeenCalledWith("data:image/png;base64,AAAA");
    expect(writeImage).toHaveBeenCalledWith({ native: true });
    expect(write).toHaveBeenCalledWith(encodeClaudeUserMessage("", ["data:image/png;base64,AAAA"]));
  });

  function registerFor(overrides: Record<string, unknown> = {}) {
    const ipcMain = fakeIpcMain();
    registerCompanionIpc({
      ipcMain,
      window: { webContents: { send: vi.fn() } },
      rootPath: root,
      clipboard: { readImage: () => ({ isEmpty: () => true }) },
      shell: { openPath: vi.fn(), showItemInFolder: vi.fn() },
      ...overrides
    } as unknown as Parameters<typeof registerCompanionIpc>[0]);
    return ipcMain;
  }

  it("clamps the history window and page offset, and falls back without a reader", async () => {
    const page = vi.fn(async () => ({ messages: [], total: 0, hasMore: false }));
    const withReader = registerFor({ historyReader: { page } });

    await withReader.handlers.get(COMPANION_IPC.claudeHistory)?.({}, "sess", -5, 9999);
    expect(page).toHaveBeenCalledWith("sess", 0, 200); // offset floored to 0, limit capped at 200

    await withReader.handlers.get(COMPANION_IPC.claudeHistory)?.({}, "sess", 40, undefined);
    expect(page).toHaveBeenCalledWith("sess", 40, 20); // default limit

    const noReader = registerFor();
    await expect(
      noReader.handlers.get(COMPANION_IPC.claudeHistory)?.({}, "sess", 0, 20)
    ).resolves.toEqual({ messages: [], total: 0, hasMore: false });
  });

  it("validates model/effort on configure and rejects unknown values", () => {
    const configure = vi.fn();
    const clear = vi.fn();
    const ipcMain = registerFor({ ptyManager: { on: vi.fn(), configure, clear } });

    ipcMain.handlers.get(COMPANION_IPC.claudeConfigure)?.({}, "s", { model: "opus", effort: "high" });
    expect(configure).toHaveBeenCalledWith("s", { model: "opus", effort: "high" });

    expect(() => ipcMain.handlers.get(COMPANION_IPC.claudeConfigure)?.({}, "s", { model: "gpt" }))
      .toThrow(/model is invalid/u);

    ipcMain.handlers.get(COMPANION_IPC.claudeClear)?.({}, "s");
    expect(clear).toHaveBeenCalledWith("s");
  });
});
