import { QUESTION_SYSTEM_PROMPT } from "./question-block";

export type ClaudeLaunchMode = "new" | "resume";

export type ClaudeModel = "opus" | "sonnet" | "haiku" | "fable";
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export const CLAUDE_MODELS: readonly ClaudeModel[] = ["opus", "sonnet", "haiku", "fable"];
export const CLAUDE_EFFORTS: readonly ClaudeEffort[] = ["low", "medium", "high", "xhigh", "max"];

export type ClaudeCommandRequest = {
  cwd: string;
  mode?: ClaudeLaunchMode;
  sessionId?: string;
  model?: ClaudeModel;
  effort?: ClaudeEffort;
};

// A per-message `claude --print` run has no PTY, so it carries no terminal
// dimensions — the start request is just the command request.
export type ClaudeSessionStartRequest = ClaudeCommandRequest;

export type ClaudeSessionStarted = {
  sessionId: string;
  cwd: string;
  mode: ClaudeLaunchMode;
};

export type TerminalShell = "powershell" | "cmd";

export type TerminalSessionStartRequest = {
  cwd?: string;
  shell?: TerminalShell;
  cols?: number;
  rows?: number;
};

export type TerminalSessionStarted = {
  sessionId: string;
  cwd: string;
  shell: TerminalShell;
};

/**
 * Which surface the window opens on.
 *
 * `app` drives Claude through `claude --print` and renders the conversation
 * itself. `terminal` runs the interactive CLI inside the embedded PTY and only
 * hosts it — the explorer, the window chrome and the Stream Deck key are the
 * same either way. Terminal is the cheaper surface per turn: one long-lived
 * process keeps the prompt cache warm, where `--print` respawns per message and
 * re-buys the prefix. Measured at turn starts still inside the 5-minute cache
 * TTL, `--print` re-wrote a median 76k-123k tokens against the terminal's 12.5k.
 */
export type CompanionLaunchMode = "app" | "terminal";

/**
 * Markers a PARENT Claude session leaves in the environment for its own
 * children, which must not travel into the session this app hosts.
 *
 * `CLAUDE_CODE_CHILD_SESSION` makes the CLI treat itself as nested and turn
 * transcript saving OFF — it says so on startup: "Transcript saving is off —
 * inherited CLAUDE_CODE_CHILD_SESSION marker". That is not cosmetic here.
 * `--resume` stops finding the session, and terminal mode reads the transcript
 * for the context percentage, so the meter and the key would sit at "--"
 * forever with nothing explaining why.
 *
 * The marker arrives whenever anything in the launch chain was itself started
 * from a Claude session — Stream Deck restarted from one is enough, and it then
 * flows through the plugin, this app, and the PTY into the CLI. Stripping it is
 * right rather than forcing persistence back on: the session this app opens is
 * a real top-level one, so the marker is simply false about it.
 *
 * `CLAUDE_CODE_SKIP_PROMPT_HISTORY` is deliberately NOT stripped. The CLI
 * reports that separately, and a user who set it meant it.
 */
export const INHERITED_SESSION_MARKERS = ["CLAUDE_CODE_CHILD_SESSION"] as const;

/** Remove those markers in place. Returns the names actually dropped. */
export function stripInheritedSessionMarkers(
  env: Record<string, string | undefined>
): string[] {
  const dropped: string[] = [];
  for (const name of INHERITED_SESSION_MARKERS) {
    if (env[name] !== undefined) {
      delete env[name];
      dropped.push(name);
    }
  }
  return dropped;
}

export const COMPANION_LAUNCH_MODES: readonly CompanionLaunchMode[] = ["app", "terminal"];

export type RuntimeProjectMetadata = {
  folder: string;
  projectName: string;
  launchMode?: CompanionLaunchMode;
  model?: string;
  effort?: ClaudeEffort;
  contextPercent?: number;
  /**
   * The folder's most recent conversation — a candidate to OFFER, never one to
   * load on its own. Opening the app used to continue it silently, and because
   * every message respawns the CLI, the inherited prefix was re-billed on each
   * one rather than paid once: measured over five sessions, 53% of all spend
   * was prefix carried in at launch, and one conversation grew across ten
   * launches from 97k to 535k tokens without ever being cleared.
   */
  resumeCandidateId?: string;
  /** That candidate's last recorded context size, so the offer can price it. */
  resumeCandidateTokens?: number;
};

export type DirectoryEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
};

export const COMPANION_IPC = {
  claudeStart: "companion:claude:start",
  claudeWrite: "companion:claude:write",
  claudeConfigure: "companion:claude:configure",
  claudeApply: "companion:claude:apply",
  claudeClear: "companion:claude:clear",
  claudeContextReset: "companion:claude:context-reset",
  claudeInterrupt: "companion:claude:interrupt",
  claudeKill: "companion:claude:kill",
  claudePasteClipboardImage: "companion:claude:paste-clipboard-image",
  claudeData: "companion:claude:data",
  claudeExit: "companion:claude:exit",
  claudeCommands: "companion:claude:commands",
  pathDelete: "companion:path:delete",
  pathFiles: "companion:path:files",
  terminalStart: "companion:terminal:start",
  terminalWrite: "companion:terminal:write",
  terminalResize: "companion:terminal:resize",
  terminalKill: "companion:terminal:kill",
  terminalData: "companion:terminal:data",
  terminalExit: "companion:terminal:exit",
  sessionStatus: "companion:session:status",
  gitBranch: "companion:git:branch",
  cliRun: "companion:cli:run",
  pathList: "companion:path:list",
  pathCreateDirectory: "companion:path:create-directory",
  pathCreateFile: "companion:path:create-file",
  pathRename: "companion:path:rename",
  pathOpen: "companion:path:open",
  pathReveal: "companion:path:reveal",
  pathCopyMeasure: "companion:path:copy-measure",
  pathCopyInto: "companion:path:copy-into",
  pathSearch: "companion:path:search",
  pathSearchCancel: "companion:path:search-cancel",
  terminalOpenFolder: "companion:terminal:open-folder",
  terminalRelogin: "companion:terminal:relogin",
  diag: "companion:diag",
  claudeHistory: "companion:claude:history",
  clipboardWriteText: "companion:clipboard:write-text",
  clipboardReadText: "companion:clipboard:read-text",
  windowMinimize: "companion:window:minimize",
  // (claude resize removed: the per-message --print run has no PTY)
  windowToggleMaximize: "companion:window:toggle-maximize",
  windowClose: "companion:window:close"
} as const;

export type CompanionIpcChannel =
  (typeof COMPANION_IPC)[keyof typeof COMPANION_IPC];

/**
 * The sign-in command handed to the external terminal when a login expires.
 *
 * `claude login` does not exist — authentication lives under the `auth`
 * subcommand. Shared so the sentence the user reads and the command actually run
 * cannot drift apart.
 */
export const CLAUDE_RELOGIN_COMMAND = "claude auth login";

const RUNTIME_ARG_PREFIX = "--claude-companion-runtime=";

function assertPlainValue(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  if (/[\u0000\r\n]/u.test(value)) {
    throw new Error(`${label} contains unsupported characters`);
  }
}

/**
 * A Claude conversation id is a UUID-like token. Restricting it to this
 * allowlist keeps it safe both as a single `--resume` argv and as a filename
 * segment when reading transcripts (defense-in-depth over the separator checks).
 */
export function isSafeClaudeSessionId(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/u.test(value);
}

export function createClaudeCommandArgs(request: ClaudeCommandRequest): string[] {
  assertPlainValue(request.cwd, "cwd");
  const mode = request.mode ?? "new";
  const args = [
    "--dangerously-skip-permissions",
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    // Print mode disables the interactive AskUserQuestion tool, so choice
    // questions arrive as a ```question block the renderer turns into buttons.
    "--append-system-prompt",
    QUESTION_SYSTEM_PROMPT,
    // A backstop, not a throttle. `--dangerously-skip-permissions` removes the
    // human gate on every tool, so one Enter can loop without bound; measured
    // across 138 real messages the loop ran a median of 6 requests, p95 27, and
    // never past 44. 100 leaves that untouched and still ends a runaway.
    "--max-turns",
    "100"
  ];

  if (mode === "resume") {
    if (!request.sessionId) {
      throw new Error("sessionId is required to resume Claude");
    }
    if (!isSafeClaudeSessionId(request.sessionId)) {
      throw new Error("sessionId contains unsupported characters");
    }
    args.push("--resume", request.sessionId);
  }

  // Model and effort are applied per message, so a change takes effect on the
  // next send without restarting a long-lived session.
  if (request.model) {
    if (!CLAUDE_MODELS.includes(request.model)) {
      throw new Error("Unsupported Claude model");
    }
    args.push("--model", request.model);
  }
  if (request.effort) {
    if (!CLAUDE_EFFORTS.includes(request.effort)) {
      throw new Error("Unsupported Claude effort");
    }
    args.push("--effort", request.effort);
  }

  return args;
}

export function encodeRuntimeProjectMetadata(metadata: RuntimeProjectMetadata): string {
  return `${RUNTIME_ARG_PREFIX}${encodeBase64Url(JSON.stringify(metadata))}`;
}

export function readRuntimeProjectMetadataArg(argv: string[]): RuntimeProjectMetadata {
  const arg = argv.find((value) => value.startsWith(RUNTIME_ARG_PREFIX));
  if (!arg) {
    return { folder: "", projectName: "" };
  }
  const parsed = JSON.parse(decodeBase64Url(arg.slice(RUNTIME_ARG_PREFIX.length))) as Partial<RuntimeProjectMetadata>;
  return {
    folder: typeof parsed.folder === "string" ? parsed.folder : "",
    projectName: typeof parsed.projectName === "string" ? parsed.projectName : "",
    model: typeof parsed.model === "string" ? parsed.model : undefined,
    effort: CLAUDE_EFFORTS.includes(parsed.effort as ClaudeEffort) ? parsed.effort : undefined,
    contextPercent:
      typeof parsed.contextPercent === "number" ? parsed.contextPercent : undefined,
    launchMode:
      parsed.launchMode === "terminal" || parsed.launchMode === "app"
        ? parsed.launchMode
        : undefined,
    resumeCandidateId:
      typeof parsed.resumeCandidateId === "string" ? parsed.resumeCandidateId : undefined,
    resumeCandidateTokens:
      typeof parsed.resumeCandidateTokens === "number" &&
      Number.isFinite(parsed.resumeCandidateTokens)
        ? parsed.resumeCandidateTokens
        : undefined
  };
}

/**
 * Keep the metadata codec usable from Electron's sandboxed preload. Sandboxed
 * preloads expose Web APIs such as TextEncoder/atob/btoa, but do not expose
 * Node's Buffer global.
 */
function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64 = typeof btoa === "function"
    ? btoa(binary)
    : Buffer.from(bytes).toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
  const binary = typeof atob === "function"
    ? atob(padded)
    : Buffer.from(padded, "base64").toString("binary");
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
