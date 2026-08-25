import { describe, expect, it } from "vitest";
import {
  AUTO_COMPACT_AT_PERCENT,
  PASTE_ATTACH_MAX_CHARS,
  PASTE_ATTACH_MIN_LINES,
  addComposerImages,
  addComposerPaste,
  clampPasteText,
  composeOutgoingText,
  countLines,
  createComposerState,
  imageId,
  looksLikeCompletedMilestone,
  navigateHistory,
  pushHistory,
  removeComposerImage,
  removeComposerPaste,
  setComposerText,
  setComposing,
  shouldAttachPaste,
  shouldAutoCompact,
  shouldRecallHistory,
  shouldSubmitFromKeyboard,
  submitComposer
} from "../shared/composer";

describe("composer", () => {
  it("submits trimmed multiline text and clears the draft", () => {
    const state = setComposerText(createComposerState(), "  첫 줄\n둘째 줄  ");

    const result = submitComposer(state);

    expect(result.intent).toEqual({ text: "첫 줄\n둘째 줄", images: [], pastes: [] });
    expect(result.state).toEqual(createComposerState());
  });

  it("compacts only while idle and waiting for the user", () => {
    // Relative to the constant, not a copy of it: the threshold is a tuning
    // knob, and a test that restates the number fails on every retune while
    // proving nothing about the behaviour it is meant to pin down.
    const idle = {
      percentage: AUTO_COMPACT_AT_PERCENT + 2,
      armed: true,
      busy: false,
      queuedCount: 0,
      compacting: false,
      hasSession: true
    };

    expect(shouldAutoCompact(idle)).toBe(true);
    // Exactly at the mark still fires; just under it does not.
    expect(shouldAutoCompact({ ...idle, percentage: AUTO_COMPACT_AT_PERCENT })).toBe(true);
    expect(shouldAutoCompact({ ...idle, percentage: AUTO_COMPACT_AT_PERCENT - 1 })).toBe(false);
    expect(shouldAutoCompact({ ...idle, percentage: undefined })).toBe(false);
    // Mid-conversation — the whole point is not to land between a question and
    // its answer, or on top of a message the user already queued.
    expect(shouldAutoCompact({ ...idle, busy: true })).toBe(false);
    expect(shouldAutoCompact({ ...idle, queuedCount: 1 })).toBe(false);
    expect(shouldAutoCompact({ ...idle, compacting: true })).toBe(false);
    expect(shouldAutoCompact({ ...idle, hasSession: false })).toBe(false);
    // The latch: a compaction that freed too little must not loop.
    expect(shouldAutoCompact({ ...idle, armed: false })).toBe(false);
  });

  it("pins the compaction mark, because the number itself is the cost contract", () => {
    // The assertions above are relative to the constant, so they hold for ANY
    // value — 0 (compact every turn) and 450 (never compact, the meter clamps
    // at 100) both passed the whole suite. What the prefix costs is decided by
    // this number, so the number is what has to be pinned. Changing it means
    // re-measuring and updating the rationale in DESIGN.md.
    expect(AUTO_COMPACT_AT_PERCENT).toBe(45);
  });

  it("caps an oversized paste and reports what it dropped", () => {
    const under = "x".repeat(PASTE_ATTACH_MAX_CHARS);
    expect(clampPasteText(under)).toEqual({ text: under, dropped: 0 });

    const over = "y".repeat(PASTE_ATTACH_MAX_CHARS + 1234);
    const clamped = clampPasteText(over);
    expect(clamped.dropped).toBe(1234);
    expect(clamped.text.startsWith("y".repeat(PASTE_ATTACH_MAX_CHARS))).toBe(true);
    // The notice has to survive into the body: `--resume` carries the
    // attachment in every later prefix, so a silent truncation would read as
    // the whole file for the rest of the conversation.
    expect(clamped.text).toContain("잘림");
  });

  it("offers a fresh conversation only when a milestone actually finished", () => {
    expect(looksLikeCompletedMilestone("커밋과 푸시를 완료했습니다.")).toBe(true);
    expect(looksLikeCompletedMilestone("빌드가 성공적으로 끝났습니다.")).toBe(true);
    expect(looksLikeCompletedMilestone("Committed and pushed. Done.")).toBe(true);

    // A plan is not a milestone — this is the false positive worth avoiding.
    expect(looksLikeCompletedMilestone("이제 커밋할까요?")).toBe(false);
    expect(looksLikeCompletedMilestone("커밋 메시지를 어떻게 쓸지 정해주세요.")).toBe(false);
    // Completion without a milestone is just an ordinary reply.
    expect(looksLikeCompletedMilestone("확인 완료했습니다.")).toBe(false);

    // Only the tail counts: an early mention must not label the whole reply.
    const longReply = `커밋을 완료했습니다.\n${"본문 ".repeat(500)}\n무엇을 도와드릴까요?`;
    expect(looksLikeCompletedMilestone(longReply)).toBe(false);
  });

  it("recalls history only from an empty box, but keeps walking once started", () => {
    const history = ["첫 메시지", "둘째 메시지"];
    const atDraft = { historyIndex: history.length, historyLength: history.length };

    // Empty box: Up starts the recall.
    expect(shouldRecallHistory({ draft: "", ...atDraft })).toBe(true);
    // Mid-draft: Up belongs to the caret, not to history. This is the report —
    // it used to fire whenever the caret sat on the first line.
    expect(shouldRecallHistory({ draft: "쓰는 중", ...atDraft })).toBe(false);
    // Already recalling: the box holds a past message, so an empty-only rule
    // would make history exactly one step deep.
    expect(shouldRecallHistory({ draft: history[1], historyIndex: 1, historyLength: 2 })).toBe(true);
    // Editing a recalled entry resets historyIndex to the draft slot, which
    // hands Up back to the caret.
    expect(shouldRecallHistory({ draft: "둘째 메시지 수정", ...atDraft })).toBe(false);
  });

  it("attaches a paste only once it is long enough to bury the draft", () => {
    const short = Array.from({ length: PASTE_ATTACH_MIN_LINES - 1 }, (_, i) => `line ${i}`).join("\n");
    const long = Array.from({ length: PASTE_ATTACH_MIN_LINES }, (_, i) => `line ${i}`).join("\n");

    expect(shouldAttachPaste(short)).toBe(false);
    expect(shouldAttachPaste(long)).toBe(true);
    // A short paste stays editable in the box; only the threshold decides.
    expect(countLines("")).toBe(0);
    expect(countLines("one")).toBe(1);
    expect(countLines("a\r\nb\rc\nd")).toBe(4);
  });

  it("sends an attachment even with nothing typed, and keeps it out of intent.text", () => {
    const paste = { id: "p1", text: "line 1\nline 2", lineCount: 2 };
    const state = addComposerPaste(createComposerState(), paste);

    const result = submitComposer(state);

    // Slash detection and the input history read intent.text, so the pasted
    // body must not be folded into it.
    expect(result.intent?.text).toBe("");
    expect(result.intent?.pastes).toEqual([paste]);
    expect(result.state).toEqual(createComposerState());
  });

  it("folds attachments into the outgoing body, typed text first", () => {
    const state = addComposerPaste(
      addComposerPaste(setComposerText(createComposerState(), "이 로그 좀 봐줘"), {
        id: "p1",
        text: "first",
        lineCount: 1
      }),
      { id: "p2", text: "second", lineCount: 2 }
    );

    const intent = submitComposer(state).intent;

    expect(intent && composeOutgoingText(intent)).toBe(
      "이 로그 좀 봐줘\n\n[붙여넣은 텍스트 #1 · 1줄]\nfirst\n\n[붙여넣은 텍스트 #2 · 2줄]\nsecond"
    );
  });

  it("drops a removed attachment from the outgoing body", () => {
    const state = addComposerPaste(createComposerState(), { id: "p1", text: "gone", lineCount: 1 });

    const intent = submitComposer(removeComposerPaste(state, "p1")).intent;

    expect(intent).toBeUndefined(); // nothing typed, nothing attached
  });

  it("does not submit while IME composition is active", () => {
    const state = setComposing(setComposerText(createComposerState(), "한"), true);

    expect(shouldSubmitFromKeyboard({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(submitComposer(state).intent).toBeUndefined();
  });

  it("keeps pasted images deduplicated and removable", () => {
    const image = {
      id: imageId("screen.png", 10, 20),
      name: "screen.png",
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,abc"
    };
    const withImages = addComposerImages(createComposerState(), [image, image]);

    expect(withImages.images).toHaveLength(1);
    expect(removeComposerImage(withImages, image.id).images).toEqual([]);
  });

  it("uses Enter to send and Shift+Enter for multiline input", () => {
    expect(shouldSubmitFromKeyboard({ key: "Enter", shiftKey: false, isComposing: false })).toBe(true);
    expect(shouldSubmitFromKeyboard({ key: "Enter", shiftKey: true, isComposing: false })).toBe(false);
    expect(shouldSubmitFromKeyboard({ key: "A", shiftKey: false, isComposing: false })).toBe(false);
  });
});

describe("input history", () => {
  it("appends non-blank entries and skips immediate duplicates", () => {
    const h: string[] = [];
    pushHistory(h, "first");
    pushHistory(h, "  ");     // blank
    pushHistory(h, "first");  // dup of last
    pushHistory(h, "second");
    expect(h).toEqual(["first", "second"]);
  });

  it("recalls older entries with Up and returns to the draft with Down", () => {
    const h = ["a", "b", "c"];
    const draft = "typing…";
    // start at the draft slot (index === length)
    let step = navigateHistory(h, 3, draft, "up");
    expect(step).toEqual({ index: 2, text: "c" });
    step = navigateHistory(h, step!.index, draft, "up");
    expect(step).toEqual({ index: 1, text: "b" });
    // Down walks forward and restores the draft at the end
    step = navigateHistory(h, 2, draft, "down");
    expect(step).toEqual({ index: 3, text: draft });
  });

  it("stops at the ends instead of wrapping", () => {
    const h = ["only"];
    expect(navigateHistory(h, 0, "", "up")).toBeNull();     // already oldest
    expect(navigateHistory(h, 1, "", "down")).toBeNull();   // already at draft
    expect(navigateHistory([], 0, "", "up")).toBeNull();    // empty history
  });
});
