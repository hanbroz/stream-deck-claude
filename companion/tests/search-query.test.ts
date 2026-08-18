import { describe, expect, it } from "vitest";

import {
  MAX_QUERY_LENGTH,
  queryLengthVerdict
} from "../shared/search-query";

describe("queryLengthVerdict", () => {
  it("rejects queries below the minimum", () => {
    expect(queryLengthVerdict("a")).toBe("too-short");
    expect(queryLengthVerdict("   ")).toBe("too-short");
  });

  it("rejects queries past the maximum", () => {
    expect(queryLengthVerdict("x".repeat(MAX_QUERY_LENGTH + 1))).toBe("too-long");
  });

  it("accepts the boundaries and measures the trimmed query", () => {
    expect(queryLengthVerdict("ab")).toBe("ok");
    expect(queryLengthVerdict("x".repeat(MAX_QUERY_LENGTH))).toBe("ok");
    // Trailing space must not push an otherwise valid query over the edge.
    expect(queryLengthVerdict("x".repeat(MAX_QUERY_LENGTH) + " ")).toBe("ok");
  });
});
