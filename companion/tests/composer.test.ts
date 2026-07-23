import { describe, expect, it } from "vitest";
import {
  addComposerImages,
  createComposerState,
  navigateHistory,
  pushHistory,
  imageId,
  removeComposerImage,
  setComposerText,
  setComposing,
  shouldSubmitFromKeyboard,
  submitComposer
} from "../shared/composer";

describe("composer", () => {
  it("submits trimmed multiline text and clears the draft", () => {
    const state = setComposerText(createComposerState(), "  첫 줄\n둘째 줄  ");

    const result = submitComposer(state);

    expect(result.intent).toEqual({ text: "첫 줄\n둘째 줄", images: [] });
    expect(result.state).toEqual(createComposerState());
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
