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
  isClaudeAuthError,
  isHookFailureNoise,
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
  /**
   * ms of agent silence that ends a run still holding background agents.
   *
   * ponytail: backstop for an agent that never reports completion, so a held
   * process cannot leak forever. Raise it if long agent runs get cut short.
   */
  agentIdleTimeoutMs?: number;
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
  // Runs kept alive past their own end_turn because background agents are still
  // working inside them. Tracked so ending the conversation still ends them.
  lingeringRuns: Set<ClaudeRun>;
};

export class ClaudePtyManager extends EventEmitter<ClaudePtyEvents> {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly runFactory: ClaudeRunFactory;
  private readonly command: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly finaliseGraceMs: number;
  private readonly agentIdleTimeoutMs: number;
  private readonly onContext?: (info: ClaudeContextInfo) => void;

  constructor(options: ClaudePtyManagerOptions = {}) {
    super();
    this.runFactory = options.runFactory ?? spawnClaudeRun;
    this.command = options.command ?? "claude";
    this.env = options.env ?? process.env;
    this.finaliseGraceMs = options.finaliseGraceMs ?? 1500;
    this.agentIdleTimeoutMs = options.agentIdleTimeoutMs ?? 10 * 60 * 1000;
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
      busy: false,
      lingeringRuns: new Set()
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
    this.killLingeringRuns(session);
    session.busy = false;
    session.claudeSessionId = undefined;
    session.mode = "new";
    // The session is idle again; without this the key's activity record
    // would keep whatever state the killed run left behind.
    this.emit("data", sessionId, [{ kind: "phase", phase: "ready" }]);
  }

  /**
   * Stop the message that is currently generating without ending the
   * conversation. The captured claudeSessionId is kept so the next message
   * resumes from where it left off. Returns true if a run was interrupted.
   */
  interrupt(sessionId: string): boolean {
    const session = this.session(sessionId);
    const run = session.activeRun;
    if (!run) {
      return false;
    }
    // Detach first so the run's onExit/onData see it is no longer active and
    // stay silent instead of surfacing an ended-without-response error.
    session.activeRun = undefined;
    session.busy = false;
    run.kill();
    diag("main.run.interrupt", { sessionId });
    // The killed run can never report end_turn, so hand the waiting state
    // back explicitly — otherwise the Stream Deck key's activity record
    // stays "running" forever after an Esc interrupt.
    this.emit("data", sessionId, [{ kind: "phase", phase: "ready" }]);
    return true;
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
      env: {
        ...this.env,
        TERM: this.env.TERM ?? "xterm-256color",
        // The Companion writes the key's runtime activity itself; this tells
        // the statusline bridge to yield that file (a --print payload has no
        // activity signal and used to clobber it with "idle").
        CLAUDE_DECK_RUNTIME_OWNER: "companion"
      }
    });
    session.activeRun = run;
    session.busy = true;

    const parser = new ClaudeStreamParser();
    let finaliseTimer: NodeJS.Timeout | undefined;
    let agentIdleTimer: NodeJS.Timeout | undefined;
    let sawEndTurn = false;
    // An expired login ends the run with exit 1 and no end_turn. That is not a
    // broken session, so it must not also raise the generic exit error.
    let sawLogin = false;
    // Unfinished agents launched by this run. Background agents keep working
    // inside the process after the reply ends, so end_turn alone must not tear
    // it down — that killed every parallel agent the moment Claude replied.
    // Synchronous agents always finish before end_turn, so whatever is still
    // here at that point is asynchronous by construction.
    const liveAgents = new Set<string>();

    const emit = (events: ClaudeEvent[]): void => {
      if (events.length > 0) {
        this.emit("data", sessionId, events);
      }
    };

    const clearTimers = (): void => {
      if (finaliseTimer) {
        clearTimeout(finaliseTimer);
        finaliseTimer = undefined;
      }
      if (agentIdleTimer) {
        clearTimeout(agentIdleTimer);
        agentIdleTimer = undefined;
      }
    };

    const trackAgents = (events: readonly ClaudeEvent[]): void => {
      for (const event of events) {
        if (event.kind !== "agent") {
          continue;
        }
        if (event.op === "start") {
          liveAgents.add(event.toolUseId);
        } else if (event.op === "end") {
          liveAgents.delete(event.toolUseId);
        }
      }
    };

    /**
     * Tear the run down once the reply AND every background agent are finished.
     * While agents are still live the process is held, with an idle cap so a
     * silent agent cannot strand it forever.
     */
    const maybeFinalise = (): void => {
      if (!sawEndTurn) {
        return;
      }
      clearTimers();
      if (liveAgents.size === 0) {
        session.lingeringRuns.delete(run);
        finaliseTimer = setTimeout(() => run.kill(), this.finaliseGraceMs);
        return;
      }
      session.lingeringRuns.add(run);
      agentIdleTimer = setTimeout(() => run.kill(), this.agentIdleTimeoutMs);
    };

    run.onData((chunk) => {
      const events = parser.push(chunk);
      // Once the next message's run takes over, this run lives on only for the
      // background agents still working inside it. Their progress must keep
      // reaching the board, but its text, phases, session id and context would
      // bleed into the new turn, so only agent events survive.
      if (session.activeRun !== run) {
        const agentEvents = events.filter((event) => event.kind === "agent");
        trackAgents(agentEvents);
        emit(agentEvents);
        maybeFinalise();
        return;
      }
      if (events.some((event) => event.kind === "login")) {
        sawLogin = true;
      }
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
      trackAgents(events);
      if (!sawEndTurn && events.some((e) => e.kind === "phase" && e.phase === "waiting")) {
        sawEndTurn = true;
        // The reply is delivered, so free the session for the next message now.
        // The process is torn down in the background; it must not block input,
        // and we never wait for Claude's ~120s async finalise.
        session.busy = false;
      }
      // Every chunk re-evaluates teardown: the reply may have ended, or the last
      // background agent may have just finished, or an agent event may have
      // arrived that pushes the idle cap out.
      maybeFinalise();
    });

    run.onError((message) => {
      if (session.activeRun !== run) {
        return;
      }
      const trimmed = message.trim();
      diag("main.run.stderr", { sessionId, length: trimmed.length, hookNoise: isHookFailureNoise(trimmed) });
      if (trimmed.length === 0 || isHookFailureNoise(trimmed)) {
        return;
      }
      if (isClaudeAuthError(trimmed)) {
        sawLogin = true;
        emit([{ kind: "login", message: trimmed }]);
        return;
      }
      emit([{
        kind: "error",
        message: trimmed,
        missingConversation: isMissingClaudeConversationError(trimmed)
      }]);
    });

    run.onExit(({ exitCode }) => {
      clearTimers();
      session.lingeringRuns.delete(run);
      diag("main.run.exit", { sessionId, exitCode, sawEndTurn, liveAgents: liveAgents.size });
      // The process is gone, so any agent still open died with it. Closing those
      // rows here — rather than when the reply ended — is what lets background
      // agents keep running and reporting after end_turn.
      const abandonedAgents = [...liveAgents].map((toolUseId) => ({
        kind: "agent" as const,
        op: "end" as const,
        toolUseId,
        ok: false
      }));
      liveAgents.clear();
      // A later message already started its own run, or clear()/kill() replaced
      // this one; a superseded run must not touch shared state or surface an
      // error (e.g. after the user pressed Clear).
      if (session.activeRun !== run) {
        emit(abandonedAgents);
        return;
      }
      emit([...parser.flush(), ...abandonedAgents]);
      session.activeRun = undefined;
      if (!sawEndTurn) {
        session.busy = false;
        // Ended before delivering a reply (e.g. resume of a deleted transcript);
        // surface it so the renderer can start a fresh conversation. An expired
        // login already explained itself and is being handled as a re-login.
        if (exitCode !== 0 && !sawLogin) {
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
    this.killLingeringRuns(session);
    this.sessions.delete(sessionId);
    this.emit("exit", sessionId, 0);
  }

  /**
   * End the runs held open for background agents. Closing the conversation ends
   * their work too, and without this they would outlive the session as orphans.
   */
  private killLingeringRuns(session: StoredSession): void {
    for (const run of session.lingeringRuns) {
      run.kill();
    }
    session.lingeringRuns.clear();
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
