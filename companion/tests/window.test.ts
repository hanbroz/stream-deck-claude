import { describe, expect, it, vi } from "vitest";

import { readRuntimeProjectMetadataArg } from "../shared/claude-command";
import {
  companionWindowOptions,
  createCompanionWindow,
  type BrowserWindowLike
} from "../main/window";

describe("companionWindowOptions", () => {
  it("disables renderer Node access and enables context isolation", () => {
    const options = companionWindowOptions("D:\\app\\preload.cjs");

    expect(options.webPreferences).toMatchObject({
      preload: "D:\\app\\preload.cjs",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    });
    expect(options.webPreferences?.additionalArguments).toEqual([]);
  });

  it("passes runtime metadata through additional preload arguments", () => {
    const options = companionWindowOptions("D:\\app\\preload.cjs", {
      folder: "D:\\repo",
      projectName: "Repo"
    });

    expect(
      readRuntimeProjectMetadataArg(options.webPreferences?.additionalArguments ?? [])
    ).toEqual({
      folder: "D:\\repo",
      projectName: "Repo",
      model: undefined,
      contextPercent: undefined,
      resumeSessionId: undefined
    });
  });
});

describe("createCompanionWindow", () => {
  it("denies popup windows and navigation before loading the renderer", async () => {
    const setWindowOpenHandler = vi.fn();
    const on = vi.fn();
    const loadFile = vi.fn().mockResolvedValue(undefined);
    const loadURL = vi.fn().mockResolvedValue(undefined);
    const show = vi.fn();
    const beforeLoad = vi.fn();
    class FakeBrowserWindow implements BrowserWindowLike {
      public readonly webContents = {
        send: vi.fn(),
        setWindowOpenHandler,
        on
      };

      public loadFile = loadFile;
      public loadURL = loadURL;
      public show = show;
    }

    await createCompanionWindow({
      BrowserWindow: FakeBrowserWindow,
      preloadPath: "D:\\app\\preload.cjs",
      indexPath: "D:\\app\\index.html",
      beforeLoad
    });

    expect(setWindowOpenHandler).toHaveBeenCalledTimes(1);
    expect(setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: "deny" });
    expect(on).toHaveBeenCalledWith("will-navigate", expect.any(Function));
    expect(beforeLoad).toHaveBeenCalledTimes(1);
    expect(loadFile).toHaveBeenCalledWith("D:\\app\\index.html");
    expect(show).toHaveBeenCalledTimes(1);
  });
});
