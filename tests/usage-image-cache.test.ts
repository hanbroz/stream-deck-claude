import { describe, expect, it } from "vitest";

import { UsageImageCache } from "../src/actions/usage-image-cache";

describe("UsageImageCache", () => {
  it("treats a remembered identical image as current", () => {
    const cache = new UsageImageCache();

    expect(cache.isCurrent("action-1", "image-a")).toBe(false);
    cache.remember("action-1", "image-a");
    expect(cache.isCurrent("action-1", "image-a")).toBe(true);
  });

  it("requires an update when the rendered image changes", () => {
    const cache = new UsageImageCache();
    cache.remember("action-1", "image-a");

    expect(cache.isCurrent("action-1", "image-b")).toBe(false);
  });

  it("forgets an image when an action disappears", () => {
    const cache = new UsageImageCache();
    cache.remember("action-1", "image-a");
    cache.forget("action-1");

    expect(cache.isCurrent("action-1", "image-a")).toBe(false);
  });
});
