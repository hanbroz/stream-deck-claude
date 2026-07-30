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

function makeManager(grace = 0, agentIdleTimeoutMs?: number) {
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
  const manager = new ClaudePtyManager({
    runFactory,
    command: "claude.exe",
    finaliseGraceMs: grace,
    ...(agentIdleTimeoutMs === undefined ? {} : { agentIdleTimeoutMs })
  });
  return { manager, runs };
}

const line = (message: unknown): string => `${JSON.stringify(message)}\n`;

/** Let the finalise/idle timers fire before asserting on teardown. */
const tick = (ms = 0): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const agentStarted = (toolUseId: string): string => line({
  type: "system",
  subtype: "task_started",
  tool_use_id: toolUseId,
  subagent_type: "code-reviewer",
  description: "코드 품질 리뷰"
});

const agentFinished = (toolUseId: string): string => line({
  type: "system",
  subtype: "task_notification",
  tool_use_id: toolUseId,
  status: "completed"
});

const endTurn = line({
  type: "stream_event",
  event: { type: "message_delta", delta: { stop_reason: "end_turn" } }
});

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

  /**
   * Esc interrupts the generating message: the run is killed but the
   * conversation id is kept so the next message resumes, and the killed run
   * stays silent (no ended-without-response error).
   */
  it("interrupts the active run without ending the conversation", () => {
    const { manager, runs } = makeManager(10_000);
    const started = manager.start({ cwd: "D:\\repo" });
    const data = vi.fn();
    manager.on("data", data);

    expect(manager.interrupt(started.sessionId)).toBe(false); // nothing running yet

    manager.write(started.sessionId, "hi");
    runs[0].data.emit("data", line({ type: "system", subtype: "init", session_id: "conv-1" }));

    expect(manager.interrupt(started.sessionId)).toBe(true);
    expect(runs[0].kill).toHaveBeenCalled();

    // The killed run can never report end_turn, so interrupt itself hands
    // the waiting state back (keeps the Stream Deck key from sticking on
    // "running" after an Esc).
    const phases = data.mock.calls
      .flatMap(([, events]) => events as ClaudeEvent[])
      .filter((event) => event.kind === "phase")
      .map((event) => (event as { phase: string }).phase);
    expect(phases.at(-1)).toBe("ready");

    // The killed run's late exit must not surface an error…
    data.mockClear();
    runs[0].exit.emit("exit", { exitCode: 1 });
    expect(data).not.toHaveBeenCalled();

    // …and the next message resumes the captured conversation and is accepted.
    manager.write(started.sessionId, "next");
    expect(runs[1].spec.args).toEqual(expect.arrayContaining(["--resume", "conv-1"]));
  });

  it("stays silent on hook-failure stderr noise (e.g. the SessionEnd hook we cancel)", () => {
    const { manager, runs } = makeManager();
    const started = manager.start({ cwd: "D:\\repo" });
    const data = vi.fn();
    manager.on("data", data);

    manager.write(started.sessionId, "hi");
    runs[0].error.emit(
      "error",
      "SessionEnd hook [export PATH=...; node bun-runner.js worker-service.cjs hook claude-code session-complete] failed: Hook cancelled"
    );

    const events = data.mock.calls.flatMap(([, e]) => e as ClaudeEvent[]);
    expect(events.filter((event) => event.kind === "error")).toEqual([]);
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

  it("holds the run open while background agents keep working past end_turn", async () => {
    const { manager, runs } = makeManager();
    const started = manager.start({ cwd: "D:\\repo" });

    manager.write(started.sessionId, "에이전트 4개 실행");
    runs[0].data.emit("data", agentStarted("t1"));
    runs[0].data.emit("data", agentStarted("t2"));
    // Claude finishes its reply while both agents are still running.
    runs[0].data.emit("data", endTurn);
    await tick();
    expect(runs[0].kill).not.toHaveBeenCalled();

    runs[0].data.emit("data", agentFinished("t1"));
    await tick();
    expect(runs[0].kill).not.toHaveBeenCalled();

    // Only once the last agent reports does the process become disposable.
    runs[0].data.emit("data", agentFinished("t2"));
    await tick();
    expect(runs[0].kill).toHaveBeenCalled();
  });

  it("tears a held run down when a background agent goes silent", async () => {
    const { manager, runs } = makeManager(0, 20);
    const started = manager.start({ cwd: "D:\\repo" });

    manager.write(started.sessionId, "에이전트 실행");
    runs[0].data.emit("data", agentStarted("t1"));
    runs[0].data.emit("data", endTurn);
    await tick();
    expect(runs[0].kill).not.toHaveBeenCalled();

    // The agent never reports completion; the idle cap must reclaim the process.
    await tick(60);
    expect(runs[0].kill).toHaveBeenCalled();
  });

  it("closes agent rows only when the run actually dies", () => {
    const { manager, runs } = makeManager();
    const started = manager.start({ cwd: "D:\\repo" });
    const data = vi.fn();
    manager.on("data", data);

    manager.write(started.sessionId, "에이전트 실행");
    runs[0].data.emit("data", agentStarted("t1"));
    runs[0].data.emit("data", endTurn);

    const beforeExit = data.mock.calls.flatMap(([, e]) => e as ClaudeEvent[]);
    expect(beforeExit.filter((event) => event.kind === "agent" && event.op === "end")).toEqual([]);

    runs[0].exit.emit("exit", { exitCode: 1 });
    const afterExit = data.mock.calls.flatMap(([, e]) => e as ClaudeEvent[]);
    expect(afterExit).toContainEqual({ kind: "agent", op: "end", toolUseId: "t1", ok: false });
  });

  it("still reports background agent progress after the next message takes over", async () => {
    const { manager, runs } = makeManager();
    const started = manager.start({ cwd: "D:\\repo" });
    const data = vi.fn();
    manager.on("data", data);

    manager.write(started.sessionId, "first");
    runs[0].data.emit("data", line({ type: "system", subtype: "init", session_id: "conv-1" }));
    runs[0].data.emit("data", agentStarted("t1"));
    runs[0].data.emit("data", endTurn);
    await tick();

    manager.write(started.sessionId, "second");
    data.mockClear();
    // The superseded run's agent finishes: only that may still reach the board.
    runs[0].data.emit("data", agentFinished("t1"));
    runs[0].data.emit("data", line({
      type: "assistant",
      message: { content: [{ type: "text", text: "stale text" }] }
    }));

    const events = data.mock.calls.flatMap(([, e]) => e as ClaudeEvent[]);
    expect(events).toEqual([{ kind: "agent", op: "end", toolUseId: "t1", ok: true }]);
  });

  it("ends held background runs when the conversation is cleared", async () => {
    const { manager, runs } = makeManager();
    const started = manager.start({ cwd: "D:\\repo" });

    manager.write(started.sessionId, "에이전트 실행");
    runs[0].data.emit("data", agentStarted("t1"));
    runs[0].data.emit("data", endTurn);
    await tick();
    expect(runs[0].kill).not.toHaveBeenCalled();

    manager.clear(started.sessionId);
    expect(runs[0].kill).toHaveBeenCalled();
  });

  it("treats an expired login as a re-login prompt, not a failed session", () => {
    const { manager, runs } = makeManager();
    const started = manager.start({ cwd: "D:\\repo" });
    const data = vi.fn();
    manager.on("data", data);

    manager.write(started.sessionId, "hi");
    runs[0].data.emit("data", line({
      type: "assistant",
      message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] },
      session_id: "conv-1",
      error: "authentication_failed",
      is_api_error_message: true
    }));
    // The auth failure ends the run with exit 1 and no end_turn.
    runs[0].exit.emit("exit", { exitCode: 1 });

    const events = data.mock.calls.flatMap(([, e]) => e as ClaudeEvent[]);
    expect(events.filter((event) => event.kind === "login")).toEqual([
      { kind: "login", message: "Not logged in · Please run /login" }
    ]);
    expect(events.filter((event) => event.kind === "error")).toEqual([]);
    // The session is free again, so the next message can be sent after logging in.
    expect(() => manager.write(started.sessionId, "retry")).not.toThrow();
  });

  it("surfaces an auth failure that only reaches stderr as a login prompt", () => {
    const { manager, runs } = makeManager();
    const started = manager.start({ cwd: "D:\\repo" });
    const data = vi.fn();
    manager.on("data", data);

    manager.write(started.sessionId, "hi");
    runs[0].error.emit("error", "Invalid API key · Please run /login");
    runs[0].exit.emit("exit", { exitCode: 1 });

    const events = data.mock.calls.flatMap(([, e]) => e as ClaudeEvent[]);
    expect(events).toContainEqual({ kind: "login", message: "Invalid API key · Please run /login" });
    expect(events.filter((event) => event.kind === "error")).toEqual([]);
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
