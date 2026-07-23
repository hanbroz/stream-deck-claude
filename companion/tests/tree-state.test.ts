import { describe, expect, it } from "vitest";
import {
  createTargetFor,
  mergeFreshChildren,
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

  it("keeps expanded state and children when merging a fresh listing", () => {
    const previous: TreeNode[] = [
      {
        id: "src", name: "src", path: "C:\\work\\src", kind: "directory",
        expanded: true, loaded: true,
        children: [{ id: "i", name: "index.ts", path: "C:\\work\\src\\index.ts", kind: "file" }]
      },
      { id: "gone", name: "gone.txt", path: "C:\\work\\gone.txt", kind: "file" }
    ];
    const fresh: TreeNode[] = [
      { id: "src2", name: "src", path: "C:\\work\\src", kind: "directory" },
      { id: "new", name: "new.txt", path: "C:\\work\\new.txt", kind: "file" }
    ];

    const merged = mergeFreshChildren(previous, fresh);

    // Surviving directory keeps its expansion and loaded children…
    expect(merged[0]).toMatchObject({ path: "C:\\work\\src", expanded: true, loaded: true });
    expect(merged[0].children?.map((child) => child.name)).toEqual(["index.ts"]);
    // …deleted entries drop out, new entries appear.
    expect(merged.map((node) => node.name)).toEqual(["src", "new.txt"]);
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
