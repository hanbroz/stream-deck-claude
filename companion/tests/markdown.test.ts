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

describe("paragraph line breaks", () => {
  it("keeps single newlines inside a paragraph (Insight marker lines)", () => {
    const blocks = parseMarkdown(
      "프로젝트를 구성합니다.\n`★ Insight ─────`\n요점 하나\n`─────────`\nNow the build:"
    );
    expect(blocks).toHaveLength(1);
    const paragraph = blocks[0] as { type: "paragraph"; inline: Array<{ type: string; text: string }> };
    expect(paragraph.type).toBe("paragraph");
    // The newlines survive in the text nodes around the code spans, so the
    // pre-wrap renderer shows the marker on its own line.
    expect(paragraph.inline.map((node) => node.text).join("")).toBe(
      "프로젝트를 구성합니다.\n★ Insight ─────\n요점 하나\n─────────\nNow the build:"
    );
    expect(paragraph.inline.some((node) => node.type === "code" && node.text.startsWith("★ Insight"))).toBe(true);
  });
});

describe("tables", () => {
  it("parses a GFM table with inline formatting and alignment", () => {
    const blocks = parseMarkdown([
      "| 항목 | 값 |",
      "|:---|---:|",
      "| **모델** | `opus` |",
      "| 상태 | 대기 |"
    ].join("\n"));

    expect(blocks).toEqual([{
      type: "table",
      header: [
        [{ type: "text", text: "항목" }],
        [{ type: "text", text: "값" }]
      ],
      align: ["left", "right"],
      rows: [
        [[{ type: "bold", text: "모델" }], [{ type: "code", text: "opus" }]],
        [[{ type: "text", text: "상태" }], [{ type: "text", text: "대기" }]]
      ]
    }]);
  });

  it("pads short rows to the header width", () => {
    const blocks = parseMarkdown("| a | b | c |\n|---|---|---|\n| 1 | 2 |");
    const table = blocks[0] as { type: "table"; rows: unknown[][] };
    expect(table.rows[0]).toHaveLength(3);
  });

  it("leaves pipe-containing text without a delimiter row as a paragraph", () => {
    const blocks = parseMarkdown("5h:[----]0% | wk:[----]0%\n일반 문장입니다.");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("paragraph");
  });
});
