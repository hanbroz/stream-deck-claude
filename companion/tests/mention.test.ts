import { describe, expect, it } from "vitest";

import { applyMention, filterMentionFiles, mentionQueryAt } from "../shared/mention";

describe("mentionQueryAt", () => {
  it("finds the @token the caret is completing", () => {
    expect(mentionQueryAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQueryAt("read @sam", 9)).toEqual({ start: 5, query: "sam" });
    expect(mentionQueryAt("첫 줄\n@src/ma", 11)).toEqual({ start: 4, query: "src/ma" });
  });

  it("stays quiet when the caret is not inside an @token", () => {
    expect(mentionQueryAt("plain text", 10)).toBeNull();
    expect(mentionQueryAt("mail@example", 12)).toBeNull(); // no boundary before @
    expect(mentionQueryAt("@done ", 6)).toBeNull(); // token already closed by space
    expect(mentionQueryAt("@a @b", 2)).toEqual({ start: 0, query: "a" }); // caret in first token
  });
});

describe("applyMention", () => {
  it("replaces the token with the picked path and moves the caret after it", () => {
    const applied = applyMention("read @sam please", { start: 5, query: "sam" }, 9, "sample.txt");
    expect(applied.text).toBe("read @sample.txt  please");
    expect(applied.caret).toBe("read @sample.txt ".length);
  });
});

describe("filterMentionFiles", () => {
  const files = ["src/main.ts", "sample.txt", "docs/sample-notes.md", "readme.md"];

  it("prefers file-name prefix matches, then path substring matches", () => {
    expect(filterMentionFiles(files, "sam")).toEqual([
      "sample.txt",
      "docs/sample-notes.md"
    ]);
    expect(filterMentionFiles(files, "src/")).toEqual(["src/main.ts"]);
    expect(filterMentionFiles(files, "")).toHaveLength(4);
    expect(filterMentionFiles(files, "nope")).toEqual([]);
  });
});
