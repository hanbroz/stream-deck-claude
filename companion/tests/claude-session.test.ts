import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { ClaudePtyManager, type ClaudeRunSpec } from "../main/claude-session";
import type { ClaudeEvent } from "../shared/claude-stream";

type FakeRun = {
  spec: ClaudeRunSpec;
  data: EventEmitter;
  error: EventEmitter;
  exit: EventEmitter;
  writeStdin: ReturnType<typeof vi.fn<(data: string) => void>>;
  endStdin: ReturnType<typeof vi.fn<() => void>>;
  kill: ReturnType<typeof vi.fn<() => void>>;
};

function makeManager(grace = 0) {
  const runs: FakeRun[] = [];
  const runFactory = (spec: ClaudeRunSpec) => {
    const data = new EventEmitter();
    const error = new EventEmitter();
    const exit = new EventEmitter();
    const run: FakeRun = {
      spec,
      data,
      error,
      exit,
      writeStdin: vi.fn(),
      endStdin: vi.fn(),
      kill: vi.fn()
    };
    runs.push(run);
    return {
      onData: (l: (d: string) => void) => data.on("data", l),
      onError: (l: (d: string) => void) => error.on("error", l),
      onExit: (l: (e: { exitCode: number }) => void) => exit.on("exit", l),
      writeStdin: run.writeStdin,
      endStdin: run.endStdin,
      kill: run.kill
    };
  };
  const manager = new ClaudePtyManager({ runFactory, command: "claude.exe", finaliseGraceMs: grace });
  return { manager, runs };
}

const line = (message: unknown): string => `${JSON.stringify(message)}\n`;

describe("ClaudePtyManager (per-message runs)", () => {
  it("does not spawn until the first message is written", () => {
    const { manager, runs } = makeManager();
    const started = manager.start({ cwd: "D:\\repo" });
    expect(started).toMatchObject({ cwd: "D:\\repo", mode: "new" });
    expect(runs).toHaveLength(0);

    manager.write(started.sessionId, "hi");
    expect(runs).toHaveLength(1);
    expect(runs[0].spec.command).toBe("claude.exe");
    expect(runs[0].spec.args).not.toContain("--resume");
    expect(runs[0].writeStdin).toHaveBeenCalledOnce();
    expect(runs[0].endStdin).toHaveBeenCalledOnce();
  });

  it("resumes the captured conversation id on the next message", () => {
    const { manager, runs } = makeManager();
    const started = manager.start({ cwd: "D:\\repo" });

    manager.write(started.sessionId, "first");
    runs[0].data.emit("data", line({ type: "system", subtype: "init", session_id: "conv-1" }));
    runs[0].data.emit("data", line({
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "end_turn" } },
      session_id: "conv-1"
    }));
    runs[0].exit.emit("exit", { exitCode: 0 });

    manager.write(started.sessionId, "second");
    expect(runs[1].spec.args).toContain("--resume");
    expect(runs[1].spec.args[runs[1].spec.args.indexOf("--resume") + 1]).toBe("conv-1");
  });

  it("seeds the resume id from Code Start's saved session", () => {
    const { manager, runs } = makeManager();
    const started = manager.start({ cwd: "D:\\repo", mode: "resume", sessionId: "saved-42" });
    manager.write(started.sessionId, "hi");
    expect(runs[0].spec.args[runs[0].spec.args.indexOf("--resume") + 1]).toBe("saved-42");
  });

  it("applies model and effort per message and updates on configure", () => {
    const { manager, runs } = makeManager();
    const started = manager.start({ cwd: "D:\\repo", model: "opus", effort: "high" });
    manager.write(started.sessionId, "a");
    runs[0].exit.emit("exit", { exitCode: 0 });
    expect(runs[0].spec.args).toEqual(expect.arrayContaining(["--model", "opus", "--effort", "high"]));

    manager.configure(started.sessionId, { model: "sonnet", effort: "low" });
    manager.write(started.sessionId, "b");
    expect(runs[1].spec.args).toEqual(expect.arrayContaining(["--model", "sonnet", "--effort", "low"]));
  });

  it("forwards conversation events and swallows the per-message process exit", () => {
    const { manager, runs } = makeManager();
    const started = manager.start({ cwd: "D:\\repo" });
    const data = vi.fn();
    const exit = vi.fn();
    manager.on("data", data);
    manager.on("exit", exit);

    manager.write(started.sessionId, "hi");
    runs[0].data.emit("data", line({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] }
    }));
    runs[0].exit.emit("exit", { exitCode: 0 });

    const rendered = data.mock.calls
      .flatMap(([, events]) => events as ClaudeEvent[])
      .filter((e) => e.kind === "text")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(rendered).toBe("hello\n");
    // A normal per-message exit must NOT tell the renderer the session ended.
    expect(exit).not.toHaveBeenCalled();
  });

  it("kills the run shortly after end_turn instead of waiting for finalise", () => {
    const { manager, runs } = makeManager(50);
    const started = manager.start({ cwd: "D:\\repo" });
    manager.write(started.sessionId, "hi");

    runs[0].data.emit("data", line({
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "end_turn" } }
    }));
    expect(runs[0].kill).not.toHaveBeenCalled();
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(runs[0].kill).toHaveBeenCalled();
      resolve();
    }, 80));
  });

  it("rejects a second message while one is still generating", () => {
    const { manager, runs } = makeManager();
    const started = manager.start({ cwd: "D:\\repo" });
    manager.write(started.sessionId, "first");
    expect(() => manager.write(started.sessionId, "second")).toThrow(/기다리는 중/u);
    expect(runs).toHaveLength(1);
  });

  /**
   * The reply is delivered at end_turn; the process is only being torn down.
   * The user must be able to send the next message immediately, not wait for
   * the finalise grace + process exit.
   */
  it("accepts the next message as soon as the turn ends, before the process exits", () => {
    const { manager, runs } = makeManager(10_000);
    const started = manager.start({ cwd: "D:\\repo" });
    manager.write(started.sessionId, "first");
    runs[0].data.emit("data", line({
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "end_turn" } }
    }));
    // Run 0 has NOT exited yet (still within finalise grace).
    expect(() => manager.write(started.sessionId, "second")).not.toThrow();
    expect(runs).toHaveLength(2);
  });

  it("clear forgets the conversation so the next message starts fresh", () => {
    const { manager, runs } = makeManager();
    const started = manager.start({ cwd: "D:\\repo", mode: "resume", sessionId: "saved-1" });
    manager.write(started.sessionId, "a");
    runs[0].exit.emit("exit", { exitCode: 0 });

    manager.clear(started.sessionId);
    manager.write(started.sessionId, "b");
    expect(runs[1].spec.args).not.toContain("--resume");
  });

  /**
   * After end_turn a superseded run lingers during the finalise grace; its late
   * output (trailing text, a `result`, a context event) must not bleed into the
   * next message's turn.
   */
  it("drops a superseded run's late output once the next run is active", () => {
    const { manager, runs } = makeManager(10_000);
    const started = manager.start({ cwd: "D:\\repo" });
    const data = vi.fn();
    manager.on("data", data);

    manager.write(started.sessionId, "first");
    runs[0].data.emit("data", line({
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "end_turn" } }
    }));
    manager.write(started.sessionId, "second"); // run 1 is now the active run
    data.mockClear();

    runs[0].data.emit("data", line({
      type: "assistant",
      message: { content: [{ type: "text", text: "LATE" }] }
    }));
    expect(data).not.toHaveBeenCalled();
  });

  /**
   * clear()/kill() detach the active run before killing it, so its later
   * non-zero exit must not surface an "ended without response" error to the
   * renderer — the user just started a new conversation.
   */
  it("stays silent when a cleared run later exits non-zero", () => {
    const { manager, runs } = makeManager(10_000);
    const started = manager.start({ cwd: "D:\\repo", mode: "resume", sessionId: "saved-1" });
    const data = vi.fn();
    manager.on("data", data);

    manager.write(started.sessionId, "hi");
    manager.clear(started.sessionId);
    data.mockClear();

    runs[0].exit.emit("exit", { exitCode: 1 });
    expect(data).not.toHaveBeenCalled();
  });

  it("surfaces stderr as an error event", () => {
    const { manager, runs } = makeManager();
    const started = manager.start({ cwd: "D:\\repo" });
    const data = vi.fn();
    manager.on("data", data);

    manager.write(started.sessionId, "hi");
    runs[0].error.emit("error", "No conversation found with session ID: gone");

    const events = data.mock.calls.flatMap(([, e]) => e as ClaudeEvent[]);
    expect(events).toContainEqual({
      kind: "error",
      message: "No conversation found with session ID: gone",
      missingConversation: true
    });
  });

  it("pastes a clipboard image as an image-only message", () => {
    const { manager, runs } = makeManager();
    const started = manager.start({ cwd: "D:\\repo" });
    const clipboard = {
      readImage: () => ({ isEmpty: () => false, toDataURL: () => "data:image/png;base64,AAAA" })
    };
    expect(manager.pasteClipboardImage(started.sessionId, clipboard)).toBe(true);
    const payload = JSON.parse(runs[0].writeStdin.mock.calls[0][0] as string);
    expect(payload.message.content[0]).toMatchObject({ type: "image" });
  });

  it("does not write when the clipboard has no image", () => {
    const { manager, runs } = makeManager();
    const started = manager.start({ cwd: "D:\\repo" });
    const clipboard = { readImage: () => ({ isEmpty: () => true }) };
    expect(manager.pasteClipboardImage(started.sessionId, clipboard)).toBe(false);
    expect(runs).toHaveLength(0);
  });
});
