import { afterEach, describe, expect, it, vi } from "vitest";

import { diag, emitDiagLine, formatDiagLine, setDiagSink } from "../shared/diag";
import {
  companionBuildVersion,
  formatBuildVersion,
  UNKNOWN_BUILD_VERSION
} from "../shared/build-version";

afterEach(() => {
  setDiagSink(undefined);
});

describe("transport diagnostics", () => {
  it("renders stage and scalar fields as a single line", () => {
    expect(
      formatDiagLine("main.pty.write", { sessionId: "abc", textLength: 12, known: true })
    ).toBe("[diag] main.pty.write sessionId=abc textLength=12 known=true");
  });

  it("omits undefined fields so absent context stays out of the log", () => {
    expect(formatDiagLine("main.exit", { sessionId: "abc", signal: undefined })).toBe(
      "[diag] main.exit sessionId=abc"
    );
  });

  it("routes lines to an installed sink instead of the console", () => {
    const sink = vi.fn();
    setDiagSink(sink);
    diag("renderer.onData", { length: 7 });
    expect(sink).toHaveBeenCalledWith("[diag] renderer.onData length=7");
  });

  /**
   * Diagnostics are written to a plain file, so call sites must pass lengths
   * rather than content. This pins the contract that a caller cannot smuggle
   * prompt text through by handing the helper an object.
   */
  it("never renders structured payloads that could carry message content", () => {
    const line = formatDiagLine("main.ipc.claudeWrite", {
      sessionId: "abc",
      dataLength: "비밀 메시지".length
    });
    expect(line).toBe("[diag] main.ipc.claudeWrite sessionId=abc dataLength=6");
    expect(line).not.toContain("비밀");
  });

  /**
   * Renderer-forwarded lines arrive over IPC, so a multi-line or oversized
   * payload must not be able to forge extra entries in the log file.
   */
  it("keeps a forwarded renderer line on a single bounded row", () => {
    const sink = vi.fn();
    setDiagSink(sink);
    emitDiagLine("[diag] renderer.onData length=3\nforged entry");
    expect(sink).toHaveBeenCalledWith("[diag] renderer.onData length=3 forged entry");

    sink.mockClear();
    emitDiagLine("x".repeat(900));
    expect(sink.mock.calls[0][0]).toHaveLength(500);
  });
});

describe("companion build version", () => {
  it("formats a build time as ver. yyyy.MM.dd.HH.mm", () => {
    expect(formatBuildVersion(new Date(2026, 6, 22, 14, 5))).toBe("ver. 2026.07.22.14.05");
  });

  it("pads single digit months, days, hours and minutes", () => {
    expect(formatBuildVersion(new Date(2026, 0, 3, 9, 7))).toBe("ver. 2026.01.03.09.07");
  });

  it("falls back to a dev marker when no build stamp was injected", () => {
    expect(companionBuildVersion()).toBe(UNKNOWN_BUILD_VERSION);
  });
});
