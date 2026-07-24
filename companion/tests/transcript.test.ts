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

  it("marks Q-labelled blocks even when they end with a dash or colon", () => {
    expect(isQuestionInline([text("Q2. 개별 주소 vs 도메인을 UI에서 구분하는 방식 —")])).toBe(true);
    expect(isQuestionInline([{ type: "bold", text: "Q10)" }, text(" 다음 항목 중 선택:")])).toBe(true);
    // A plain word starting with Q is not a label.
    expect(isQuestionInline([text("Quality가 중요합니다.")])).toBe(false);
  });

  it("leaves statements and mid-text question marks unhighlighted", () => {
    expect(isQuestionInline([text("작업을 완료했습니다.")])).toBe(false);
    expect(isQuestionInline([text("무엇을 할까? 라는 고민 끝에 진행했습니다.")])).toBe(false);
    expect(isQuestionInline([])).toBe(false);
  });
});
