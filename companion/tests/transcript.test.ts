import { describe, expect, it } from "vitest";

import { isQuestionInline } from "../renderer/transcript";
import type { InlineNode } from "../shared/markdown";

const text = (value: string): InlineNode => ({ type: "text", text: value });

describe("isQuestionInline", () => {
  it("marks blocks whose visible text ends with a question mark", () => {
    expect(isQuestionInline([text("커밋을 진행할까요?")])).toBe(true);
    expect(isQuestionInline([text("전각 물음표도 인식합니다？")])).toBe(true);
    // Trailing whitespace and split inline nodes (bold + text) still count.
    expect(isQuestionInline([{ type: "bold", text: "이 방식" }, text("이 맞나요?  ")])).toBe(true);
  });

  it("leaves statements and mid-text question marks unhighlighted", () => {
    expect(isQuestionInline([text("작업을 완료했습니다.")])).toBe(false);
    expect(isQuestionInline([text("무엇을 할까? 라는 고민 끝에 진행했습니다.")])).toBe(false);
    expect(isQuestionInline([])).toBe(false);
  });
});
