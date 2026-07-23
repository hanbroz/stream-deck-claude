import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";

import { isSafeClaudeSessionId } from "../shared/claude-command";

/**
 * Reads a saved Claude conversation for display when Code Start resumes it.
 *
 * A transcript can be tens of MB, but almost all of that is base64 attachments.
 * This streams the file line by line and keeps only user/assistant text, so the
 * cached history is a few hundred KB at most and the renderer pages through it
 * rather than loading everything at once.
 */
export type HistoryRole = "user" | "assistant";

export type HistoryMessage = {
  role: HistoryRole;
  text: string;
};

export type HistoryPage = {
  messages: HistoryMessage[];
  total: number;
  /** True when older messages remain above this page. */
  hasMore: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Pull display text from a message's content. Thinking and tool internals are
 * dropped to match the live Console; images become a short placeholder so a
 * turn that was only an image still shows.
 */
function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  let imageCount = 0;
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "image") {
      imageCount += 1;
    }
  }
  const text = parts.join("").trim();
  if (imageCount > 0) {
    return text.length > 0 ? `${text}\n[이미지 ${imageCount}장]` : `[이미지 ${imageCount}장]`;
  }
  return text;
}

function claudeProjectDirectoryName(folder: string): string {
  return folder.replace(/[^a-zA-Z0-9]/g, "-");
}

function transcriptPath(configDir: string, folder: string, sessionId: string): string {
  return path.join(
    configDir,
    "projects",
    claudeProjectDirectoryName(folder),
    `${sessionId}.jsonl`
  );
}

/**
 * Stream the transcript and return every user/assistant message that carries
 * display text. Bounded memory: only the compact result is held, never the raw
 * file.
 */
export async function readConversationMessages(
  transcriptFile: string
): Promise<HistoryMessage[]> {
  const messages: HistoryMessage[] = [];
  const stream = createReadStream(transcriptFile, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record) || (record.type !== "user" && record.type !== "assistant")) {
      continue;
    }
    const message = record.message;
    if (!isRecord(message) || (message.role !== "user" && message.role !== "assistant")) {
      continue;
    }
    const text = extractText(message.content);
    if (text.length > 0) {
      messages.push({ role: message.role as HistoryRole, text });
    }
  }

  return messages;
}

export type ConversationHistoryReaderOptions = {
  configDir: string;
  folder: string;
};

/**
 * Loads a conversation once and serves it to the renderer newest-page-first.
 * The parsed text is cached per session id so scrolling up does not re-read the
 * file.
 */
export class ConversationHistoryReader {
  private readonly configDir: string;
  private readonly folder: string;
  private cache = new Map<string, HistoryMessage[]>();

  constructor(options: ConversationHistoryReaderOptions) {
    this.configDir = options.configDir;
    this.folder = options.folder;
  }

  /**
   * A window of messages counted from the end. `offset` is how many messages
   * from the newest to skip; `limit` is the window size. Older messages sit at
   * lower indices, so a page and the one before it are contiguous.
   */
  async page(sessionId: string, offset: number, limit: number): Promise<HistoryPage> {
    const messages = await this.load(sessionId);
    const total = messages.length;
    const safeOffset = Math.max(0, Math.min(offset, total));
    const end = total - safeOffset;
    const start = Math.max(0, end - limit);
    return {
      messages: messages.slice(start, end),
      total,
      hasMore: start > 0
    };
  }

  private async load(sessionId: string): Promise<HistoryMessage[]> {
    const cached = this.cache.get(sessionId);
    if (cached) {
      return cached;
    }
    // Strict allowlist: the id becomes a filename segment, so anything outside
    // a UUID-like token (including `/`, `\`, `..`, `:`) is rejected outright.
    if (!isSafeClaudeSessionId(sessionId)) {
      return [];
    }
    const file = transcriptPath(this.configDir, this.folder, sessionId);
    try {
      await stat(file);
    } catch {
      this.cache.set(sessionId, []);
      return [];
    }
    const messages = await readConversationMessages(file);
    this.cache.set(sessionId, messages);
    return messages;
  }
}
