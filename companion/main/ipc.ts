import type { WebContents } from "electron";

import {
  CLAUDE_EFFORTS,
  CLAUDE_MODELS,
  COMPANION_IPC,
  type ClaudeEffort,
  type ClaudeModel,
  type ClaudeSessionStartRequest,
  type TerminalSessionStartRequest
} from "../shared/claude-command";
import { ClaudePtyManager, type ClipboardImageReader } from "./claude-session";
import { diag, emitDiagLine } from "../shared/diag";
import {
  createContainedDirectory,
  createContainedFile,
  deleteContainedPath,
  listContainedDirectory,
  openContainedPath,
  revealContainedPath,
  resolveContainedDirectory,
  type PathShell
} from "./paths";
import { ProjectTerminalManager } from "./terminal-session";
import type { ConversationHistoryReader, HistoryPage } from "./transcript-history";
import type { SlashCommand } from "../shared/slash-commands";
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
    writeText?: (text: string) => void;
  };
  nativeImage?: {
    createFromDataURL(dataUrl: string): unknown;
  };
  shell: PathShell;
  openTerminalFolder?: (folder: string) => unknown;
  sessionStatus?: () => Promise<CompanionSessionStatus> | CompanionSessionStatus;
  historyReader?: ConversationHistoryReader;
  // Persist the applied model/effort for this folder and refresh the Stream Deck
  // key so it shows the new model without waiting for the next message.
  applyModelPrefs?: (prefs: { model: ClaudeModel; effort: ClaudeEffort }) => Promise<void> | void;
  // The slash commands the composer's "/" menu offers.
  slashCommands?: () => Promise<SlashCommand[]> | SlashCommand[];
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

function requireClaudeModel(value: unknown): ClaudeModel {
  if (typeof value !== "string" || !CLAUDE_MODELS.includes(value as ClaudeModel)) {
    throw new Error("model is invalid");
  }
  return value as ClaudeModel;
}

function requireClaudeEffort(value: unknown): ClaudeEffort {
  if (typeof value !== "string" || !CLAUDE_EFFORTS.includes(value as ClaudeEffort)) {
    throw new Error("effort is invalid");
  }
  return value as ClaudeEffort;
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
  return {
    cwd: requireString(request.cwd, "cwd"),
    mode,
    sessionId: optionalString(request.sessionId, "sessionId"),
    model: request.model === undefined ? undefined : requireClaudeModel(request.model),
    effort: request.effort === undefined ? undefined : requireClaudeEffort(request.effort)
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

  ptyManager.on("data", (sessionId, events) => {
    diag("main.ipc.claudeData.send", { sessionId, eventCount: events.length });
    deps.window.webContents.send(COMPANION_IPC.claudeData, { sessionId, events });
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
  deps.ipcMain.handle(COMPANION_IPC.claudeCommands, async (): Promise<SlashCommand[]> =>
    (await deps.slashCommands?.()) ?? []
  );
  deps.ipcMain.handle(COMPANION_IPC.pathDelete, async (_event: SenderEvent, path: unknown) => {
    await deleteContainedPath(deps.rootPath, requireString(path, "path"), deps.shell);
  });
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
      // The prompt shows paths relative to the project root.
      return terminalManager.start({ ...validated, cwd, promptRoot: deps.rootPath });
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
    diag("main.ipc.claudeWrite", {
      sessionId: typeof sessionId === "string" ? sessionId : typeof sessionId,
      dataLength: typeof data === "string" ? data.length : -1
    });
    try {
      ptyManager.write(
        requireString(sessionId, "sessionId"),
        requireString(data, "data"),
        optionalImageDataUrls(imageDataUrls)
      );
    } catch (error) {
      diag("main.ipc.claudeWrite.error", {
        reason: error instanceof Error ? error.message : "unknown"
      });
      throw error;
    }
  });
  deps.ipcMain.on(COMPANION_IPC.diag, (_event: SenderEvent, line) => {
    if (typeof line === "string") {
      emitDiagLine(line);
    }
  });
  deps.ipcMain.handle(COMPANION_IPC.clipboardWriteText, (_event: SenderEvent, text) => {
    // navigator.clipboard.writeText rejects in the sandboxed renderer when the
    // document is not focused, so terminal copy goes through the main-process
    // clipboard, which has no such restriction.
    deps.clipboard.writeText?.(requireString(text, "text"));
  });
  deps.ipcMain.handle(COMPANION_IPC.claudeConfigure, (_event: SenderEvent, sessionId, options) => {
    const config = (options ?? {}) as { model?: unknown; effort?: unknown };
    ptyManager.configure(requireString(sessionId, "sessionId"), {
      model: config.model === undefined ? undefined : requireClaudeModel(config.model),
      effort: config.effort === undefined ? undefined : requireClaudeEffort(config.effort)
    });
  });
  deps.ipcMain.handle(COMPANION_IPC.claudeApply, async (_event: SenderEvent, sessionId, options) => {
    const config = (options ?? {}) as { model?: unknown; effort?: unknown };
    const model = requireClaudeModel(config.model);
    const effort = requireClaudeEffort(config.effort);
    // An empty id means no live session yet (applied during the start window):
    // still persist and refresh the key; the next message picks up the choice.
    const sid = optionalString(sessionId, "sessionId");
    if (sid) {
      ptyManager.configure(sid, { model, effort });
    }
    await deps.applyModelPrefs?.({ model, effort });
  });
  deps.ipcMain.handle(COMPANION_IPC.claudeClear, (_event: SenderEvent, sessionId) => {
    ptyManager.clear(requireString(sessionId, "sessionId"));
  });
  deps.ipcMain.handle(COMPANION_IPC.claudeInterrupt, (_event: SenderEvent, sessionId) =>
    ptyManager.interrupt(requireString(sessionId, "sessionId"))
  );
  deps.ipcMain.handle(
    COMPANION_IPC.claudeHistory,
    async (_event: SenderEvent, sessionId, offset, limit): Promise<HistoryPage> => {
      if (!deps.historyReader) {
        return { messages: [], total: 0, hasMore: false };
      }
      const safeOffset = typeof offset === "number" && offset >= 0 ? Math.floor(offset) : 0;
      // Cap the window so a bad caller cannot request an unbounded slice.
      const safeLimit = typeof limit === "number" ? Math.min(Math.max(Math.floor(limit), 1), 200) : 20;
      return deps.historyReader.page(requireString(sessionId, "sessionId"), safeOffset, safeLimit);
    }
  );
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
