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
