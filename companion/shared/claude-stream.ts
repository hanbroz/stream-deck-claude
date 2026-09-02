type JsonRecord = Record<string, unknown>;

/**
 * What the Companion is currently doing, derived from Claude's stream.
 *
 * `booting` covers the SessionStart hooks, which take several seconds and used
 * to leave the Console blank with no explanation. `waiting` means Claude ended
 * its turn and the user has the floor.
 */
export type ClaudePhase =
  | "booting"
  | "ready"
  | "requesting"
  | "thinking"
  | "responding"
  | "tool"
  | "waiting";

/**
 * How an agent's row closes.
 *
 * "unknown" is NOT a failure. The run that owned the agent was torn down before
 * it reported — a killed session, or the idle backstop reclaiming a process
 * held open for background agents — so its result cannot be known. Folding that
 * into "failed" made an agent that was doing exactly what it should (a server
 * staying up, a wait for human input) read as broken.
 */
export type AgentOutcome = "ok" | "failed" | "unknown";

export type ClaudeEvent =
  | { kind: "text"; text: string }
  | { kind: "phase"; phase: ClaudePhase; detail?: string }
  | { kind: "context"; usedTokens: number; windowTokens: number; model: string }
  | { kind: "agent"; op: "start"; toolUseId: string; agentType: string; description: string }
  | { kind: "agent"; op: "activity"; toolUseId: string; detail: string }
  | { kind: "agent"; op: "end"; toolUseId: string; outcome: AgentOutcome }
  | { kind: "error"; message: string; missingConversation: boolean }
  // Not a failure of the conversation: the account simply has to log in again.
  | { kind: "login"; message: string }
  | { kind: "rateLimits"; windows: ClaudeRateLimitWindows };

export type ClaudeRateLimitWindow = { usedPercentage: number; resetsAt: number };
export type ClaudeRateLimitWindows = {
  fiveHour?: ClaudeRateLimitWindow;
  sevenDay?: ClaudeRateLimitWindow;
};

function parseUnifiedWindow(value: unknown): ClaudeRateLimitWindow | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const utilization = value.utilization;
  const resetsAt = value.resetsAt;
  if (
    typeof utilization !== "number" || !Number.isFinite(utilization) ||
    typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0
  ) {
    return undefined;
  }
  // `utilization` is the fraction of the window used (0-1, above 1 in
  // overage); the status line reports the same number as a percentage.
  return {
    usedPercentage: Math.min(100, Math.max(0, utilization * 100)),
    // Epoch seconds, like the status line's resets_at; tolerate milliseconds.
    resetsAt: resetsAt > 10_000_000_000 ? Math.floor(resetsAt / 1000) : resetsAt
  };
}

/**
 * The subscription windows carried by a stream-json `rate_limit_event`
 * (`rate_limit_info.unifiedWindows`, read by the CLI from the
 * anthropic-ratelimit-unified-* response headers). A `--print` run never
 * renders a status line, so this is the only place a Companion session
 * learns the five-hour / weekly usage the Stream Deck keys show.
 */
export function parseRateLimitEvent(message: unknown): ClaudeRateLimitWindows | undefined {
  if (!isRecord(message) || message.type !== "rate_limit_event" || !isRecord(message.rate_limit_info)) {
    return undefined;
  }
  const unified = message.rate_limit_info.unifiedWindows;
  if (!isRecord(unified)) {
    return undefined;
  }
  const fiveHour = parseUnifiedWindow(unified.five_hour);
  const sevenDay = parseUnifiedWindow(unified.seven_day);
  if (!fiveHour && !sevenDay) {
    return undefined;
  }
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) };
}

const DEFAULT_CONTEXT_WINDOW = 200_000;
const LONG_CONTEXT_WINDOW = 1_000_000;

/**
 * The context window for a model string from the stream.
 *
 * The stream has no window field. Claude marks the long-context variant with a
 * `[1m]` suffix (e.g. `claude-opus-4-8[1m]`), but passing `--model opus`
 * strips that suffix even though Opus and Sonnet still run a 1M window — so the
 * marker alone under-reports. The model family is the reliable signal: Opus and
 * Sonnet are 1M, Haiku is 200k.
 *
 * ponytail: calibration knob. If a family's real window differs from this, that
 * is a factual correction to make here, not a structural change.
 */
export function contextWindowForModel(model: string): number {
  // Fable proved to be a 1M model in the field: a live conversation reached
  // 462k tokens, which a 200k window cannot hold (the 200k denominator showed
  // CTX 100% when the truth was 46%).
  if (/\[1m\]/iu.test(model) || /opus|sonnet|fable/iu.test(model)) {
    return LONG_CONTEXT_WINDOW;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/** Tokens occupying the context window, including both cache tiers. */
export function usedContextTokens(usage: unknown): number | undefined {
  if (!isRecord(usage)) {
    return undefined;
  }
  const sum = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
    .map((key) => (typeof usage[key] === "number" ? (usage[key] as number) : 0))
    .reduce((total, value) => total + value, 0);
  return sum > 0 ? sum : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function textBlocks(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .filter(isRecord)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    // Text blocks are separate paragraphs (tool calls sit between them);
    // joining bare would glue "…검증합니다." + "6단계 통과" into one line.
    .join("\n\n");
}

function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/u);
  return parts[parts.length - 1] || filePath;
}

/** Short, human-readable target for a tool call, e.g. `package.json`. */
export function summarizeToolInput(name: string, input: unknown): string {
  if (!isRecord(input)) {
    return "";
  }
  const pick = (key: string): string | undefined =>
    typeof input[key] === "string" ? (input[key] as string) : undefined;

  const filePath = pick("file_path") ?? pick("notebook_path");
  if (filePath) {
    return baseName(filePath);
  }
  const inline = pick("command") ?? pick("pattern") ?? pick("description") ?? pick("url");
  if (!inline) {
    return "";
  }
  // Width-based truncation is the status line CSS's job (text-overflow:
  // ellipsis); this cap only bounds pathological inputs like heredoc commits.
  const flat = inline.replace(/\s+/gu, " ").trim();
  return flat.length > 500 ? `${flat.slice(0, 500)}…` : flat;
}

export function encodeClaudeUserMessage(
  text: string,
  imageDataUrls: readonly string[] = []
): string {
  const imageBlocks = imageDataUrls.map((dataUrl) => {
    const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/iu.exec(dataUrl);
    if (!match) {
      throw new Error("Claude image input must be a base64 data URL");
    }
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: match[1],
        data: match[2]
      }
    };
  });
  const content = imageBlocks.length > 0
    ? [
        ...(text.length > 0 ? [{ type: "text", text }] : []),
        ...imageBlocks
      ]
    : text;

  return `${JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content
    },
    parent_tool_use_id: null
  })}\n`;
}

/**
 * Hook failures on stderr are ambient noise for the conversation — above all
 * the SessionEnd hook the Companion itself cancels by killing the finished
 * per-message run ("SessionEnd hook [...] failed: Hook cancelled"). They must
 * not surface as red error turns in the transcript.
 */
export function isHookFailureNoise(data: string): boolean {
  return /\bhook\b/iu.test(data) && /\b(failed|cancell?ed)\b/iu.test(data);
}

export function isMissingClaudeConversationError(data: string): boolean {
  return /No conversation found with session ID:/iu.test(data);
}

/**
 * An expired or absent login is reported as an API error, not a crash: the run
 * prints a synthetic assistant message ("Not logged in · Please run /login")
 * tagged `error: "authentication_failed"`, repeats it as an `is_error` result,
 * and exits 1. `--print` has no TTY, so /login cannot run inside it — this
 * condition needs an interactive shell, and showing it as a conversation error
 * only tells the user that something broke.
 *
 * ponytail: the structured tag is the primary signal; this text match covers the
 * stderr path and builds that only print the sentence. New CLI wording for the
 * same condition is a factual correction to make here.
 */
export function isClaudeAuthError(data: string): boolean {
  return /please run \/login|not logged in|invalid api key|oauth token[^\n]*(?:expired|revoked)|authentication[ _]failed|credentials?[^\n]*expired/iu
    .test(data);
}

/**
 * The stderr counterpart, deliberately narrower than `isClaudeAuthError`.
 *
 * A stdout auth failure is confirmed by a structured flag before its text is even
 * consulted. stderr has no such flag, and plenty of things print there: a hook
 * checking `gh auth`, an MCP server with a bad key, any tool saying "not logged
 * in" about its own service. Treating those as the session losing its Claude login
 * suppressed the run's real failure — the generic exit error is skipped once a
 * login is reported — and opened a re-login terminal for an account that was fine.
 * Only the CLI's own remediation sentence counts here.
 */
export function isClaudeLoginRequiredLine(data: string): boolean {
  return /please run \/login/iu.test(data);
}

export class ClaudeStreamParser {
  private buffer = "";
  private hasPartialAssistantText = false;
  // Tracks streamed text across content blocks so a NEW text block (after
  // tool calls) starts on its own paragraph instead of gluing to the last.
  private emittedStreamText = false;
  private lastStreamTextEnd = "\n";
  private ready = false;
  private hooksStarted = 0;
  private hooksDone = 0;
  private lastPhase: ClaudePhase | undefined;
  private lastDetail: string | undefined;
  private model = "";
  private contextWindow = DEFAULT_CONTEXT_WINDOW;
  private sessionId: string | undefined;
  private loginReported = false;
  // Live subagents keyed by their Task/Agent tool_use id. Async agents (whose
  // launch the CLI acks with an immediate tool_result) also sit in asyncAgents
  // so that ack is not mistaken for completion — they end via task_notification.
  private readonly knownAgents = new Set<string>();
  private readonly asyncAgents = new Set<string>();

  /** The Claude conversation id seen so far, consumed once by the caller. */
  takeSessionId(): string | undefined {
    return this.sessionId;
  }

  push(data: string): ClaudeEvent[] {
    this.buffer += data;
    const lines = this.buffer.split(/\r?\n/u);
    this.buffer = lines.pop() ?? "";
    return lines.flatMap((line) => this.parseLine(line));
  }

  flush(): ClaudeEvent[] {
    const line = this.buffer;
    this.buffer = "";
    return this.parseLine(line);
  }

  /** Collapse repeats so the status strip does not churn on every chunk. */
  private phase(phase: ClaudePhase, detail?: string): ClaudeEvent[] {
    if (this.lastPhase === phase && this.lastDetail === detail) {
      return [];
    }
    this.lastPhase = phase;
    this.lastDetail = detail;
    return [{ kind: "phase", phase, detail }];
  }

  private parseLine(line: string): ClaudeEvent[] {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return [];
    }

    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      // Claude also prints unstructured diagnostics; they are not conversation.
      return [];
    }
    if (!isRecord(message) || typeof message.type !== "string") {
      return [];
    }

    if (typeof message.session_id === "string" && message.session_id.length > 0) {
      this.sessionId = message.session_id;
    }


    // Subagent traffic is tagged with the spawning tool_use id. It must never
    // reach the console as top-level text; it only feeds the agent board.
    if (typeof message.parent_tool_use_id === "string" && message.parent_tool_use_id.length > 0) {
      return this.parseSubagent(message.parent_tool_use_id, message);
    }

    // An auth failure arrives twice — as the synthetic assistant message and again
    // as the error result — so report it once. This sits after the subagent route
    // on purpose: a subagent hitting an API auth error is not the session losing
    // its login, and promoting it here reset the status strip to idle mid-turn and
    // opened a re-login terminal the user did not need. It still precedes the
    // assistant branch, which would otherwise render the CLI's "Please run /login"
    // sentence as if Claude had said it.
    const loginRequired = this.authFailureText(message);
    if (loginRequired !== undefined) {
      if (this.loginReported) {
        return [];
      }
      this.loginReported = true;
      return [{ kind: "login", message: loginRequired }];
    }

    switch (message.type) {
      case "system":
        return this.parseSystem(message);
      case "stream_event":
        return this.parseStreamEvent(message);
      case "assistant":
        return this.parseAssistant(message);
      case "user":
        return this.parseUser(message);
      case "rate_limit_event": {
        const windows = parseRateLimitEvent(message);
        return windows ? [{ kind: "rateLimits", windows }] : [];
      }
      case "result":
        // `result` can arrive minutes late from async hooks, so it must never be
        // treated as the end of a turn. Only surface genuine failures.
        return message.is_error === true && typeof message.result === "string"
          ? [{
              kind: "error",
              message: message.result,
              missingConversation: isMissingClaudeConversationError(message.result)
            }]
          : [];
      default:
        return [];
    }
  }

  /**
   * The login-required sentence when this line reports an auth failure.
   *
   * The structured `error` tag decides it on its own; otherwise the line must
   * already be flagged as an API error, so an ordinary reply that merely
   * mentions logging in is never mistaken for one.
   */
  private authFailureText(message: JsonRecord): string | undefined {
    const text = (
      message.type === "result" && typeof message.result === "string"
        ? message.result
        : textBlocks(isRecord(message.message) ? message.message.content : undefined)
    ).trim();
    if (message.error === "authentication_failed") {
      return text.length > 0 ? text : "Not logged in · Please run /login";
    }
    const apiError = message.is_api_error_message === true
      || (message.type === "result" && message.is_error === true);
    return apiError && isClaudeAuthError(text) ? text : undefined;
  }

  private parseSystem(message: JsonRecord): ClaudeEvent[] {
    switch (message.subtype) {
      case "hook_started":
        this.hooksStarted += 1;
        return this.ready ? [] : this.phase("booting", `${this.hooksDone}/${this.hooksStarted}`);
      case "hook_response":
        this.hooksDone += 1;
        return this.ready ? [] : this.phase("booting", `${this.hooksDone}/${this.hooksStarted}`);
      case "init":
        this.ready = true;
        if (typeof message.model === "string") {
          this.model = message.model;
          this.contextWindow = contextWindowForModel(message.model);
        }
        // Each per-message run re-inits, so a user-facing `ready` here would
        // flash the idle label mid-generation. The renderer sets ready itself
        // when a session starts; init only ends the booting/hook phase.
        this.lastPhase = "ready";
        this.lastDetail = undefined;
        return [];
      case "status":
        return message.status === "requesting" ? this.phase("requesting") : [];
      case "thinking_tokens":
        return typeof message.estimated_tokens === "number"
          ? this.phase("thinking", `${message.estimated_tokens} tokens`)
          : this.phase("thinking");
      case "task_started": {
        // The definitive start signal for async agents, richer than the
        // tool_use block — and the cue to treat their tool_result as a
        // launch ack rather than completion.
        const id = typeof message.tool_use_id === "string" ? message.tool_use_id : "";
        if (id.length === 0) {
          return [];
        }
        this.asyncAgents.add(id);
        if (this.knownAgents.has(id)) {
          return [];
        }
        this.knownAgents.add(id);
        return [{
          kind: "agent",
          op: "start",
          toolUseId: id,
          agentType: typeof message.subagent_type === "string" ? message.subagent_type : "agent",
          description: typeof message.description === "string" ? message.description : ""
        }];
      }
      case "task_notification": {
        const id = typeof message.tool_use_id === "string" ? message.tool_use_id : "";
        if (id.length === 0 || !this.knownAgents.has(id)) {
          return [];
        }
        this.knownAgents.delete(id);
        this.asyncAgents.delete(id);
        return [{
          kind: "agent",
          op: "end",
          toolUseId: id,
          outcome: message.status === "completed" ? "ok" : "failed"
        }];
      }
      default:
        return [];
    }
  }

  /** Only a subagent's own tool calls surface, as board activity lines. */
  private parseSubagent(parentId: string, message: JsonRecord): ClaudeEvent[] {
    if (message.type !== "assistant" || !this.knownAgents.has(parentId) || !isRecord(message.message)) {
      return [];
    }
    const content = message.message.content;
    if (!Array.isArray(content)) {
      return [];
    }
    const tool = content
      .filter(isRecord)
      .find((block) => block.type === "tool_use" && typeof block.name === "string");
    if (!tool) {
      return [];
    }
    const name = tool.name as string;
    const summary = summarizeToolInput(name, tool.input);
    return [{ kind: "agent", op: "activity", toolUseId: parentId, detail: summary ? `${name} ${summary}` : name }];
  }

  private parseStreamEvent(message: JsonRecord): ClaudeEvent[] {
    const event = message.event;
    if (!isRecord(event)) {
      return [];
    }

    if (event.type === "message_start" && isRecord(event.message)) {
      // The Companion runs Claude with --print, which never renders a status
      // line, so the usage in this stream is the only context signal available.
      const used = usedContextTokens(event.message.usage);
      if (typeof event.message.model === "string" && this.model.length === 0) {
        this.model = event.message.model;
      }
      return used === undefined
        ? []
        : [{ kind: "context", usedTokens: used, windowTokens: this.contextWindow, model: this.model }];
    }

    if (event.type === "content_block_start" && isRecord(event.content_block)) {
      const block = event.content_block;
      if (block.type === "thinking") {
        return this.phase("thinking");
      }
      if (block.type === "text") {
        // A fresh text block after earlier output is a new paragraph.
        if (this.emittedStreamText && this.lastStreamTextEnd !== "\n") {
          this.lastStreamTextEnd = "\n";
          return [...this.phase("responding"), { kind: "text", text: "\n\n" }];
        }
        return this.phase("responding");
      }
      if (block.type === "tool_use" && typeof block.name === "string") {
        return this.phase("tool", block.name);
      }
      return [];
    }

    if (event.type === "content_block_delta" && isRecord(event.delta)) {
      if (event.delta.type === "text_delta" && typeof event.delta.text === "string") {
        this.hasPartialAssistantText = true;
        if (event.delta.text.length > 0) {
          this.emittedStreamText = true;
          this.lastStreamTextEnd = event.delta.text.slice(-1);
        }
        return [...this.phase("responding"), { kind: "text", text: event.delta.text }];
      }
      return [];
    }

    if (event.type === "message_delta" && isRecord(event.delta)) {
      // `tool_use` means Claude keeps working; only `end_turn` hands back control.
      return event.delta.stop_reason === "end_turn" ? this.phase("waiting") : [];
    }

    return [];
  }

  private parseAssistant(message: JsonRecord): ClaudeEvent[] {
    if (!isRecord(message.message)) {
      return [];
    }
    const content = message.message.content;

    // Refine the tool label once the full input has arrived, e.g. `Read package.json`.
    if (Array.isArray(content)) {
      const tools = content
        .filter(isRecord)
        .filter((block) => block.type === "tool_use" && typeof block.name === "string");
      // Task/Agent tool calls open board rows; synchronous CLIs have no
      // task_started, so the tool_use block is their only start signal.
      const agentEvents: ClaudeEvent[] = [];
      for (const block of tools) {
        if (!/^(task|agent)$/iu.test(block.name as string) || typeof block.id !== "string" || this.knownAgents.has(block.id)) {
          continue;
        }
        const input = isRecord(block.input) ? block.input : {};
        this.knownAgents.add(block.id);
        agentEvents.push({
          kind: "agent",
          op: "start",
          toolUseId: block.id,
          agentType: typeof input.subagent_type === "string" ? input.subagent_type : "agent",
          description: typeof input.description === "string" ? input.description : ""
        });
      }
      const tool = tools[0];
      if (tool) {
        const name = tool.name as string;
        const summary = summarizeToolInput(name, tool.input);
        return [...agentEvents, ...this.phase("tool", summary ? `${name} ${summary}` : name)];
      }
    }

    // Partial deltas already rendered this text; emitting again would duplicate it.
    if (this.hasPartialAssistantText) {
      this.hasPartialAssistantText = false;
      return [];
    }
    const text = textBlocks(content);
    return text.length > 0 ? [{ kind: "text", text: `${text}\n` }] : [];
  }

  private parseUser(message: JsonRecord): ClaudeEvent[] {
    if (!isRecord(message.message) || !Array.isArray(message.message.content)) {
      return [];
    }
    const results = message.message.content
      .filter(isRecord)
      .filter((block) => block.type === "tool_result");
    if (results.length === 0) {
      return [];
    }
    // Synchronous agents end with their tool_result. Async ones sit in
    // asyncAgents — their tool_result is only a launch ack, and completion
    // arrives later as task_notification.
    const agentEvents: ClaudeEvent[] = [];
    for (const block of results) {
      const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      if (id.length === 0 || !this.knownAgents.has(id) || this.asyncAgents.has(id)) {
        continue;
      }
      this.knownAgents.delete(id);
      agentEvents.push({
        kind: "agent",
        op: "end",
        toolUseId: id,
        outcome: block.is_error === true ? "failed" : "ok"
      });
    }
    // The tool finished; Claude goes back to the model with its output.
    return [...agentEvents, ...this.phase("requesting")];
  }
}
