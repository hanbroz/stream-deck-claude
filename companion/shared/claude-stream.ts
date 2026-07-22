type JsonRecord = Record<string, unknown>;

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

function outputFromMessage(message: unknown): string {
  if (!isRecord(message) || typeof message.type !== "string") {
    return "";
  }

  if (message.type === "stream_event" && isRecord(message.event)) {
    const event = message.event;
    if (event.type !== "content_block_delta" || !isRecord(event.delta)) {
      return "";
    }
    return event.delta.type === "text_delta" && typeof event.delta.text === "string"
      ? event.delta.text
      : "";
  }

  if (message.type === "assistant" && isRecord(message.message)) {
    const text = textBlocks(message.message.content);
    return text.length > 0 ? `${text}\n` : "";
  }

  if (message.type === "result" && message.is_error === true && typeof message.result === "string") {
    return `[Claude Code error] ${message.result}\n`;
  }

  return "";
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

export class ClaudeStreamParser {
  private buffer = "";
  private hasPartialAssistantText = false;

  push(data: string): string {
    this.buffer += data;
    const lines = this.buffer.split(/\r?\n/u);
    this.buffer = lines.pop() ?? "";
    return lines.map((line) => this.parseLine(line)).join("");
  }

  flush(): string {
    const line = this.buffer;
    this.buffer = "";
    return this.parseLine(line);
  }

  private parseLine(line: string): string {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return "";
    }
    try {
      const message = JSON.parse(trimmed) as unknown;
      if (isRecord(message) && message.type === "stream_event") {
        const output = outputFromMessage(message);
        if (output.length > 0) {
          this.hasPartialAssistantText = true;
        }
        return output;
      }
      if (isRecord(message) && message.type === "assistant" && this.hasPartialAssistantText) {
        this.hasPartialAssistantText = false;
        return "";
      }
      return outputFromMessage(message);
    } catch {
      // PTY line echo and Claude diagnostics are intentionally not rendered as conversation.
      return "";
    }
  }
}
