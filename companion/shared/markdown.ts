/**
 * Minimal Markdown parser for Claude's assistant output.
 *
 * It returns a data model rather than HTML on purpose: the renderer builds DOM
 * nodes with textContent, so model output can never be executed as markup. Only
 * the subset Claude actually emits is supported — adding a full CommonMark
 * dependency for that subset is not worth the bundle.
 *
 * ponytail: no syntax highlighting yet; code blocks render monospace with a
 * copy button. Add a highlighter only if reading code in the Console proves
 * hard without it.
 */
export type InlineNode =
  | { type: "text"; text: string }
  | { type: "bold"; text: string }
  | { type: "italic"; text: string }
  | { type: "code"; text: string };

export type MarkdownBlock =
  | { type: "paragraph"; inline: InlineNode[] }
  | { type: "heading"; level: number; inline: InlineNode[] }
  | { type: "code"; language: string; code: string }
  | { type: "list"; ordered: boolean; items: InlineNode[][] }
  | { type: "quote"; inline: InlineNode[] };

// Ordered so that code spans win over emphasis: `**x**` inside backticks stays literal.
const INLINE_PATTERN =
  /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|(?<![A-Za-z0-9])[*_]([^*_\n]+?)[*_](?![A-Za-z0-9])/gu;

export function parseInline(source: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let lastIndex = 0;

  for (const match of source.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      nodes.push({ type: "text", text: source.slice(lastIndex, index) });
    }
    if (match[2] !== undefined) {
      nodes.push({ type: "code", text: match[2] });
    } else if (match[3] !== undefined || match[4] !== undefined) {
      nodes.push({ type: "bold", text: (match[3] ?? match[4]) as string });
    } else if (match[5] !== undefined) {
      nodes.push({ type: "italic", text: match[5] });
    }
    lastIndex = index + match[0].length;
  }

  if (lastIndex < source.length) {
    nodes.push({ type: "text", text: source.slice(lastIndex) });
  }
  return nodes.length > 0 ? nodes : [{ type: "text", text: "" }];
}

const FENCE = /^\s{0,3}(?:```|~~~)\s*([A-Za-z0-9_+-]*)\s*$/u;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/u;
const UNORDERED = /^\s*[-*+]\s+(.*)$/u;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/u;
const QUOTE = /^\s{0,3}>\s?(.*)$/u;

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.split(/\r?\n/u);
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ type: "paragraph", inline: parseInline(paragraph.join("\n")) });
      paragraph = [];
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      // An unterminated fence still renders: Claude streams code blocks in parts.
      blocks.push({ type: "code", language: fence[1] ?? "", code: code.join("\n") });
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        type: "heading",
        level: heading[1].length,
        inline: parseInline(heading[2])
      });
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      flushParagraph();
      blocks.push({ type: "quote", inline: parseInline(quote[1]) });
      continue;
    }

    const unordered = UNORDERED.exec(line);
    const ordered = unordered ? null : ORDERED.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const isOrdered = ordered !== null;
      const items: InlineNode[][] = [];
      while (index < lines.length) {
        const itemMatch = isOrdered ? ORDERED.exec(lines[index]) : UNORDERED.exec(lines[index]);
        if (!itemMatch) {
          break;
        }
        items.push(parseInline(itemMatch[1]));
        index += 1;
      }
      index -= 1;
      blocks.push({ type: "list", ordered: isOrdered, items });
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return blocks;
}
