import { describe, expect, it } from "vitest";

import { parseInline, parseMarkdown } from "../shared/markdown";

describe("inline markdown", () => {
  it("renders emphasis as structure rather than literal asterisks", () => {
    expect(parseInline("보통 **강조** 끝")).toEqual([
      { type: "text", text: "보통 " },
      { type: "bold", text: "강조" },
      { type: "text", text: " 끝" }
    ]);
  });

  it("supports underscore bold and single-marker italics", () => {
    expect(parseInline("__굵게__")).toEqual([{ type: "bold", text: "굵게" }]);
    expect(parseInline("*기울임*")).toEqual([{ type: "italic", text: "기울임" }]);
  });

  it("keeps emphasis markers literal inside code spans", () => {
    expect(parseInline("`**not bold**`")).toEqual([{ type: "code", text: "**not bold**" }]);
  });

  /** snake_case identifiers must not be mistaken for italics. */
  it("leaves underscores inside words alone", () => {
    expect(parseInline("read_file_sync 호출")).toEqual([
      { type: "text", text: "read_file_sync 호출" }
    ]);
  });

  it("returns a single empty node for empty input", () => {
    expect(parseInline("")).toEqual([{ type: "text", text: "" }]);
  });
});

describe("block markdown", () => {
  it("parses headings, paragraphs and lists", () => {
    expect(parseMarkdown("# 제목\n\n본문입니다\n\n- 하나\n- 둘")).toEqual([
      { type: "heading", level: 1, inline: [{ type: "text", text: "제목" }] },
      { type: "paragraph", inline: [{ type: "text", text: "본문입니다" }] },
      {
        type: "list",
        ordered: false,
        items: [[{ type: "text", text: "하나" }], [{ type: "text", text: "둘" }]]
      }
    ]);
  });

  it("keeps fenced code verbatim with its language", () => {
    expect(parseMarkdown("```ts\nconst a = **1**;\n```")).toEqual([
      { type: "code", language: "ts", code: "const a = **1**;" }
    ]);
  });

  /**
   * Assistant text streams in, so a code fence is routinely incomplete when it
   * is rendered. A half-arrived block must still show as code.
   */
  it("renders an unterminated code fence while it is still streaming", () => {
    expect(parseMarkdown("```js\nconst a = 1;")).toEqual([
      { type: "code", language: "js", code: "const a = 1;" }
    ]);
  });

  it("parses ordered lists and blockquotes", () => {
    expect(parseMarkdown("1. 첫째\n2. 둘째")).toEqual([
      {
        type: "list",
        ordered: true,
        items: [[{ type: "text", text: "첫째" }], [{ type: "text", text: "둘째" }]]
      }
    ]);
    expect(parseMarkdown("> 인용")).toEqual([
      { type: "quote", inline: [{ type: "text", text: "인용" }] }
    ]);
  });

  it("does not emit blocks for blank input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n")).toEqual([]);
  });

  /**
   * The parser never produces markup — the renderer builds text nodes — so HTML
   * in model output stays inert text.
   */
  it("treats HTML in model output as plain text", () => {
    expect(parseMarkdown("<script>alert(1)</script>")).toEqual([
      { type: "paragraph", inline: [{ type: "text", text: "<script>alert(1)</script>" }] }
    ]);
  });
});
