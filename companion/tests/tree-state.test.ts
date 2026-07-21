import { describe, expect, it } from "vitest";
import {
  createTargetFor,
  replaceRoots,
  setNodeChildren,
  setNodeExpanded,
  visibleTreeRows,
  type TreeNode
} from "../shared/tree-state";

const roots: TreeNode[] = [
  { id: "b", name: "zeta.txt", path: "C:\\work\\zeta.txt", kind: "file" },
  { id: "a", name: "src", path: "C:\\work\\src", kind: "directory" }
];

describe("tree-state", () => {
  it("sorts directories before files and exposes only expanded lazy children", () => {
    let state = replaceRoots(roots);

    expect(visibleTreeRows(state).map((row) => row.node.name)).toEqual(["src", "zeta.txt"]);

    state = setNodeExpanded(state, "C:\\work\\src", true);
    expect(visibleTreeRows(state).map((row) => row.node.name)).toEqual(["src", "zeta.txt"]);

    state = setNodeChildren(state, "C:\\work\\src", [
      { id: "index", name: "index.ts", path: "C:\\work\\src\\index.ts", kind: "file" },
      { id: "app", name: "app", path: "C:\\work\\src\\app", kind: "directory" }
    ]);

    expect(visibleTreeRows(state).map((row) => `${row.depth}:${row.node.name}`)).toEqual([
      "0:src",
      "1:app",
      "1:index.ts",
      "0:zeta.txt"
    ]);
  });

  it("creates sanitized child and sibling targets with VS Code-style defaults", () => {
    const directory = { id: "src", name: "src", path: "C:\\work\\src", kind: "directory" } satisfies TreeNode;
    const file = { id: "file", name: "old.ts", path: "C:\\work\\src\\old.ts", kind: "file" } satisfies TreeNode;

    expect(createTargetFor(directory, "file", " app:main?.ts ", true)).toEqual({
      parentPath: "C:\\work\\src",
      kind: "file",
      name: "app-main-.ts"
    });
    expect(createTargetFor(file, "directory", "components", false)).toEqual({
      parentPath: "C:\\work\\src",
      kind: "directory",
      name: "components"
    });
  });
});
