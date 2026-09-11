import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, realpath, rm, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerCompanionIpc } from "../main/ipc";
import { COMPANION_IPC, type DirectoryEntry } from "../shared/claude-command";

describe("explorer filesystem IPC", () => {
  it("notifies for external nested create, rename and delete, and releases watches on close", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "explorer-ipc-")));
    const lifecycle = new EventEmitter();
    const handlers = new Map<string, (...args: any[]) => unknown>();
    const send = vi.fn();
    registerCompanionIpc({
      rootPath: root,
      ipcMain: {
        handle: (channel, handler) => { handlers.set(channel, handler); },
        on: vi.fn()
      },
      window: {
        once: (event, handler) => { lifecycle.once(event, handler); },
        webContents: { send }
      },
      clipboard: { readImage: () => ({ isEmpty: () => true }) },
      shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), trashItem: vi.fn() }
    });
    const list = (directory: string) =>
      handlers.get(COMPANION_IPC.pathList)!({}, directory) as Promise<DirectoryEntry[]>;
    const notified = async () => {
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(COMPANION_IPC.pathChanged, undefined), {
        timeout: 4_000, interval: 25
      });
      send.mockClear();
    };
    try {
      const nested = path.join(root, "src");
      await mkdir(nested);
      await list(root);
      await list(nested);
      await expect(list("..")).rejects.toThrow("outside the allowed root");

      await writeFile(path.join(nested, "new.ts"), "one");
      await notified();
      expect((await list(nested)).map((entry) => entry.name)).toEqual(["new.ts"]);

      await rename(path.join(nested, "new.ts"), path.join(nested, "renamed.ts"));
      await notified();
      expect((await list(nested)).map((entry) => entry.name)).toEqual(["renamed.ts"]);

      await rm(path.join(nested, "renamed.ts"));
      await notified();
      expect(await list(nested)).toEqual([]);

      lifecycle.emit("closed");
      await writeFile(path.join(nested, "after-close.ts"), "closed");
      await new Promise((resolve) => setTimeout(resolve, 850));
      expect(send).not.toHaveBeenCalled();
    } finally {
      lifecycle.emit("closed");
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
