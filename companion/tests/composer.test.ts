import { describe, expect, it } from "vitest";
import {
  addComposerImages,
  createComposerState,
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
