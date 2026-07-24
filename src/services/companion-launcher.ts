import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  launchClaudeTerminal,
  validateLaunchFolder,
  type TerminalLaunchResult
} from "./terminal-launcher";

export type CompanionLaunchResult = TerminalLaunchResult | {
  terminal: "companion";
  processId: number;
};

export type CompanionLaunchPlan = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type CompanionLookupOptions = {
  env?: NodeJS.ProcessEnv;
  localAppData?: string;
  pluginRoot?: string;
};

const COMPANION_EXE_NAME = "Claude Deck Companion.exe";
const TERMINAL_FALLBACK_FLAG = "CLAUDE_DECK_ALLOW_TERMINAL_FALLBACK";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function companionCandidates(options: CompanionLookupOptions = {}): string[] {
  const env = options.env ?? process.env;
  const localAppData = options.localAppData ?? env.LOCALAPPDATA;
  const pluginRoot = options.pluginRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  return [
    env.CLAUDE_DECK_COMPANION_PATH,
    path.join(pluginRoot, "companion", "win-unpacked", COMPANION_EXE_NAME),
    path.join(pluginRoot, "..", "dist", "companion", "win-unpacked", COMPANION_EXE_NAME),
    localAppData
      ? path.join(localAppData, "Programs", "Claude Deck Companion", COMPANION_EXE_NAME)
      : undefined
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
}

export async function resolveCompanionExecutable(
  options: CompanionLookupOptions = {}
): Promise<string> {
  for (const candidate of companionCandidates(options)) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    "Claude Deck Companion executable was not found. Set CLAUDE_DECK_ALLOW_TERMINAL_FALLBACK=1 to use the development terminal fallback."
  );
}

export async function resolveClaudePath(): Promise<string> {
  const defaultPath = path.join(os.homedir(), ".local", "bin", "claude.exe");
  if (await fileExists(defaultPath)) {
    return defaultPath;
  }

  const fromPath = await new Promise<string | undefined>((resolve) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Out.Write((Get-Command claude.exe -ErrorAction Stop).Source)"
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
    );
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.once("error", () => resolve(undefined));
    child.once("close", (code) => {
      const commandPath = Buffer.concat(output).toString("utf8").trim();
      resolve(code === 0 && commandPath.length > 0 ? commandPath : undefined);
    });
  });
  if (fromPath) {
    return fromPath;
  }
  throw new Error("Claude Code executable was not found");
}

export function createCompanionLaunchPlan(
  companionPath: string,
  folder: string,
  bindingId: string,
  launchId: string,
  claudePath: string,
  resumeSessionId?: string,
  projectName?: string
): CompanionLaunchPlan {
  const inheritedEnv = { ...process.env };
  // Stream Deck and other Electron hosts may set this flag for their own
  // Node runtime. Passing it to the Companion makes Electron start as Node,
  // which leaves `app`/`BrowserWindow` unavailable and produces a blank shell.
  delete inheritedEnv.ELECTRON_RUN_AS_NODE;
  delete inheritedEnv.ELECTRON_NO_ATTACH_CONSOLE;
  return {
    command: companionPath,
    // The packaged Electron runtime rejects unknown top-level CLI flags. The
    // Companion receives its project root and Claude path through the inherited
    // environment below, which is also how resume state is transported.
    args: [],
    cwd: folder,
    env: {
      ...inheritedEnv,
      CLAUDE_STREAM_DECK_BINDING_ID: bindingId,
      // Retained while older installed bridges still read the legacy variable name.
      CLAUDE_STREAM_DECK_ACTION_ID: bindingId,
      CLAUDE_STREAM_DECK_LAUNCH_ID: launchId,
      CLAUDE_STREAM_DECK_FOLDER: folder,
      CLAUDE_STREAM_DECK_CLAUDE_PATH: claudePath,
      ...(projectName ? { CLAUDE_STREAM_DECK_PROJECT_NAME: projectName } : {}),
      ...(resumeSessionId ? { CLAUDE_STREAM_DECK_RESUME_SESSION_ID: resumeSessionId } : {})
    }
  };
}

/**
 * Bring an already-running Companion window to the foreground. A plain
 * SetForegroundWindow from the (background) plugin process is silently
 * swallowed by Windows' foreground lock, so this uses the proven combo:
 * minimise→restore raises the window past the lock, and an Alt key pulse
 * unlocks SetForegroundWindow for good measure.
 */
export async function focusCompanionWindow(processId: number): Promise<boolean> {
  if (!Number.isInteger(processId) || processId <= 0) {
    return false;
  }
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$p = Get-Process -Id ${processId}`,
    "$h = $p.MainWindowHandle",
    "if ($h -eq [IntPtr]::Zero) { exit 1 }",
    "Add-Type -Namespace ClaudeDeck -Name Win32 -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);'",
    "[ClaudeDeck.Win32]::ShowWindowAsync($h, 6) | Out-Null",
    "Start-Sleep -Milliseconds 150",
    "[ClaudeDeck.Win32]::ShowWindowAsync($h, 9) | Out-Null",
    "[ClaudeDeck.Win32]::keybd_event(0xA4, 0, 0, [UIntPtr]::Zero)",
    "[ClaudeDeck.Win32]::keybd_event(0xA4, 0, 2, [UIntPtr]::Zero)",
    "[ClaudeDeck.Win32]::SetForegroundWindow($h) | Out-Null",
    `(New-Object -ComObject WScript.Shell).AppActivate(${processId}) | Out-Null`
  ].join("; ");
  return await new Promise<boolean>((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, stdio: "ignore" }
    );
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

export async function launchClaudeCompanion(
  folder: string,
  bindingId: string,
  launchId: string,
  resumeSessionId?: string,
  projectName?: string
): Promise<CompanionLaunchResult> {
  await validateLaunchFolder(folder);
  let companionPath: string;
  try {
    companionPath = await resolveCompanionExecutable();
  } catch (error) {
    if (process.env[TERMINAL_FALLBACK_FLAG] === "1") {
      return await launchClaudeTerminal(folder, bindingId, launchId);
    }
    throw error;
  }
  const claudePath = await resolveClaudePath();
  const plan = createCompanionLaunchPlan(
    companionPath,
    folder,
    bindingId,
    launchId,
    claudePath,
    resumeSessionId,
    projectName
  );
  const companion = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    windowsHide: false,
    detached: false,
    stdio: "ignore"
  });
  companion.once("spawn", () => companion.unref());
  await new Promise<void>((resolve, reject) => {
    companion.once("error", reject);
    companion.once("spawn", resolve);
  });
  if (!companion.pid || companion.pid <= 0) {
    throw new Error("Claude Deck Companion did not report a process ID");
  }
  return { terminal: "companion", processId: companion.pid };
}
