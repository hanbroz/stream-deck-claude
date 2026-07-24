import { describe, expect, it } from "vitest";

import { parseQuestionBlock, QUESTION_SYSTEM_PROMPT } from "../shared/question-block";
import { createClaudeCommandArgs } from "../shared/claude-command";

describe("parseQuestionBlock", () => {
  it("parses a valid question block and trims entries", () => {
    expect(parseQuestionBlock('{"question": " 진행할까요? ", "options": [" 네 ", "아니오"]}')).toEqual({
      question: "진행할까요?",
      options: ["네", "아니오"]
    });
  });

  it("caps the options at six and drops blank ones", () => {
    const options = ["a", "b", " ", "c", "d", "e", "f", "g"];
    const parsed = parseQuestionBlock(JSON.stringify({ question: "q", options }));
    expect(parsed?.options).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("rejects malformed payloads so they fall back to a code block", () => {
    expect(parseQuestionBlock("not json")).toBeNull();
    expect(parseQuestionBlock('{"question": "q", "options": ["only-one"]}')).toBeNull();
    expect(parseQuestionBlock('{"question": "", "options": ["a", "b"]}')).toBeNull();
    expect(parseQuestionBlock('{"options": ["a", "b"]}')).toBeNull();
    expect(parseQuestionBlock('[1, 2]')).toBeNull();
  });
});

describe("question protocol wiring", () => {
  it("appends the question-block instruction to every per-message run", () => {
    const args = createClaudeCommandArgs({ cwd: "D:\\repo" });
    const flag = args.indexOf("--append-system-prompt");
    expect(flag).toBeGreaterThan(-1);
    expect(args[flag + 1]).toBe(QUESTION_SYSTEM_PROMPT);
  });
});
