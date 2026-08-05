import { describe, expect, it } from "vitest";

import { describeLaunchFailure } from "../src/actions/launch-failure-message";

const FOLDER = "G:\\내 드라이브\\2ndBrain\\2ndBrain";
const LOG_DIR = "D:\\Plugin\\logs";

function enoent(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(
    `ENOENT: no such file or directory, stat '${FOLDER}'`
  );
  error.code = "ENOENT";
  return error;
}

describe("describeLaunchFailure", () => {
  it("names the missing folder, which is what a disconnected cloud drive produces", () => {
    expect(describeLaunchFailure(enoent(), FOLDER, LOG_DIR)).toBe(
      `프로젝트에 지정된 경로 "${FOLDER}"를 찾을 수 없습니다.`
    );
  });

  it("separates a path that exists but is a file from one that is absent", () => {
    const error = new Error("Configured Code Start path is not a directory");

    expect(describeLaunchFailure(error, FOLDER, LOG_DIR)).toBe(
      `프로젝트에 지정된 경로 "${FOLDER}"가 폴더가 아닙니다.`
    );
  });

  it("reports a missing Claude Code install", () => {
    const error = new Error("Claude Code executable was not found");

    expect(describeLaunchFailure(error, FOLDER, LOG_DIR)).toBe(
      "Claude Code 실행 파일을 찾을 수 없습니다. 설치 여부를 확인해 주세요."
    );
  });

  it("reports a missing Companion install", () => {
    const error = new Error(
      "Code Deck Companion executable was not found. Set CLAUDE_DECK_ALLOW_TERMINAL_FALLBACK=1 to use the development terminal fallback."
    );

    expect(describeLaunchFailure(error, FOLDER, LOG_DIR)).toBe(
      "Code Deck Companion 실행 파일을 찾을 수 없습니다."
    );
  });

  /**
   * The fallback is what makes matching the cases above on message text safe: a
   * reworded throw site degrades to this, never back to a bare alert icon.
   */
  it("falls back to the raw error plus the log path for anything unrecognised", () => {
    const error = new Error("Windows Terminal launcher failed (1)");

    const message = describeLaunchFailure(error, FOLDER, LOG_DIR);

    expect(message).toContain("Code Start 실행에 실패했습니다.");
    expect(message).toContain("Windows Terminal launcher failed (1)");
    expect(message).toContain("D:\\Plugin\\logs\\com.hanbroz.claude-usage.0.log");
  });

  it("survives a thrown non-Error", () => {
    expect(describeLaunchFailure("spawn blew up", FOLDER, LOG_DIR)).toContain("spawn blew up");
  });
});
