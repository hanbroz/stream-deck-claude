import { describe, expect, it } from "vitest";

import { adjustSplitForKey, clampSplit } from "../renderer/splitter";

describe("splitter helpers", () => {
  it("clamps pointer values to the configured range", () => {
    expect(clampSplit(120, 210, 380)).toBe(210);
    expect(clampSplit(450, 210, 380)).toBe(380);
    expect(clampSplit(Number.NaN, 210, 380)).toBe(210);
  });

  it("maps keyboard arrows to the active splitter orientation", () => {
    expect(adjustSplitForKey("ArrowLeft", "vertical", 260, 210, 380)).toBe(244);
    expect(adjustSplitForKey("ArrowDown", "horizontal", 280, 180, 640)).toBe(296);
    expect(adjustSplitForKey("ArrowUp", "vertical", 260, 210, 380)).toBeUndefined();
    expect(adjustSplitForKey("Home", "horizontal", 400, 180, 640)).toBe(180);
    expect(adjustSplitForKey("End", "horizontal", 400, 180, 640)).toBe(640);
  });
});
