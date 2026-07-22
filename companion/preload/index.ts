import { contextBridge, ipcRenderer } from "electron";

import {
  COMPANION_IPC,
  readRuntimeProjectMetadataArg,
  type ClaudeSessionStartRequest,
  type ClaudeSessionStarted,
  type DirectoryEntry,
  type RuntimeProjectMetadata,
  type TerminalSessionStarted,
  type TerminalSessionStartRequest
} from "../shared/claude-command";
import type { CompanionSessionStatus } from "../main/session-status";

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
    write(sessionId: string, data: string, imageDataUrls?: string[]): void;
    resize(sessionId: string, cols: number, rows: number): void;
    kill(sessionId: string): void;
    pasteClipboardImage(sessionId: string, imageDataUrl?: string): Promise<boolean>;
    onData(listener: (message: { sessionId: string; data: string }) => void): () => void;
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
    write: (sessionId, data, imageDataUrls) =>
      ipcRenderer.send(COMPANION_IPC.claudeWrite, sessionId, data, imageDataUrls),
    resize: (sessionId, cols, rows) =>
      ipcRenderer.send(COMPANION_IPC.claudeResize, sessionId, cols, rows),
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
  windowControls: {
    minimize: () => ipcRenderer.invoke(COMPANION_IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(COMPANION_IPC.windowToggleMaximize),
    close: () => ipcRenderer.invoke(COMPANION_IPC.windowClose)
  }
};

contextBridge.exposeInMainWorld("claudeCompanion", api);
