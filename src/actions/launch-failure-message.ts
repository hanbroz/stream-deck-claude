import path from "node:path";

/** streamDeck.logger writes to the newest file first; older presses rotate up. */
const CURRENT_LOG_FILE_NAME = "com.hanbroz.claude-usage.0.log";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Turn a launch failure into a sentence the person who pressed the key can act
 * on, replacing an alert icon that said only "something went wrong".
 *
 * Recognising the two executable failures by their message text is fragile —
 * rewording either throw site silently stops the match. That is tolerable here
 * because a miss is not a regression: the fallback still shows the raw error and
 * the log path, which beats the bare icon this replaced. The safety net is what
 * makes typed error classes unnecessary for four cases.
 */
export function describeLaunchFailure(
  error: unknown,
  folder: string,
  pluginLogDirectory: string
): string {
  const code = errorCode(error);
  if (code === "ENOENT") {
    // Only the project folder's own stat is about the project folder; a
    // missing bridge source or powershell.exe is a different problem.
    const missingPath = (error as NodeJS.ErrnoException).path;
    if (missingPath === undefined || path.resolve(missingPath) === path.resolve(folder)) {
      return `프로젝트에 지정된 경로 "${folder}"를 찾을 수 없습니다.`;
    }
    return `필요한 파일을 찾을 수 없습니다: "${missingPath}". 플러그인 로그(${pluginLogDirectory})를 확인해 주세요.`;
  }

  const message = errorMessage(error);
  // validateLaunchFolder throws a plain Error for this; a stat against a file
  // path can also surface it as ENOTDIR. Both mean the same thing to the user.
  if (code === "ENOTDIR" || message.includes("is not a directory")) {
    return `프로젝트에 지정된 경로 "${folder}"가 폴더가 아닙니다.`;
  }
  if (message.includes("Claude Code executable was not found")) {
    return "Claude Code 실행 파일을 찾을 수 없습니다. 설치 여부를 확인해 주세요.";
  }
  if (message.includes("Code Deck Companion executable was not found")) {
    return "Code Deck Companion 실행 파일을 찾을 수 없습니다.";
  }

  return [
    "Code Start 실행에 실패했습니다.",
    "",
    message,
    "",
    "자세한 내용:",
    path.join(pluginLogDirectory, CURRENT_LOG_FILE_NAME)
  ].join("\n");
}
