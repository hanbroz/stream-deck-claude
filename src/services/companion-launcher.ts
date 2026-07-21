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

async function resolveClaudePath(): Promise<string> {
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
  resumeSessionId?: string
): CompanionLaunchPlan {
  return {
    command: companionPath,
    // The packaged Electron runtime rejects unknown top-level CLI flags. The
    // Companion receives its project root and Claude path through the inherited
    // environment below, which is also how resume state is transported.
    args: [],
    cwd: folder,
    env: {
      ...process.env,
      CLAUDE_STREAM_DECK_BINDING_ID: bindingId,
      // Retained while older installed bridges still read the legacy variable name.
      CLAUDE_STREAM_DECK_ACTION_ID: bindingId,
      CLAUDE_STREAM_DECK_LAUNCH_ID: launchId,
      CLAUDE_STREAM_DECK_FOLDER: folder,
      CLAUDE_STREAM_DECK_CLAUDE_PATH: claudePath,
      ...(resumeSessionId ? { CLAUDE_STREAM_DECK_RESUME_SESSION_ID: resumeSessionId } : {})
    }
  };
}

export async function launchClaudeCompanion(
  folder: string,
  bindingId: string,
  launchId: string,
  resumeSessionId?: string
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
    resumeSessionId
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
