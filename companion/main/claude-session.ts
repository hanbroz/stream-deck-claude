import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import {
  createClaudeCommandArgs,
  type ClaudeEffort,
  type ClaudeLaunchMode,
  type ClaudeModel,
  type ClaudeSessionStartRequest,
  type ClaudeSessionStarted
} from "../shared/claude-command";
import {
  ClaudeStreamParser,
  encodeClaudeUserMessage,
  isMissingClaudeConversationError,
  type ClaudeEvent
} from "../shared/claude-stream";
import { diag } from "../shared/diag";

export type ClipboardImageReader = {
  readImage(): {
    isEmpty(): boolean;
    toDataURL?(): string;
  };
};

/**
 * A single short-lived `claude --print` run for one user message.
 *
 * The Companion used to keep one long-lived stream-json process per session,
 * but Claude does not finalise a turn until roughly two minutes after the reply
 * streams, which stalled every message after the first. Spawning one process
 * per message and resuming the captured session id keeps each turn near the
 * ~7s model latency, and the slow finalise happens after the process is gone.
 */
export type ClaudeRun = {
  onData(listener: (data: string) => void): void;
  onError(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
  writeStdin(data: string): void;
  endStdin(): void;
  kill(): void;
};

export type ClaudeRunSpec = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type ClaudeRunFactory = (spec: ClaudeRunSpec) => ClaudeRun;

function spawnClaudeRun(spec: ClaudeRunSpec): ClaudeRun {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdin.on("error", () => {
    // A killed run can reject the trailing stdin write; the run is already done.
  });

  return {
    onData(listener) {
      child.stdout.on("data", (data: Buffer | string) => listener(data.toString()));
    },
    onError(listener) {
      child.stderr.on("data", (data: Buffer | string) => listener(data.toString()));
      child.on("error", (error) => listener(error.message));
    },
    onExit(listener) {
      child.on("close", (exitCode) => listener({ exitCode: exitCode ?? 0 }));
    },
    writeStdin(data) {
      child.stdin.write(data);
    },
    endStdin() {
      child.stdin.end();
    },
    kill() {
      // `claude --print` re-runs SessionStart hooks and MCP servers as child
      // processes. child.kill() ends only the top PID, orphaning that subtree
      // for the duration of the ~120-180s async hook. Kill the whole tree.
      if (process.platform === "win32" && typeof child.pid === "number") {
        try {
          spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore"
          }).on("error", () => child.kill());
          return;
        } catch {
          // Fall through to the single-process kill below.
        }
      }
      child.kill();
    }
  };
}

export type ClaudeContextInfo = {
  claudeSessionId: string;
  usedTokens: number;
  windowTokens: number;
  model?: string;
};

export type ClaudePtyManagerOptions = {
  runFactory?: ClaudeRunFactory;
  command?: string;
  env?: NodeJS.ProcessEnv;
  /** ms to wait after end_turn before killing, letting the transcript flush. */
  finaliseGraceMs?: number;
  /** Notified with live context usage so the Stream Deck key can be updated. */
  onContext?: (info: ClaudeContextInfo) => void;
};

export type ClaudePtyEvents = {
  data: [sessionId: string, events: ClaudeEvent[]];
  exit: [sessionId: string, exitCode: number, signal?: number];
};

type StoredSession = {
  cwd: string;
  mode: ClaudeLaunchMode;
  model?: ClaudeModel;
  effort?: ClaudeEffort;
  // The Claude conversation id to resume on the next message. Seeded from Code
  // Start's resume target, then refreshed from each run's stream so the newest
  // transcript is always continued.
  claudeSessionId?: string;
  busy: boolean;
  activeRun?: ClaudeRun;
};

export class ClaudePtyManager extends EventEmitter<ClaudePtyEvents> {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly runFactory: ClaudeRunFactory;
  private readonly command: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly finaliseGraceMs: number;
  private readonly onContext?: (info: ClaudeContextInfo) => void;

  constructor(options: ClaudePtyManagerOptions = {}) {
    super();
    this.runFactory = options.runFactory ?? spawnClaudeRun;
    this.command = options.command ?? "claude";
    this.env = options.env ?? process.env;
    this.finaliseGraceMs = options.finaliseGraceMs ?? 1500;
    this.onContext = options.onContext;
  }

  /**
   * Register a conversation. No process is spawned yet — the first message does
   * that. `mode: "resume"` seeds the conversation to continue from `sessionId`.
   */
  start(request: ClaudeSessionStartRequest): ClaudeSessionStarted {
    const mode = request.mode ?? "new";
    const sessionId = randomUUID();
    this.sessions.set(sessionId, {
      cwd: request.cwd,
      mode,
      model: request.model,
      effort: request.effort,
      claudeSessionId: mode === "resume" ? request.sessionId : undefined,
      busy: false
    });
    return { sessionId, cwd: request.cwd, mode };
  }

  /** Change the model/effort applied to subsequent messages. */
  configure(sessionId: string, options: { model?: ClaudeModel; effort?: ClaudeEffort }): void {
    const session = this.session(sessionId);
    if (options.model !== undefined) {
      session.model = options.model;
    }
    if (options.effort !== undefined) {
      session.effort = options.effort;
    }
  }

  /** Forget the conversation so the next message starts a fresh Claude session. */
  clear(sessionId: string): void {
    const session = this.session(sessionId);
    session.activeRun?.kill();
    session.activeRun = undefined;
    session.busy = false;
    session.claudeSessionId = undefined;
    session.mode = "new";
  }

  write(sessionId: string, data: string, imageDataUrls: readonly string[] = []): void {
    const session = this.session(sessionId);
    if (session.busy) {
      throw new Error("이전 응답을 기다리는 중입니다");
    }

    const resumeId = session.claudeSessionId;
    const args = createClaudeCommandArgs({
      cwd: session.cwd,
      mode: resumeId ? "resume" : "new",
      sessionId: resumeId,
      model: session.model,
      effort: session.effort
    });
    diag("main.run.spawn", {
      sessionId,
      resume: resumeId !== undefined,
      model: session.model,
      effort: session.effort,
      textLength: data.length,
      imageCount: imageDataUrls.length
    });

    const run = this.runFactory({
      command: this.command,
      args,
      cwd: session.cwd,
      env: { ...this.env, TERM: this.env.TERM ?? "xterm-256color" }
    });
    session.activeRun = run;
    session.busy = true;

    const parser = new ClaudeStreamParser();
    let finaliseTimer: NodeJS.Timeout | undefined;
    let sawEndTurn = false;

    const emit = (events: ClaudeEvent[]): void => {
      if (events.length > 0) {
        this.emit("data", sessionId, events);
      }
    };

    run.onData((chunk) => {
      // Once the next message's run takes over, this run lives on only to be
      // torn down. Drop its late output so a trailing chunk, session id, or
      // context event never bleeds into the new turn.
      if (session.activeRun !== run) {
        return;
      }
      const events = parser.push(chunk);
      // The freshest conversation id is what the next message resumes.
      const next = parser.takeSessionId();
      if (next) {
        session.claudeSessionId = next;
      }
      emit(events);
      if (this.onContext) {
        for (const event of events) {
          if (event.kind === "context") {
            this.onContext({
              claudeSessionId: session.claudeSessionId ?? "",
              usedTokens: event.usedTokens,
              windowTokens: event.windowTokens,
              model: event.model
            });
          }
        }
      }
      if (!sawEndTurn && events.some((e) => e.kind === "phase" && e.phase === "waiting")) {
        sawEndTurn = true;
        // The reply is delivered, so free the session for the next message now.
        // The process is torn down in the background; it must not block input,
        // and we never wait for Claude's ~120s async finalise.
        session.busy = false;
        finaliseTimer = setTimeout(() => run.kill(), this.finaliseGraceMs);
      }
    });

    run.onError((message) => {
      if (session.activeRun !== run) {
        return;
      }
      const trimmed = message.trim();
      diag("main.run.stderr", { sessionId, length: trimmed.length });
      if (trimmed.length > 0) {
        emit([{
          kind: "error",
          message: trimmed,
          missingConversation: isMissingClaudeConversationError(trimmed)
        }]);
      }
    });

    run.onExit(({ exitCode }) => {
      if (finaliseTimer) {
        clearTimeout(finaliseTimer);
      }
      diag("main.run.exit", { sessionId, exitCode, sawEndTurn });
      // A later message already started its own run, or clear()/kill() replaced
      // this one; a superseded run must not touch shared state or surface an
      // error (e.g. after the user pressed Clear).
      if (session.activeRun !== run) {
        return;
      }
      emit(parser.flush());
      session.activeRun = undefined;
      if (!sawEndTurn) {
        session.busy = false;
        // Ended before delivering a reply (e.g. resume of a deleted transcript);
        // surface it so the renderer can start a fresh conversation.
        if (exitCode !== 0) {
          emit([{
            kind: "error",
            message: "Claude 세션이 응답 없이 종료되었습니다",
            missingConversation: false
          }]);
        }
      }
    });

    run.writeStdin(encodeClaudeUserMessage(data, imageDataUrls));
    run.endStdin();
  }

  kill(sessionId: string): void {
    const session = this.session(sessionId);
    const run = session.activeRun;
    // Detach first so the run's onExit sees it is no longer active and stays
    // silent instead of surfacing an "ended without response" error.
    session.activeRun = undefined;
    session.busy = false;
    run?.kill();
    this.sessions.delete(sessionId);
    this.emit("exit", sessionId, 0);
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
      throw new Error("Claude session was not found");
    }
    return session;
  }
}
