import { describe, expect, it } from "vitest";

import {
  ClaudeStreamParser,
  contextWindowForModel,
  encodeClaudeUserMessage,
  isClaudeAuthError,
  isClaudeLoginRequiredLine,
  isMissingClaudeConversationError,
  summarizeToolInput,
  usedContextTokens,
  type ClaudeEvent
} from "../shared/claude-stream";

const line = (message: unknown): string => `${JSON.stringify(message)}\n`;

const texts = (events: readonly ClaudeEvent[]): string =>
  events.filter((event) => event.kind === "text").map((event) => event.text).join("");

const phases = (events: readonly ClaudeEvent[]): string[] =>
  events.filter((event) => event.kind === "phase").map((event) => event.phase);

describe("Claude stream protocol", () => {
  it("encodes text and image turns as stream-json user messages", () => {
    expect(JSON.parse(encodeClaudeUserMessage("describe this", ["data:image/png;base64,AAAA"]))).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAAA" }
          }
        ]
      },
      parent_tool_use_id: null
    });
  });

  it("renders assistant text deltas exactly once", () => {
    const parser = new ClaudeStreamParser();
    parser.push(line({ type: "system", subtype: "init" }));

    const delta = parser.push(line({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } }
    }));
    expect(texts(delta)).toBe("hello");

    // The complete assistant turn repeats the same text; it must not render twice.
    const complete = parser.push(line({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello" }] }
    }));
    expect(texts(complete)).toBe("");

    // Without partial deltas the assistant turn is the only source of the text.
    const wholeOnly = new ClaudeStreamParser();
    expect(texts(wholeOnly.push(line({
      type: "assistant",
      message: { content: [{ type: "text", text: "done" }] }
    })))).toBe("done\n");
  });

  it("handles chunks split across lines and reports error results", () => {
    const parser = new ClaudeStreamParser();
    const raw = JSON.stringify({ type: "result", is_error: true, result: "auth failed" });
    expect(parser.push(raw.slice(0, 10))).toEqual([]);
    expect(parser.push(`${raw.slice(10)}\n`)).toEqual([
      { kind: "error", message: "auth failed", missingConversation: false }
    ]);
  });

  it("reports an expired login once, as a login prompt instead of an error", () => {
    const parser = new ClaudeStreamParser();
    // Captured from `claude --print` with no stored credentials: a synthetic
    // assistant message tagged authentication_failed, then the error result.
    const events = [
      ...parser.push(line({
        type: "assistant",
        message: {
          model: "<synthetic>",
          content: [{ type: "text", text: "Not logged in · Please run /login" }]
        },
        parent_tool_use_id: null,
        session_id: "conv-1",
        error: "authentication_failed",
        is_api_error_message: true
      })),
      ...parser.push(line({
        type: "result",
        subtype: "success",
        is_error: true,
        terminal_reason: "api_error",
        result: "Not logged in · Please run /login",
        session_id: "conv-1"
      }))
    ];

    expect(events).toEqual([
      { kind: "login", message: "Not logged in · Please run /login" }
    ]);
    // The CLI's sentence must not reach the console as Claude's own reply.
    expect(texts(events)).toBe("");
  });

  it("keeps an ordinary reply that merely mentions logging in as text", () => {
    const parser = new ClaudeStreamParser();
    const events = parser.push(line({
      type: "assistant",
      message: { content: [{ type: "text", text: "Please run /login to continue." }] }
    }));
    expect(events).toEqual([{ kind: "text", text: "Please run /login to continue.\n" }]);
  });

  it("keeps a subagent's auth failure off the top level", () => {
    const parser = new ClaudeStreamParser();
    // One parallel subagent hitting an API auth error is not the session losing its
    // login. Promoting it reset the status strip to idle mid-generation and opened a
    // re-login terminal for an account that was fine.
    const events = parser.push(line({
      type: "assistant",
      parent_tool_use_id: "toolu_agent",
      message: { content: [{ type: "text", text: "Invalid API key · Please run /login" }] },
      error: "authentication_failed",
      is_api_error_message: true
    }));
    expect(events.filter((event) => event.kind === "login")).toEqual([]);

    // The session's own auth failure still reports, on the same parser.
    expect(parser.push(line({
      type: "assistant",
      message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] },
      error: "authentication_failed",
      is_api_error_message: true
    }))).toEqual([{ kind: "login", message: "Not logged in · Please run /login" }]);
  });

  it("narrows the stderr login check to the CLI's own remediation line", () => {
    // stdout auth failures are confirmed by a structured flag; stderr has none, so
    // this check must not fire on another tool talking about its own login.
    expect(isClaudeLoginRequiredLine("Not logged in · Please run /login")).toBe(true);
    expect(isClaudeLoginRequiredLine("Invalid API key · Please run /login")).toBe(true);
    expect(isClaudeLoginRequiredLine("gh: not logged in to github.com")).toBe(false);
    expect(isClaudeLoginRequiredLine("mcp bridge: invalid api key")).toBe(false);
    expect(isClaudeLoginRequiredLine("OAuth token has expired")).toBe(false);
  });

  it("recognises the auth wordings that only arrive as text", () => {
    expect(isClaudeAuthError("Invalid API key · Please run /login")).toBe(true);
    expect(isClaudeAuthError("OAuth token has expired")).toBe(true);
    expect(isClaudeAuthError("Credentials have expired")).toBe(true);
    expect(isClaudeAuthError("auth failed")).toBe(false);
    expect(isClaudeAuthError("No conversation found with session ID: stale")).toBe(false);
  });

  it("identifies stale resume-session errors", () => {
    expect(isMissingClaudeConversationError(
      "[Claude Code error] No conversation found with session ID: stale-session"
    )).toBe(true);
    expect(isMissingClaudeConversationError("[Claude Code error] auth failed")).toBe(false);
  });
});

describe("Claude stream phases", () => {
  it("reports hook progress while booting and emits no ready phase on init", () => {
    const parser = new ClaudeStreamParser();
    const boot = [
      ...parser.push(line({ type: "system", subtype: "hook_started", hook_name: "SessionStart" })),
      ...parser.push(line({ type: "system", subtype: "hook_started", hook_name: "SessionStart" })),
      ...parser.push(line({ type: "system", subtype: "hook_response", hook_name: "SessionStart" }))
    ];
    expect(boot.filter((event) => event.kind === "phase").at(-1)).toEqual({
      kind: "phase",
      phase: "booting",
      detail: "1/2"
    });

    // A per-message run re-inits every time; a user-facing ready here would
    // flash the idle label mid-generation, so init emits nothing.
    expect(parser.push(line({ type: "system", subtype: "init" }))).toEqual([]);
    // Booting must not resume once init has been seen.
    expect(parser.push(line({ type: "system", subtype: "hook_response", hook_name: "SessionStart" }))).toEqual([]);
  });

  /**
   * Async SessionStart hooks keep responding long after the session is usable
   * (observed ~120s). Once ready, they must not drag the strip back to booting.
   */
  it("ignores late hook responses after the session is ready", () => {
    const parser = new ClaudeStreamParser();
    parser.push(line({ type: "system", subtype: "hook_started", hook_name: "SessionStart" }));
    parser.push(line({ type: "system", subtype: "init" }));
    expect(parser.push(line({ type: "system", subtype: "hook_response", hook_name: "SessionStart" }))).toEqual([]);
  });

  it("names the running tool and returns to requesting when it finishes", () => {
    const parser = new ClaudeStreamParser();
    expect(phases(parser.push(line({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "Read", input: {} }
      }
    })))).toEqual(["tool"]);

    // The full input arrives with the assistant turn and refines the label.
    expect(parser.push(line({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "toolu_1",
          name: "Read",
          input: { file_path: "D:\\repo\\package.json" }
        }]
      }
    }))).toEqual([{ kind: "phase", phase: "tool", detail: "Read package.json" }]);

    expect(phases(parser.push(line({
      type: "user",
      message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: "ok" }] }
    })))).toEqual(["requesting"]);
  });

  it("only hands control back to the user on end_turn", () => {
    const parser = new ClaudeStreamParser();
    expect(parser.push(line({
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "tool_use" } }
    }))).toEqual([]);

    expect(parser.push(line({
      type: "stream_event",
      event: { type: "message_delta", delta: { stop_reason: "end_turn" } }
    }))).toEqual([{ kind: "phase", phase: "waiting", detail: undefined }]);
  });

  /**
   * `result` can arrive minutes late from an async hook. Treating it as the end
   * of a turn would flip the status strip long after the answer was delivered.
   */
  it("does not treat a successful late result as a turn boundary", () => {
    const parser = new ClaudeStreamParser();
    expect(parser.push(line({ type: "result", is_error: false, result: "ok" }))).toEqual([]);
  });

  it("collapses repeated phases so the status strip does not churn", () => {
    const parser = new ClaudeStreamParser();
    const first = parser.push(line({ type: "system", subtype: "status", status: "requesting" }));
    const second = parser.push(line({ type: "system", subtype: "status", status: "requesting" }));
    expect(phases(first)).toEqual(["requesting"]);
    expect(second).toEqual([]);
  });

  it("flags a stale resume error so the renderer can recover", () => {
    const parser = new ClaudeStreamParser();
    expect(parser.push(line({
      type: "result",
      is_error: true,
      result: "No conversation found with session ID: abc"
    }))).toEqual([
      {
        kind: "error",
        message: "No conversation found with session ID: abc",
        missingConversation: true
      }
    ]);
  });
});

describe("context usage", () => {
  it("treats the 1m marker and the Opus/Sonnet families as long-context", () => {
    expect(contextWindowForModel("claude-opus-4-8[1m]")).toBe(1_000_000);
    // Passing --model opus strips the [1m] marker but the window is still 1M.
    expect(contextWindowForModel("claude-opus-4-8")).toBe(1_000_000);
    expect(contextWindowForModel("claude-sonnet-5")).toBe(1_000_000);
    // A live Fable conversation reached 462k tokens — impossible in 200k, so
    // fable counts as a 1M model (the 200k denominator showed CTX 100%).
    expect(contextWindowForModel("claude-fable-5")).toBe(1_000_000);
    expect(contextWindowForModel("claude-haiku-4-5")).toBe(200_000);
    expect(contextWindowForModel("")).toBe(200_000);
  });

  /** Cached tokens still occupy the window, so they must be counted. */
  it("counts fresh and cached input tokens together", () => {
    expect(usedContextTokens({
      input_tokens: 2,
      cache_creation_input_tokens: 32_036,
      cache_read_input_tokens: 24_230,
      output_tokens: 1
    })).toBe(56_268);
    expect(usedContextTokens({})).toBeUndefined();
    expect(usedContextTokens(undefined)).toBeUndefined();
  });

  it("emits context usage from message_start using the init model window", () => {
    const parser = new ClaudeStreamParser();
    parser.push(line({ type: "system", subtype: "init", model: "claude-opus-4-8[1m]" }));

    expect(parser.push(line({
      type: "stream_event",
      event: {
        type: "message_start",
        message: {
          model: "claude-opus-4-8",
          usage: { input_tokens: 2, cache_creation_input_tokens: 32_036, cache_read_input_tokens: 24_230 }
        }
      }
    }))).toEqual([
      {
        kind: "context",
        usedTokens: 56_268,
        windowTokens: 1_000_000,
        model: "claude-opus-4-8[1m]"
      }
    ]);
  });

  it("falls back to the standard window when init did not name a model", () => {
    const parser = new ClaudeStreamParser();
    const events = parser.push(line({
      type: "stream_event",
      event: { type: "message_start", message: { model: "claude-x", usage: { input_tokens: 100 } } }
    }));
    expect(events).toEqual([
      { kind: "context", usedTokens: 100, windowTokens: 200_000, model: "claude-x" }
    ]);
  });
});

describe("summarizeToolInput", () => {
  it("prefers a file base name", () => {
    expect(summarizeToolInput("Read", { file_path: "D:\\repo\\src\\index.ts" })).toBe("index.ts");
  });

  it("keeps commands intact up to the safety cap", () => {
    expect(summarizeToolInput("Bash", { command: "x".repeat(80) })).toBe("x".repeat(80));
    expect(summarizeToolInput("Bash", { command: "x".repeat(600) })).toBe(`${"x".repeat(500)}…`);
  });

  it("returns an empty label when nothing is summarizable", () => {
    expect(summarizeToolInput("Task", {})).toBe("");
    expect(summarizeToolInput("Task", undefined)).toBe("");
  });
});

describe("text block boundaries", () => {
  it("starts a new paragraph when a fresh text block follows earlier output", () => {
    const parser = new ClaudeStreamParser();
    parser.push(line({ type: "system", subtype: "init" }));

    let out = "";
    out += texts(parser.push(line({
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "text" } }
    })));
    out += texts(parser.push(line({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "재빌드 후 검증합니다." } }
    })));
    // tool call happens in between…
    out += texts(parser.push(line({
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "tool_use", name: "Bash" } }
    })));
    // …then a NEW text block must not glue to the previous sentence.
    out += texts(parser.push(line({
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "text" } }
    })));
    out += texts(parser.push(line({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "6단계 전부 통과했습니다." } }
    })));

    expect(out).toBe("재빌드 후 검증합니다.\n\n6단계 전부 통과했습니다.");
  });

  it("adds no separator when the previous block already ended with a newline", () => {
    const parser = new ClaudeStreamParser();
    parser.push(line({ type: "system", subtype: "init" }));
    let out = "";
    for (const payload of [
      { type: "content_block_start", content_block: { type: "text" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "첫 줄\n" } },
      { type: "content_block_start", content_block: { type: "text" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "둘째" } }
    ]) {
      out += texts(parser.push(line({ type: "stream_event", event: payload })));
    }
    expect(out).toBe("첫 줄\n둘째");
  });
});

describe("agent tracking", () => {
  const agents = (events: readonly ClaudeEvent[]): Extract<ClaudeEvent, { kind: "agent" }>[] =>
    events.filter((event): event is Extract<ClaudeEvent, { kind: "agent" }> => event.kind === "agent");

  const startAsync = (parser: ClaudeStreamParser, id: string, description: string): ClaudeEvent[] => [
    ...parser.push(line({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Agent", id, input: { description, subagent_type: "general-purpose" } }] }
    })),
    ...parser.push(line({
      type: "system",
      subtype: "task_started",
      tool_use_id: id,
      description,
      subagent_type: "general-purpose"
    }))
  ];

  it("starts an agent once from tool_use and task_started", () => {
    const parser = new ClaudeStreamParser();
    const events = agents(startAsync(parser, "toolu_1", "Return ALPHA"));
    expect(events).toEqual([
      { kind: "agent", op: "start", toolUseId: "toolu_1", agentType: "general-purpose", description: "Return ALPHA" }
    ]);
  });

  it("ignores the async launch-ack tool_result and ends on task_notification", () => {
    const parser = new ClaudeStreamParser();
    startAsync(parser, "toolu_1", "Return ALPHA");
    const ack = parser.push(line({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "Async agent launched successfully." }] }] }
    }));
    expect(agents(ack)).toEqual([]);
    const done = parser.push(line({ type: "system", subtype: "task_notification", tool_use_id: "toolu_1", status: "completed" }));
    expect(agents(done)).toEqual([{ kind: "agent", op: "end", toolUseId: "toolu_1", ok: true }]);
    // A repeated notification for a finished agent is silent.
    expect(agents(parser.push(line({ type: "system", subtype: "task_notification", tool_use_id: "toolu_1", status: "completed" })))).toEqual([]);
  });

  it("ends a synchronous agent (no task_started) on its tool_result", () => {
    const parser = new ClaudeStreamParser();
    parser.push(line({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Task", id: "toolu_9", input: { description: "검토", subagent_type: "reviewer" } }] }
    }));
    const done = parser.push(line({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_9", is_error: true, content: "boom" }] }
    }));
    expect(agents(done)).toEqual([{ kind: "agent", op: "end", toolUseId: "toolu_9", ok: false }]);
  });

  it("turns subagent tool calls into activity and keeps their text out of the console", () => {
    const parser = new ClaudeStreamParser();
    startAsync(parser, "toolu_1", "Return ALPHA");
    const activity = parser.push(line({
      type: "assistant",
      parent_tool_use_id: "toolu_1",
      message: { content: [{ type: "tool_use", name: "Grep", id: "toolu_inner", input: { pattern: "auth" } }] }
    }));
    expect(agents(activity)).toEqual([{ kind: "agent", op: "activity", toolUseId: "toolu_1", detail: "Grep auth" }]);
    const innerText = parser.push(line({
      type: "assistant",
      parent_tool_use_id: "toolu_1",
      message: { content: [{ type: "text", text: "내부 독백은 콘솔에 나오면 안 된다" }] }
    }));
    expect(texts(innerText)).toBe("");
    expect(agents(innerText)).toEqual([]);
  });

  it("suppresses parent-tagged traffic from unknown or non-assistant sources", () => {
    const parser = new ClaudeStreamParser();
    // Unknown parent id: nothing was started.
    expect(parser.push(line({
      type: "assistant",
      parent_tool_use_id: "toolu_ghost",
      message: { content: [{ type: "text", text: "유령" }] }
    }))).toEqual([]);
    startAsync(parser, "toolu_1", "Return ALPHA");
    expect(parser.push(line({
      type: "user",
      parent_tool_use_id: "toolu_1",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_inner", content: "internal" }] }
    }))).toEqual([]);
  });
});
