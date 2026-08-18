import { describe, expect, it } from "vitest";
import {
  createTargetFor,
  mergeFreshChildren,
  projectRelativePath,
  refreshLoadedTree,
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

  it("refreshes every opened folder from anywhere, skipping unopened ones", async () => {
    const listed: string[] = [];
    // docs was opened before the file landed there; vendor was never opened;
    // src is loaded but collapsed.
    const previous: TreeNode[] = [
      {
        id: "docs", name: "docs", path: "C:\\work\\docs", kind: "directory",
        expanded: true, loaded: true,
        children: [{ id: "old", name: "old.html", path: "C:\\work\\docs\\old.html", kind: "file" }]
      },
      { id: "src", name: "src", path: "C:\\work\\src", kind: "directory", loaded: true, children: [] },
      { id: "vendor", name: "vendor", path: "C:\\work\\vendor", kind: "directory" }
    ];
    const disk: Record<string, TreeNode[]> = {
      "C:\\work": [
        { id: "docs", name: "docs", path: "C:\\work\\docs", kind: "directory" },
        { id: "src", name: "src", path: "C:\\work\\src", kind: "directory" },
        { id: "vendor", name: "vendor", path: "C:\\work\\vendor", kind: "directory" }
      ],
      // The file a git merge dropped in while the app sat idle.
      "C:\\work\\docs": [
        { id: "new", name: "new.html", path: "C:\\work\\docs\\new.html", kind: "file" },
        { id: "old", name: "old.html", path: "C:\\work\\docs\\old.html", kind: "file" }
      ],
      "C:\\work\\src": []
    };

    const refreshed = await refreshLoadedTree("C:\\work", previous, async (directoryPath) => {
      listed.push(directoryPath);
      const entries = disk[directoryPath];
      if (!entries) {
        throw new Error(`unreadable: ${directoryPath}`);
      }
      return entries;
    });

    // The whole point: a refresh reaches a nested folder nobody clicked on.
    const docs = refreshed.find((node) => node.name === "docs");
    expect(docs?.children?.map((child) => child.name)).toEqual(["new.html", "old.html"]);
    expect(docs).toMatchObject({ expanded: true, loaded: true });
    // An unopened folder is left alone — descending would scan the project.
    expect(listed).not.toContain("C:\\work\\vendor");
    expect(listed.sort()).toEqual(["C:\\work", "C:\\work\\docs", "C:\\work\\src"]);
  });

  it("keeps a folder's entries when only that folder fails to re-list", async () => {
    const previous: TreeNode[] = [
      {
        id: "docs", name: "docs", path: "C:\\work\\docs", kind: "directory",
        expanded: true, loaded: true,
        children: [{ id: "keep", name: "keep.html", path: "C:\\work\\docs\\keep.html", kind: "file" }]
      }
    ];

    const refreshed = await refreshLoadedTree("C:\\work", previous, async (directoryPath) => {
      if (directoryPath === "C:\\work\\docs") {
        throw new Error("deleted mid-refresh");
      }
      return [{ id: "docs", name: "docs", path: "C:\\work\\docs", kind: "directory" }];
    });

    expect(refreshed[0].children?.map((child) => child.name)).toEqual(["keep.html"]);
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

  it("copies paths as './' project-relative, forward-slashed", () => {
    expect(projectRelativePath("C:\\work", "C:\\work\\src\\index.ts")).toBe("./src/index.ts");
    expect(projectRelativePath("C:\\work\\", "C:\\work\\src")).toBe("./src");
    // The root folder itself is the project root.
    expect(projectRelativePath("C:\\work", "C:\\work")).toBe("./");
    // Drive-letter case differs between the tree and the runtime folder often
    // enough that a case-sensitive compare would emit absolute paths instead.
    expect(projectRelativePath("c:\\work", "C:\\work\\a.txt")).toBe("./a.txt");
    // A sibling whose name merely starts with the root's is not inside it.
    expect(projectRelativePath("C:\\work", "C:\\workspace\\a.txt")).toBe("C:/workspace/a.txt");
  });
});
