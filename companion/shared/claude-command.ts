export type ClaudeLaunchMode = "new" | "resume";

export type ClaudeCommandRequest = {
  cwd: string;
  mode?: ClaudeLaunchMode;
  sessionId?: string;
};

export type ClaudeSessionStartRequest = ClaudeCommandRequest & {
  cols?: number;
  rows?: number;
};

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

export type RuntimeProjectMetadata = {
  folder: string;
  projectName: string;
  model?: string;
  contextPercent?: number;
  resumeSessionId?: string;
};

export type DirectoryEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
};

export const COMPANION_IPC = {
  claudeStart: "companion:claude:start",
  claudeWrite: "companion:claude:write",
  claudeResize: "companion:claude:resize",
  claudeKill: "companion:claude:kill",
  claudePasteClipboardImage: "companion:claude:paste-clipboard-image",
  claudeData: "companion:claude:data",
  claudeExit: "companion:claude:exit",
  terminalStart: "companion:terminal:start",
  terminalWrite: "companion:terminal:write",
  terminalResize: "companion:terminal:resize",
  terminalKill: "companion:terminal:kill",
  terminalData: "companion:terminal:data",
  terminalExit: "companion:terminal:exit",
  sessionStatus: "companion:session:status",
  pathList: "companion:path:list",
  pathCreateDirectory: "companion:path:create-directory",
  pathCreateFile: "companion:path:create-file",
  pathOpen: "companion:path:open",
  pathReveal: "companion:path:reveal",
  terminalOpenFolder: "companion:terminal:open-folder",
  windowMinimize: "companion:window:minimize",
  windowToggleMaximize: "companion:window:toggle-maximize",
  windowClose: "companion:window:close"
} as const;

export type CompanionIpcChannel =
  (typeof COMPANION_IPC)[keyof typeof COMPANION_IPC];

const RUNTIME_ARG_PREFIX = "--claude-companion-runtime=";

function assertPlainValue(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  if (/[\u0000\r\n]/u.test(value)) {
    throw new Error(`${label} contains unsupported characters`);
  }
}

export function createClaudeCommandArgs(request: ClaudeCommandRequest): string[] {
  assertPlainValue(request.cwd, "cwd");
  const mode = request.mode ?? "new";
  const args = ["--dangerously-skip-permissions"];

  if (mode === "resume") {
    if (!request.sessionId) {
      throw new Error("sessionId is required to resume Claude");
    }
    assertPlainValue(request.sessionId, "sessionId");
    args.push("--resume", request.sessionId);
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
    contextPercent:
      typeof parsed.contextPercent === "number" ? parsed.contextPercent : undefined,
    resumeSessionId:
      typeof parsed.resumeSessionId === "string" ? parsed.resumeSessionId : undefined
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
