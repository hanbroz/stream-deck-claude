import type { WebContents } from "electron";

import {
  COMPANION_IPC,
  type ClaudeSessionStartRequest,
  type TerminalSessionStartRequest
} from "../shared/claude-command";
import { ClaudePtyManager, type ClipboardImageReader } from "./claude-session";
import {
  createContainedDirectory,
  createContainedFile,
  listContainedDirectory,
  openContainedPath,
  revealContainedPath,
  resolveContainedDirectory,
  type PathShell
} from "./paths";
import { ProjectTerminalManager } from "./terminal-session";
import type { CompanionSessionStatus } from "./session-status";
import { openWindowsTerminalFolder } from "./windows-terminal";

export type CompanionIpcDependencies = {
  ipcMain: {
    handle(
      channel: string,
      listener: (event: SenderEvent, ...args: any[]) => unknown
    ): void;
    on(
      channel: string,
      listener: (event: SenderEvent, ...args: any[]) => void
    ): void;
  };
  window: {
    webContents: {
      send(channel: string, ...args: unknown[]): void;
    };
    minimize?(): void;
    maximize?(): void;
    unmaximize?(): void;
    isMaximized?(): boolean;
    close?(): void;
  };
  rootPath: string;
  ptyManager?: ClaudePtyManager;
  terminalManager?: ProjectTerminalManager;
  clipboard: ClipboardImageReader & {
    writeImage?: (image: unknown) => void;
  };
  nativeImage?: {
    createFromDataURL(dataUrl: string): unknown;
  };
  shell: PathShell;
  openTerminalFolder?: (folder: string) => unknown;
  sessionStatus?: () => Promise<CompanionSessionStatus> | CompanionSessionStatus;
};

type SenderEvent = {
  sender: WebContents;
};

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireString(value, label);
}

function optionalImageDataUrl(value: unknown): string | undefined {
  const dataUrl = optionalString(value, "imageDataUrl");
  if (dataUrl === undefined) {
    return undefined;
  }
  if (dataUrl.length > 20 * 1024 * 1024 || !/^data:image\/[a-z0-9.+-]+;base64,/iu.test(dataUrl)) {
    throw new Error("imageDataUrl must be a base64 encoded image under 20 MB");
  }
  return dataUrl;
}

function optionalImageDataUrls(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("imageDataUrls must be an array");
  }
  return value.map((entry) => {
    const dataUrl = optionalImageDataUrl(entry);
    if (!dataUrl) {
      throw new Error("imageDataUrls must contain image data URLs");
    }
    return dataUrl;
  });
}

function requireClaudeStartRequest(value: unknown): ClaudeSessionStartRequest {
  if (typeof value !== "object" || value === null) {
    throw new Error("Claude start request must be an object");
  }
  const request = value as Record<string, unknown>;
  const mode = request.mode;
  if (mode !== undefined && mode !== "new" && mode !== "resume") {
    throw new Error("Claude launch mode is invalid");
  }
  const cols = request.cols;
  const rows = request.rows;
  if (cols !== undefined && typeof cols !== "number") {
    throw new Error("cols must be a number");
  }
  if (rows !== undefined && typeof rows !== "number") {
    throw new Error("rows must be a number");
  }
  return {
    cwd: requireString(request.cwd, "cwd"),
    mode,
    sessionId: optionalString(request.sessionId, "sessionId"),
    cols,
    rows
  };
}

function requireTerminalStartRequest(value: unknown): TerminalSessionStartRequest {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "object" || value === null) {
    throw new Error("Terminal start request must be an object");
  }
  const request = value as Record<string, unknown>;
  const shell = request.shell;
  if (shell !== undefined && shell !== "powershell" && shell !== "cmd") {
    throw new Error("Terminal shell is invalid");
  }
  const cols = request.cols;
  const rows = request.rows;
  if (cols !== undefined && typeof cols !== "number") {
    throw new Error("cols must be a number");
  }
  if (rows !== undefined && typeof rows !== "number") {
    throw new Error("rows must be a number");
  }
  return {
    cwd: optionalString(request.cwd, "cwd"),
    shell,
    cols,
    rows
  };
}

export function registerCompanionIpc(deps: CompanionIpcDependencies): ClaudePtyManager {
  const ptyManager = deps.ptyManager ?? new ClaudePtyManager();
  const terminalManager = deps.terminalManager ?? new ProjectTerminalManager();
  const openTerminal = deps.openTerminalFolder ?? openWindowsTerminalFolder;

  ptyManager.on("data", (sessionId, data) => {
    deps.window.webContents.send(COMPANION_IPC.claudeData, { sessionId, data });
  });
  ptyManager.on("exit", (sessionId, exitCode, signal) => {
    deps.window.webContents.send(COMPANION_IPC.claudeExit, {
      sessionId,
      exitCode,
      signal
    });
  });
  terminalManager.on("data", (sessionId, data) => {
    deps.window.webContents.send(COMPANION_IPC.terminalData, { sessionId, data });
  });
  terminalManager.on("exit", (sessionId, exitCode, signal) => {
    deps.window.webContents.send(COMPANION_IPC.terminalExit, {
      sessionId,
      exitCode,
      signal
    });
  });

  deps.ipcMain.handle(
    COMPANION_IPC.claudeStart,
    async (_event: SenderEvent, request: unknown) => {
      const validated = requireClaudeStartRequest(request);
      const cwd = await resolveContainedDirectory(deps.rootPath, validated.cwd);
      return ptyManager.start({ ...validated, cwd });
    }
  );
  deps.ipcMain.handle(
    COMPANION_IPC.claudePasteClipboardImage,
    (_event: SenderEvent, sessionId: unknown, imageDataUrl: unknown) => {
      const dataUrl = optionalImageDataUrl(imageDataUrl);
      if (dataUrl !== undefined) {
        if (!deps.nativeImage || !deps.clipboard.writeImage) {
          throw new Error("Image clipboard support is unavailable");
        }
        deps.clipboard.writeImage(deps.nativeImage.createFromDataURL(dataUrl));
      }
      return ptyManager.pasteClipboardImage(requireString(sessionId, "sessionId"), deps.clipboard);
    }
  );
  deps.ipcMain.handle(COMPANION_IPC.pathList, (_event: SenderEvent, path = ".") =>
    listContainedDirectory(deps.rootPath, requireString(path, "path"))
  );
  deps.ipcMain.handle(
    COMPANION_IPC.pathCreateDirectory,
    (_event: SenderEvent, parentPath: unknown, name: unknown) =>
      createContainedDirectory(
        deps.rootPath,
        requireString(parentPath, "parentPath"),
        requireString(name, "name")
      )
  );
  deps.ipcMain.handle(
    COMPANION_IPC.pathCreateFile,
    (_event: SenderEvent, parentPath: unknown, name: unknown, content = "") =>
      createContainedFile(
        deps.rootPath,
        requireString(parentPath, "parentPath"),
        requireString(name, "name"),
        requireString(content, "content")
      )
  );
  deps.ipcMain.handle(COMPANION_IPC.pathOpen, async (_event: SenderEvent, path: unknown) => {
    await openContainedPath(deps.rootPath, requireString(path, "path"), deps.shell);
  });
  deps.ipcMain.handle(COMPANION_IPC.pathReveal, async (_event: SenderEvent, path: unknown) => {
    await revealContainedPath(deps.rootPath, requireString(path, "path"), deps.shell);
  });
  deps.ipcMain.handle(COMPANION_IPC.terminalOpenFolder, async (_event: SenderEvent, path: unknown) => {
    openTerminal(await resolveContainedDirectory(deps.rootPath, requireString(path, "path")));
  });
  deps.ipcMain.handle(
    COMPANION_IPC.terminalStart,
    async (_event: SenderEvent, request: unknown) => {
      const validated = requireTerminalStartRequest(request);
      const cwd = await resolveContainedDirectory(deps.rootPath, validated.cwd ?? ".");
      return terminalManager.start({ ...validated, cwd });
    }
  );
  deps.ipcMain.handle(COMPANION_IPC.sessionStatus, () => deps.sessionStatus?.() ?? {});
  deps.ipcMain.handle(COMPANION_IPC.windowMinimize, () => {
    deps.window.minimize?.();
  });
  deps.ipcMain.handle(COMPANION_IPC.windowToggleMaximize, () => {
    if (deps.window.isMaximized?.()) {
      deps.window.unmaximize?.();
    } else {
      deps.window.maximize?.();
    }
  });
  deps.ipcMain.handle(COMPANION_IPC.windowClose, () => {
    deps.window.close?.();
  });

  deps.ipcMain.handle(COMPANION_IPC.claudeWrite, (_event: SenderEvent, sessionId, data, imageDataUrls) => {
    ptyManager.write(
      requireString(sessionId, "sessionId"),
      requireString(data, "data"),
      optionalImageDataUrls(imageDataUrls)
    );
  });
  deps.ipcMain.on(COMPANION_IPC.claudeResize, (_event: SenderEvent, sessionId, cols, rows) => {
    if (typeof cols !== "number" || typeof rows !== "number") {
      throw new Error("PTY dimensions must be numbers");
    }
    ptyManager.resize(requireString(sessionId, "sessionId"), cols, rows);
  });
  deps.ipcMain.on(COMPANION_IPC.claudeKill, (_event: SenderEvent, sessionId) => {
    ptyManager.kill(requireString(sessionId, "sessionId"));
  });
  deps.ipcMain.on(COMPANION_IPC.terminalWrite, (_event: SenderEvent, sessionId, data) => {
    terminalManager.write(requireString(sessionId, "sessionId"), requireString(data, "data"));
  });
  deps.ipcMain.on(COMPANION_IPC.terminalResize, (_event: SenderEvent, sessionId, cols, rows) => {
    if (typeof cols !== "number" || typeof rows !== "number") {
      throw new Error("PTY dimensions must be numbers");
    }
    terminalManager.resize(requireString(sessionId, "sessionId"), cols, rows);
  });
  deps.ipcMain.on(COMPANION_IPC.terminalKill, (_event: SenderEvent, sessionId) => {
    terminalManager.kill(requireString(sessionId, "sessionId"));
  });

  return ptyManager;
}
