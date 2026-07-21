import { contextBridge, ipcRenderer } from "electron";

import {
  COMPANION_IPC,
  type ClaudeSessionStartRequest,
  type ClaudeSessionStarted,
  type DirectoryEntry
} from "../shared/claude-command";

export type ClaudeCompanionApi = {
  runtime: {
    folder: string;
    resumeSessionId?: string;
  };
  claude: {
    start(request: ClaudeSessionStartRequest): Promise<ClaudeSessionStarted>;
    write(sessionId: string, data: string): void;
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
    openFolder(path: string): Promise<void>;
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

const api: ClaudeCompanionApi = {
  runtime: {
    folder: process.env.CLAUDE_STREAM_DECK_FOLDER ?? "",
    resumeSessionId:
      process.env.CLAUDE_STREAM_DECK_RESUME_SESSION_ID ??
      process.env.CLAUDE_STREAM_DECK_RESUME
  },
  claude: {
    start: (request) => ipcRenderer.invoke(COMPANION_IPC.claudeStart, request),
    write: (sessionId, data) =>
      ipcRenderer.send(COMPANION_IPC.claudeWrite, sessionId, data),
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
    openFolder: (path) => ipcRenderer.invoke(COMPANION_IPC.terminalOpenFolder, path)
  },
  windowControls: {
    minimize: () => ipcRenderer.invoke(COMPANION_IPC.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(COMPANION_IPC.windowToggleMaximize),
    close: () => ipcRenderer.invoke(COMPANION_IPC.windowClose)
  }
};

contextBridge.exposeInMainWorld("claudeCompanion", api);
