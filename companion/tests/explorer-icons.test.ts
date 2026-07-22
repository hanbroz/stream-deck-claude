import { describe, expect, it } from "vitest";

import { explorerChevron, explorerIconPath } from "../renderer/explorer-icons";

describe("Companion explorer icons", () => {
  it("uses a Material Icon Theme folder icon with VS Code chevrons", () => {
    expect(explorerIconPath("src", "directory")).toBe("./assets/material-icons/folder-src.svg");
    expect(explorerIconPath("unknown-folder", "directory")).toBe(
      "./assets/material-icons/folder-base.svg"
    );
    expect(explorerChevron("directory")).toBe("›");
    expect(explorerChevron("directory", true)).toBe("⌄");
    expect(explorerChevron("directory", false, true)).toBe("…");
  });

  it("chooses file icons by well-known names and extensions", () => {
    expect(explorerIconPath("package.json", "file")).toBe("./assets/material-icons/npm.svg");
    expect(explorerIconPath("package-lock.json", "file")).toBe("./assets/material-icons/lock.svg");
    expect(explorerIconPath("main.ts", "file")).toBe("./assets/material-icons/typescript.svg");
    expect(explorerIconPath("README.md", "file")).toBe("./assets/material-icons/markdown.svg");
    expect(explorerIconPath("guide.pdf", "file")).toBe("./assets/material-icons/pdf.svg");
    expect(explorerIconPath("unknown.bin", "file")).toBe("./assets/material-icons/document.svg");
  });

  it("does not render a chevron for files", () => {
    expect(explorerChevron("file")).toBe("");
  });
});
