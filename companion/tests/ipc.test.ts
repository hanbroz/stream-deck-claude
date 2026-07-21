import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClaudePtyManager } from "../main/claude-session";
import { registerCompanionIpc } from "../main/ipc";
import { COMPANION_IPC } from "../shared/claude-command";

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
    const ptyManager = new ClaudePtyManager({
      ptyFactory: vi.fn(() => ({
        onData: vi.fn(),
        onExit: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn()
      }))
    });

    registerCompanionIpc({
      ipcMain,
      window: { webContents: { send } },
      rootPath: root,
      ptyManager,
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
    expect(ipcMain.on).toHaveBeenCalledWith(
      COMPANION_IPC.claudeWrite,
      expect.any(Function)
    );

    ptyManager.emit("data", "session-1", "chunk");
    ptyManager.emit("exit", "session-1", 0);

    expect(send).toHaveBeenCalledWith(COMPANION_IPC.claudeData, {
      sessionId: "session-1",
      data: "chunk"
    });
    expect(send).toHaveBeenCalledWith(COMPANION_IPC.claudeExit, {
      sessionId: "session-1",
      exitCode: 0,
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
  });

  it("writes a renderer image data URL to the native clipboard before pasting", async () => {
    const ipcMain = fakeIpcMain();
    const write = vi.fn();
    const writeImage = vi.fn();
    const createFromDataURL = vi.fn(() => ({ native: true }));
    const ptyManager = new ClaudePtyManager({
      ptyFactory: vi.fn(() => ({
        onData: vi.fn(),
        onExit: vi.fn(),
        write,
        resize: vi.fn(),
        kill: vi.fn()
      }))
    });

    registerCompanionIpc({
      ipcMain,
      window: { webContents: { send: vi.fn() } },
      rootPath: root,
      ptyManager,
      clipboard: {
        readImage: () => ({ isEmpty: () => false }),
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
    expect(write).toHaveBeenCalledWith("\u001bv");
  });
});
