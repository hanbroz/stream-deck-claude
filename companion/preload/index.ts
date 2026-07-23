import { contextBridge, ipcRenderer } from "electron";

import {
  COMPANION_IPC,
  readRuntimeProjectMetadataArg,
  type ClaudeEffort,
  type ClaudeModel,
  type ClaudeSessionStartRequest,
  type ClaudeSessionStarted,
  type DirectoryEntry,
  type RuntimeProjectMetadata,
  type TerminalSessionStarted,
  type TerminalSessionStartRequest
} from "../shared/claude-command";
import type { CompanionSessionStatus } from "../main/session-status";
import type { HistoryPage } from "../main/transcript-history";
import type { ClaudeEvent } from "../shared/claude-stream";
import { diag, setDiagSink } from "../shared/diag";

export type ClaudeCompanionApi = {
  runtime: {
    metadata: RuntimeProjectMetadata;
    folder: string;
    projectName: string;
    model?: string;
    contextPercent?: number;
    resumeSessionId?: string;
  };
  claude: {
    start(request: ClaudeSessionStartRequest): Promise<ClaudeSessionStarted>;
    write(sessionId: string, data: string, imageDataUrls?: string[]): Promise<void>;
    configure(sessionId: string, options: { model?: ClaudeModel; effort?: ClaudeEffort }): Promise<void>;
    clear(sessionId: string): Promise<void>;
    interrupt(sessionId: string): Promise<boolean>;
    history(sessionId: string, offset: number, limit: number): Promise<HistoryPage>;
    kill(sessionId: string): void;
    pasteClipboardImage(sessionId: string, imageDataUrl?: string): Promise<boolean>;
    onData(listener: (message: { sessionId: string; events: ClaudeEvent[] }) => void): () => void;
    onExit(
      listener: (message: {
        sessionId: string;
        exitCode: number;
        signal?: number;
      }) => void
    ): () => void;
  };
  paths: {
    list(path?: string): Promise<DirectoryEntry[]>;
    createDirectory(parentPath: string, name: string): Promise<string>;
    createFile(parentPath: string, name: string, content?: string): Promise<string>;
    open(path: string): Promise<void>;
    reveal(path: string): Promise<void>;
  };
  terminal: {
    start(request?: TerminalSessionStartRequest): Promise<TerminalSessionStarted>;
    write(sessionId: string, data: string): void;
    resize(sessionId: string, cols: number, rows: number): void;
    kill(sessionId: string): void;
    onData(listener: (message: { sessionId: string; data: string }) => void): () => void;
    onExit(
      listener: (message: {
        sessionId: string;
        exitCode: number;
        signal?: number;
      }) => void
    ): () => void;
    openFolder(path: string): Promise<void>;
  };
  session: {
    status(): Promise<CompanionSessionStatus>;
  };
  clipboardWriteText(text: string): Promise<void>;
  diag(line: string): void;
  windowControls: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<void>;
    close(): Promise<void>;
  };
};

function subscribe<T>(
  channel: string,
  listener: (message: T) => void
): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, message: T) => listener(message);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.off(channel, wrapped);
}

const runtimeMetadata = readRuntimeProjectMetadataArg(process.argv);

const forwardDiag = (line: string): void => {
  ipcRenderer.send(COMPANION_IPC.diag, line);
};
setDiagSink(forwardDiag);

const api: ClaudeCompanionApi = {
  runtime: {
    metadata: runtimeMetadata,
    folder: runtimeMetadata.folder,
    projectName: runtimeMetadata.projectName,
    model: runtimeMetadata.model,
    contextPercent: runtimeMetadata.contextPercent,
    resumeSessionId: runtimeMetadata.resumeSessionId
  },
  claude: {
    start: (request) => ipcRenderer.invoke(COMPANION_IPC.claudeStart, request),
    write: (sessionId, data, imageDataUrls) => {
      diag("preload.write.invoke", {
        sessionId,
        textLength: data.length,
        imageCount: imageDataUrls?.length ?? 0
      });
      return ipcRenderer
        .invoke(COMPANION_IPC.claudeWrite, sessionId, data, imageDataUrls)
        .then((result) => {
          diag("preload.write.ok", { sessionId });
          return result;
        })
        .catch((error: unknown) => {
          diag("preload.write.error", {
            sessionId,
            reason: error instanceof Error ? error.message : "unknown"
          });
          throw error;
        });
    },
    configure: (sessionId, options) =>
      ipcRenderer.invoke(COMPANION_IPC.claudeConfigure, sessionId, options),
    clear: (sessionId) => ipcRenderer.invoke(COMPANION_IPC.claudeClear, sessionId),
    interrupt: (sessionId) => ipcRenderer.invoke(COMPANION_IPC.claudeInterrupt, sessionId),
    history: (sessionId, offset, limit) =>
      ipcRenderer.invoke(COMPANION_IPC.claudeHistory, sessionId, offset, limit),
    kill: (sessionId) => ipcRenderer.send(COMPANION_IPC.claudeKill, sessionId),
    pasteClipboardImage: (sessionId, imageDataUrl) =>
      ipcRenderer.invoke(COMPANION_IPC.claudePasteClipboardImage, sessionId, imageDataUrl),
    onData: (listener) => subscribe(COMPANION_IPC.claudeData, listener),
    onExit: (listener) => subscribe(COMPANION_IPC.claudeExit, listener)
  },
  paths: {
    list: (path) => ipcRenderer.invoke(COMPANION_IPC.pathList, path),
    createDirectory: (parentPath, name) =>
      ipcRenderer.invoke(COMPANION_IPC.pathCreateDirectory, parentPath, name),
    createFile: (parentPath, name, content = "") =>
      ipcRenderer.invoke(COMPANION_IPC.pathCreateFile, parentPath, name, content),
    open: (path) => ipcRenderer.invoke(COMPANION_IPC.pathOpen, path),
    reveal: (path) => ipcRenderer.invoke(COMPANION_IPC.pathReveal, path)
  },
  terminal: {
    start: (request = {}) => ipcRenderer.invoke(COMPANION_IPC.terminalStart, request),
    write: (sessionId, data) =>
      ipcRenderer.send(COMPANION_IPC.terminalWrite, sessionId, data),
    resize: (sessionId, cols, rows) =>
      ipcRenderer.send(COMPANION_IPC.terminalResize, sessionId, cols, rows),
    kill: (sessionId) => ipcRenderer.send(COMPANION_IPC.terminalKill, sessionId),
    onData: (listener) => subscribe(COMPANION_IPC.terminalData, listener),
    onExit: (listener) => subscribe(COMPANION_IPC.terminalExit, listener),
    openFolder: (path) => ipcRenderer.invoke(COMPANION_IPC.terminalOpenFolder, path)
  },
  session: {
    status: () => ipcRenderer.invoke(COMPANION_IPC.sessionStatus)
  },
  clipboardWriteText: (text) => ipcRenderer.invoke(COMPANION_IPC.clipboardWriteText, text),
  diag: forwardDiag,
  windowControls: {
    minimize: () => ipcRenderer.invoke(COMPANION_IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(COMPANION_IPC.windowToggleMaximize),
    close: () => ipcRenderer.invoke(COMPANION_IPC.windowClose)
  }
};

contextBridge.exposeInMainWorld("claudeCompanion", api);
