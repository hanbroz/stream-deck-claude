import { execFile, type ExecFileException } from "node:child_process";

import { isBridgedCliCommand, splitArguments } from "../shared/slash-commands";

/**
 * Why a run did not produce a trustworthy result. Absent when the CLI itself
 * answered — a non-zero exit with real output is the CLI's own verdict, not a
 * failure of ours. The distinction matters because a timeout or a truncation
 * leaves PARTIAL output that would otherwise read as the complete answer.
 */
export type CliCommandFailure = "timeout" | "truncated" | "spawn" | "exit";

export type CliCommandResult = {
  ok: boolean;
  output: string;
  failure?: CliCommandFailure;
};

export type CliCommandContext = {
  claudePath: string;
  cwd: string;
};

// Long enough for a marketplace fetch over a slow link, short enough that a
// wedged CLI does not leave the composer waiting forever.
export const CLI_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function classify(error: ExecFileException): CliCommandFailure {
  // The timeout kills the child, so `killed` is the only signal that separates
  // "ran out of time with partial output" from "the CLI answered and failed".
  if (error.killed === true) {
    return "timeout";
  }
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return "truncated";
  }
  return error.code === "ENOENT" || error.code === "EINVAL" ? "spawn" : "exit";
}

/**
 * Run `claude <name> <args>` and hand back everything it printed. Failures are
 * returned, not thrown: the CLI's own error text is what the user needs to see.
 *
 * execFile, not exec — the arguments stay an array and never reach a shell.
 */
export async function runBridgedCliCommand(
  context: CliCommandContext,
  name: string,
  argumentText: string
): Promise<CliCommandResult> {
  if (!isBridgedCliCommand(name)) {
    throw new Error(`${name} is not a bridged CLI command`);
  }
  const args = [name, ...splitArguments(argumentText)];
  return new Promise<CliCommandResult>((resolve) => {
    try {
      const child = execFile(
        context.claudePath,
        args,
        {
          cwd: context.cwd,
          timeout: CLI_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true
        },
        (error, stdout, stderr) => {
          // The CLI writes help and some notices to stderr even on success, so
          // both streams are part of the answer.
          const output = `${stdout}${stderr}`.trim();
          if (!error) {
            resolve({ ok: true, output });
            return;
          }
          // Keep the diagnosis even when there IS output: a timeout leaves a
          // partial listing behind that would otherwise pass for the whole one.
          resolve({ ok: false, failure: classify(error), output: output || error.message });
        }
      );
      // Nothing here can answer a prompt, so close stdin at once: a subcommand
      // that asks for confirmation fails immediately instead of sitting on an
      // open pipe until the timeout kills it a minute later.
      child.stdin?.end();
    } catch (error) {
      // execFile throws synchronously for a NUL byte in an argument, and on
      // Windows for a .cmd/.bat target — neither reaches the callback.
      resolve({
        ok: false,
        failure: "spawn",
        output: error instanceof Error ? error.message : String(error)
      });
    }
  });
}
