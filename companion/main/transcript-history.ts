import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";

import { isSafeClaudeSessionId } from "../shared/claude-command";
import { usedContextTokens } from "../shared/claude-stream";

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

export type LastContextUsage = {
  usedTokens: number;
  model?: string;
};

/**
 * The conversation's last recorded context usage, read from the transcript's
 * tail (bounded 256KB) so a resumed launch can show real numbers on the
 * Stream Deck key before any message of this launch runs.
 */
export async function readLastContextUsage(
  transcriptFile: string
): Promise<LastContextUsage | undefined> {
  let handle;
  try {
    handle = await open(transcriptFile, "r");
  } catch {
    return undefined; // no transcript — nothing to show yet
  }
  try {
    const size = (await handle.stat()).size;
    const length = Math.min(256 * 1024, size);
    if (length === 0) {
      return undefined;
    }
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      let record: unknown;
      try {
        record = JSON.parse(lines[index]);
      } catch {
        continue; // the tail window may start mid-line
      }
      if (!isRecord(record) || record.type !== "assistant" || !isRecord(record.message)) {
        continue;
      }
      const usedTokens = usedContextTokens(record.message.usage);
      if (usedTokens !== undefined) {
        return {
          usedTokens,
          model: typeof record.message.model === "string" ? record.message.model : undefined
        };
      }
    }
    return undefined;
  } finally {
    await handle.close();
  }
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

  /** Last recorded context usage of a saved conversation, if any. */
  async lastContextUsage(sessionId: string): Promise<LastContextUsage | undefined> {
    if (!isSafeClaudeSessionId(sessionId)) {
      return undefined;
    }
    return readLastContextUsage(transcriptPath(this.configDir, this.folder, sessionId));
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
