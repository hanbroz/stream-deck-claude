import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CLAUDE_COMMAND =
  "$PID | Set-Content -LiteralPath $env:CLAUDE_STREAM_DECK_PID_FILE -NoNewline; & $env:CLAUDE_STREAM_DECK_CLAUDE_PATH --dangerously-skip-permissions";
// Windows Terminal treats semicolons as separators between its own commands.
const ENCODED_CLAUDE_COMMAND = Buffer.from(CLAUDE_COMMAND, "utf16le").toString(
  "base64"
);
const VISIBLE_POWERSHELL_COMMAND =
  `start "Claude Code" powershell.exe -NoExit -Command "${CLAUDE_COMMAND}"`;

export type TerminalLaunchPlan = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type TerminalLaunchResult = {
  terminal: "windows-terminal" | "powershell";
  processId: number;
};

function launchPidPath(launchId: string): string {
  const key = createHash("sha256").update(launchId, "utf8").digest("hex");
  return path.join(os.tmpdir(), "ClaudeUsageDeck", `${key}.pid`);
}

export function createTerminalLaunchPlan(
  folder: string,
  bindingId: string,
  launchId: string,
  windowsTerminalAvailable: boolean,
  claudePath = "claude.exe"
): TerminalLaunchPlan {
  const powershellArgs = ["-NoExit", "-EncodedCommand", ENCODED_CLAUDE_COMMAND];
  const pidFile = launchPidPath(launchId);
  return {
    command: windowsTerminalAvailable ? "wt.exe" : "cmd.exe",
    args: windowsTerminalAvailable
      ? ["-d", folder, "powershell.exe", ...powershellArgs]
      : ["/d", "/s", "/c", VISIBLE_POWERSHELL_COMMAND],
    cwd: folder,
    env: {
      ...process.env,
      CLAUDE_STREAM_DECK_BINDING_ID: bindingId,
      // Retained while older installed bridges still read the legacy variable name.
      CLAUDE_STREAM_DECK_ACTION_ID: bindingId,
      CLAUDE_STREAM_DECK_LAUNCH_ID: launchId,
      CLAUDE_STREAM_DECK_FOLDER: folder,
      CLAUDE_STREAM_DECK_CLAUDE_PATH: claudePath,
      CLAUDE_STREAM_DECK_PID_FILE: pidFile
    }
  };
}

async function waitForPowerShellPid(pidFile: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const processId = Number.parseInt((await readFile(pidFile, "utf8")).trim(), 10);
      if (Number.isInteger(processId) && processId > 0) {
        process.kill(processId, 0);
        return processId;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ESRCH") {
        throw error;
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Visible PowerShell did not report a running process ID");
}

async function commandExists(command: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn("where.exe", [command], {
      windowsHide: true,
      stdio: "ignore"
    });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

async function resolveClaudePath(): Promise<string> {
  const defaultPath = path.join(os.homedir(), ".local", "bin", "claude.exe");
  try {
    await access(defaultPath);
    return defaultPath;
  } catch {
    // Continue with PATH discovery for non-default Claude installations.
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

export async function validateLaunchFolder(folder: string): Promise<void> {
  const info = await stat(folder);
  if (!info.isDirectory()) {
    throw new Error("Configured Code Start path is not a directory");
  }
}

export async function launchClaudeTerminal(
  folder: string,
  bindingId: string,
  launchId: string
): Promise<TerminalLaunchResult> {
  await validateLaunchFolder(folder);
  const hasWindowsTerminal = await commandExists("wt.exe");
  const claudePath = await resolveClaudePath();
  const plan = createTerminalLaunchPlan(
    folder,
    bindingId,
    launchId,
    hasWindowsTerminal,
    claudePath
  );

  const pidFile = plan.env.CLAUDE_STREAM_DECK_PID_FILE;
  if (!pidFile) {
    throw new Error("Code Start PID file was not configured");
  }
  await mkdir(path.dirname(pidFile), { recursive: true });
  await rm(pidFile, { force: true });

  if (hasWindowsTerminal) {
    const launcher = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      detached: true,
      windowsHide: false,
      stdio: "ignore"
    });
    const launcherFailure = new Promise<never>((_, reject) => {
      launcher.once("error", reject);
      launcher.once("spawn", () => launcher.unref());
      launcher.once("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Windows Terminal launcher failed (${code ?? "unknown"})`));
        }
      });
    });
    try {
      const processId = await Promise.race([waitForPowerShellPid(pidFile), launcherFailure]);
      return { terminal: "windows-terminal", processId };
    } finally {
      await rm(pidFile, { force: true });
    }
  }

  const launcher = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    windowsHide: true,
    windowsVerbatimArguments: true,
    stdio: "ignore"
  });
  const launcherFailure = new Promise<never>((_, reject) => {
    launcher.once("error", reject);
    launcher.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Visible PowerShell launcher failed (${code ?? "unknown"})`));
      }
    });
  });
  try {
    const processId = await Promise.race([waitForPowerShellPid(pidFile), launcherFailure]);
    return { terminal: "powershell", processId };
  } finally {
    if (launcher.exitCode === null && !launcher.killed) {
      launcher.kill();
    }
    await rm(pidFile, { force: true });
  }
}
