import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import * as pty from "node-pty";

import {
  createClaudeCommandArgs,
  type ClaudeLaunchMode,
  type ClaudeSessionStartRequest,
  type ClaudeSessionStarted
} from "../shared/claude-command";
import { ClaudeStreamParser, encodeClaudeUserMessage } from "../shared/claude-stream";

export type ClipboardImageReader = {
  readImage(): {
    isEmpty(): boolean;
    toDataURL?(): string;
  };
};

export type PtyFactory = (
  file: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    cols: number;
    rows: number;
  }
) => PtyLike;

export type PtyLike = {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
};

export type ClaudePtyManagerOptions = {
  ptyFactory?: PtyFactory;
  command?: string;
  env?: NodeJS.ProcessEnv;
};

export type ClaudePtyEvents = {
  data: [sessionId: string, data: string];
  exit: [sessionId: string, exitCode: number, signal?: number];
};

type StoredSession = {
  cwd: string;
  mode: ClaudeLaunchMode;
  terminal: PtyLike;
  output: ClaudeStreamParser;
};

export class ClaudePtyManager extends EventEmitter<ClaudePtyEvents> {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly ptyFactory: PtyFactory;
  private readonly command: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: ClaudePtyManagerOptions = {}) {
    super();
    this.ptyFactory = options.ptyFactory ?? pty.spawn;
    this.command = options.command ?? "claude";
    this.env = options.env ?? process.env;
  }

  start(request: ClaudeSessionStartRequest): ClaudeSessionStarted {
    const mode = request.mode ?? "new";
    const args = createClaudeCommandArgs(request);
    const sessionId = randomUUID();
    const terminal = this.ptyFactory(this.command, args, {
      cwd: request.cwd,
      env: { ...this.env, TERM: this.env.TERM ?? "xterm-256color" },
      cols: request.cols ?? 120,
      rows: request.rows ?? 30
    });

    const output = new ClaudeStreamParser();
    terminal.onData((data) => {
      const conversation = output.push(data);
      if (conversation.length > 0) {
        this.emit("data", sessionId, conversation);
      }
    });
    terminal.onExit(({ exitCode, signal }) => {
      const conversation = output.flush();
      if (conversation.length > 0) {
        this.emit("data", sessionId, conversation);
      }
      this.sessions.delete(sessionId);
      this.emit("exit", sessionId, exitCode, signal);
    });

    this.sessions.set(sessionId, { cwd: request.cwd, mode, terminal, output });
    return { sessionId, cwd: request.cwd, mode };
  }

  write(sessionId: string, data: string, imageDataUrls: readonly string[] = []): void {
    this.session(sessionId).terminal.write(encodeClaudeUserMessage(data, imageDataUrls));
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.session(sessionId).terminal.resize(cols, rows);
  }

  kill(sessionId: string): void {
    const session = this.session(sessionId);
    session.terminal.kill();
    this.sessions.delete(sessionId);
  }

  pasteClipboardImage(sessionId: string, clipboard: ClipboardImageReader): boolean {
    const image = clipboard.readImage();
    const dataUrl = image.isEmpty() ? undefined : image.toDataURL?.();
    if (!dataUrl) {
      return false;
    }
    this.write(sessionId, "", [dataUrl]);
    return true;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  private session(sessionId: string): StoredSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Claude PTY session was not found");
    }
    return session;
  }
}
