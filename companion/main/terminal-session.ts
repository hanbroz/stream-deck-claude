import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import * as pty from "node-pty";

import type {
  TerminalSessionStarted,
  TerminalSessionStartRequest,
  TerminalShell
} from "../shared/claude-command";
import type { PtyFactory, PtyLike } from "./pty-types";

export type ProjectTerminalEvents = {
  data: [sessionId: string, data: string];
  exit: [sessionId: string, exitCode: number, signal?: number];
};

type StoredTerminal = {
  cwd: string;
  shell: TerminalShell;
  terminal: PtyLike;
};

export type ProjectTerminalManagerOptions = {
  ptyFactory?: PtyFactory;
  env?: NodeJS.ProcessEnv;
};

/**
 * Replace PowerShell's default full-path prompt with one relative to the
 * project root, e.g. `> ` at the root and `\raw> ` inside a subfolder. The root
 * arrives as an environment variable so its Korean/space/backslash characters
 * never have to survive command-line quoting.
 */
export const POWERSHELL_PROMPT_SCRIPT =
  "$global:CompanionRoot=$env:CLAUDE_TERMINAL_ROOT; " +
  "function prompt { $r=$global:CompanionRoot; $p=(Get-Location).Path; " +
  "if($r -and $p.ToLower().StartsWith($r.ToLower())){ $rel=$p.Substring($r.Length); " +
  "if([string]::IsNullOrEmpty($rel)){'> '}else{ $rel+'> ' } } else { $p+'> ' } }";

function commandForShell(
  shell: TerminalShell,
  hasPromptRoot: boolean
): { file: string; args: string[] } {
  if (shell === "cmd") {
    return { file: "cmd.exe", args: [] };
  }
  // -NoExit keeps the shell interactive after the prompt override runs.
  const args = hasPromptRoot
    ? ["-NoLogo", "-NoExit", "-Command", POWERSHELL_PROMPT_SCRIPT]
    : ["-NoLogo"];
  return { file: "powershell.exe", args };
}

export class ProjectTerminalManager extends EventEmitter<ProjectTerminalEvents> {
  private readonly sessions = new Map<string, StoredTerminal>();
  private readonly ptyFactory: PtyFactory;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: ProjectTerminalManagerOptions = {}) {
    super();
    this.ptyFactory = options.ptyFactory ?? pty.spawn;
    this.env = options.env ?? process.env;
  }

  start(
    request: TerminalSessionStartRequest & { cwd: string; promptRoot?: string }
  ): TerminalSessionStarted {
    const shell = request.shell ?? "powershell";
    const promptRoot = request.promptRoot;
    const command = commandForShell(shell, promptRoot !== undefined);
    const sessionId = randomUUID();
    const terminal = this.ptyFactory(command.file, command.args, {
      cwd: request.cwd,
      env: {
        ...this.env,
        TERM: this.env.TERM ?? "xterm-256color",
        ...(promptRoot !== undefined ? { CLAUDE_TERMINAL_ROOT: promptRoot } : {})
      },
      cols: request.cols ?? 120,
      rows: request.rows ?? 30
    });

    terminal.onData((data) => this.emit("data", sessionId, data));
    terminal.onExit(({ exitCode, signal }) => {
      this.sessions.delete(sessionId);
      this.emit("exit", sessionId, exitCode, signal);
    });

    this.sessions.set(sessionId, { cwd: request.cwd, shell, terminal });
    return { sessionId, cwd: request.cwd, shell };
  }

  write(sessionId: string, data: string): void {
    this.session(sessionId).terminal.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.session(sessionId).terminal.resize(cols, rows);
  }

  kill(sessionId: string): void {
    const session = this.session(sessionId);
    session.terminal.kill();
    this.sessions.delete(sessionId);
  }

  private session(sessionId: string): StoredTerminal {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Project terminal PTY session was not found");
    }
    return session;
  }
}
