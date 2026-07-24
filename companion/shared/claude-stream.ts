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

export type ClaudeEvent =
  | { kind: "text"; text: string }
  | { kind: "phase"; phase: ClaudePhase; detail?: string }
  | { kind: "context"; usedTokens: number; windowTokens: number; model: string }
  | { kind: "error"; message: string; missingConversation: boolean };

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
    .join("");
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
  const flat = inline.replace(/\s+/gu, " ").trim();
  return flat.length > 48 ? `${flat.slice(0, 48)}…` : flat;
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

export function isMissingClaudeConversationError(data: string): boolean {
  return /No conversation found with session ID:/iu.test(data);
}

export class ClaudeStreamParser {
  private buffer = "";
  private hasPartialAssistantText = false;
  private ready = false;
  private hooksStarted = 0;
  private hooksDone = 0;
  private lastPhase: ClaudePhase | undefined;
  private lastDetail: string | undefined;
  private model = "";
  private contextWindow = DEFAULT_CONTEXT_WINDOW;
  private sessionId: string | undefined;

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

    switch (message.type) {
      case "system":
        return this.parseSystem(message);
      case "stream_event":
        return this.parseStreamEvent(message);
      case "assistant":
        return this.parseAssistant(message);
      case "user":
        return this.parseUser(message);
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
      default:
        return [];
    }
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
      const tool = content
        .filter(isRecord)
        .find((block) => block.type === "tool_use" && typeof block.name === "string");
      if (tool) {
        const name = tool.name as string;
        const summary = summarizeToolInput(name, tool.input);
        return this.phase("tool", summary ? `${name} ${summary}` : name);
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
    const result = message.message.content
      .filter(isRecord)
      .find((block) => block.type === "tool_result");
    if (!result) {
      return [];
    }
    // The tool finished; Claude goes back to the model with its output.
    return this.phase("requesting");
  }
}
