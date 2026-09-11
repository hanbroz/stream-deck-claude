import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findNode, refreshLoadedTree, type TreeNode } from "../shared/tree-state";
import { projectNameFromPath } from "../renderer/labels";

const source = ts.createSourceFile(
  "index.ts",
  readFileSync(new URL("../renderer/index.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true
);

const functionNames = new Set([
  "automaticTreeRefreshPaused",
  "scheduleAutomaticTreeRefresh",
  "flushAutomaticTreeRefresh",
  "refreshTree",
  "performTreeRefresh",
  "projectRootNode",
  "nodeAt",
  "entriesToNodes",
  "entryToNode",
  "cssEscape"
]);

const script = ts.transpileModule(
  source.statements
    .filter((node) => ts.isFunctionDeclaration(node) && node.name && functionNames.has(node.name.text))
    .map((node) => node.getText(source))
    .join("\n"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText;

type DirectoryEntry = { name: string; path: string; isDirectory: boolean };

function file(path: string): DirectoryEntry {
  return { name: path.split("\\").pop() ?? path, path, isDirectory: false };
}

function directory(path: string): DirectoryEntry {
  return { name: path.split("\\").pop() ?? path, path, isDirectory: true };
}

function expandedDirectory(path: string, children: TreeNode[] = []): TreeNode {
  return {
    id: path,
    name: path.split("\\").pop() ?? path,
    path,
    kind: "directory",
    expanded: true,
    loaded: true,
    children
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

function fixture(options: { hidden?: boolean; contextMenuOpen?: boolean; inlineCreate?: boolean; disposed?: boolean } = {}) {
  const renderTree = vi.fn();
  const focus = vi.fn();
  const list = vi.fn<(directoryPath: string) => Promise<DirectoryEntry[]>>();
  const diag = vi.fn();
  const treeElement = {
    scrollTop: 9,
    contains: vi.fn(() => false),
    querySelector: vi.fn((selector: string) => {
      if (selector === ".inline-create") return options.inlineCreate ? {} : null;
      if (selector.startsWith("[data-path=")) return { focus };
      return null;
    })
  };
  const scope = vm.createContext({
    api: { paths: { list } },
    projectRoot: "C:\\work",
    treeRoots: [] as TreeNode[],
    selectedPath: undefined as string | undefined,
    contextPath: undefined as string | undefined,
    treeReady: true,
    treeRefreshChain: Promise.resolve(),
    automaticTreeRefreshPending: false,
    automaticTreeRefreshRunning: false,
    automaticTreeRefreshTimer: undefined,
    treeDisposed: options.disposed ?? false,
    contextMenu: { hidden: !(options.contextMenuOpen ?? false) },
    treeElement,
    dropTargetRow: undefined,
    dropTargetIsRoot: false,
    document: { hidden: options.hidden ?? false, activeElement: undefined },
    window: { CSS: { escape: (value: string) => value.replace(/\\/g, "\\\\") } },
    CSS: { escape: (value: string) => value.replace(/\\/g, "\\\\") },
    setTimeout,
    clearTimeout,
    refreshLoadedTree,
    findNode,
    projectNameFromPath,
    renderTree,
    diag
  });
  vm.runInContext(script, scope);
  return { scope, list, renderTree, treeElement, focus, diag };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("renderer automatic tree refresh", () => {
  it("coalesces multiple filesystem events into one automatic refresh", async () => {
    vi.useFakeTimers();
    const { scope, list, renderTree } = fixture();
    scope.treeRoots = [{ id: "old", name: "old.txt", path: "C:\\work\\old.txt", kind: "file" }];
    list.mockResolvedValue([file("C:\\work\\new.txt")]);

    scope.scheduleAutomaticTreeRefresh(50);
    scope.scheduleAutomaticTreeRefresh(50);
    await vi.advanceTimersByTimeAsync(50);

    expect(list).toHaveBeenCalledTimes(1);
    expect(renderTree).toHaveBeenCalledTimes(1);
    expect(scope.treeRoots.map((node: TreeNode) => node.name)).toEqual(["new.txt"]);
    expect(scope.automaticTreeRefreshPending).toBe(false);
  });

  it("keeps one follow-up refresh pending when events arrive during a running refresh", async () => {
    vi.useFakeTimers();
    const { scope, list, renderTree } = fixture();
    scope.treeRoots = [{ id: "old", name: "old.txt", path: "C:\\work\\old.txt", kind: "file" }];
    const first = createDeferred<DirectoryEntry[]>();
    list.mockReturnValueOnce(first.promise);

    scope.scheduleAutomaticTreeRefresh();
    await vi.advanceTimersByTimeAsync(0);
    scope.scheduleAutomaticTreeRefresh();
    scope.scheduleAutomaticTreeRefresh();
    expect(list).toHaveBeenCalledTimes(1);
    expect(scope.automaticTreeRefreshPending).toBe(true);

    list.mockResolvedValueOnce([file("C:\\work\\new.txt")]);
    first.resolve([file("C:\\work\\old.txt")]);
    await first.promise;
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(700);

    expect(list).toHaveBeenCalledTimes(2);
    expect(renderTree).toHaveBeenCalledTimes(1);
    expect(scope.treeRoots.map((node: TreeNode) => node.name)).toEqual(["new.txt"]);
  });

  it("waits while hidden and refreshes after the document becomes visible", async () => {
    vi.useFakeTimers();
    const { scope, list } = fixture({ hidden: true });
    scope.treeRoots = [];
    list.mockResolvedValue([file("C:\\work\\visible.txt")]);

    scope.scheduleAutomaticTreeRefresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(list).not.toHaveBeenCalled();
    expect(scope.automaticTreeRefreshPending).toBe(true);

    scope.document.hidden = false;
    scope.scheduleAutomaticTreeRefresh();
    await vi.advanceTimersByTimeAsync(0);

    expect(list).toHaveBeenCalledTimes(1);
    expect(scope.treeRoots.map((node: TreeNode) => node.name)).toEqual(["visible.txt"]);
  });

  it("defers automatic refresh while a context menu is open", async () => {
    vi.useFakeTimers();
    const { scope, list, renderTree } = fixture({ contextMenuOpen: true });

    scope.scheduleAutomaticTreeRefresh();
    await vi.advanceTimersByTimeAsync(0);

    expect(list).not.toHaveBeenCalled();
    expect(renderTree).not.toHaveBeenCalled();
    expect(scope.automaticTreeRefreshPending).toBe(true);
    expect(scope.automaticTreeRefreshTimer).not.toBeUndefined();
  });

  it("defers automatic refresh while inline create is active", async () => {
    vi.useFakeTimers();
    const { scope, list, renderTree } = fixture({ inlineCreate: true });

    scope.scheduleAutomaticTreeRefresh();
    await vi.advanceTimersByTimeAsync(0);

    expect(list).not.toHaveBeenCalled();
    expect(renderTree).not.toHaveBeenCalled();
    expect(scope.automaticTreeRefreshPending).toBe(true);
  });

  it("does not commit an automatic refresh when inline create opens during the read", async () => {
    const { scope, list, renderTree } = fixture();
    scope.treeRoots = [{ id: "old", name: "old.txt", path: "C:\\work\\old.txt", kind: "file" }];
    list.mockImplementation(async () => {
      scope.treeElement.querySelector = vi.fn((selector: string) => selector === ".inline-create" ? {} : null);
      return [file("C:\\work\\new.txt")];
    });

    await scope.performTreeRefresh(true);

    expect(renderTree).not.toHaveBeenCalled();
    expect(scope.treeRoots.map((node: TreeNode) => node.name)).toEqual(["old.txt"]);
    expect(scope.automaticTreeRefreshPending).toBe(true);
  });

  it("retries a transient automatic refresh error after the backoff", async () => {
    vi.useFakeTimers();
    const { scope, list, diag } = fixture();
    list.mockRejectedValueOnce(new Error("busy")).mockResolvedValueOnce([file("C:\\work\\ok.txt")]);

    scope.scheduleAutomaticTreeRefresh();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(diag).toHaveBeenCalledWith("renderer.explorer.refresh.error", { reason: "Error: busy" });
    expect(scope.automaticTreeRefreshPending).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(list).toHaveBeenCalledTimes(2);
    expect(scope.treeRoots.map((node: TreeNode) => node.name)).toEqual(["ok.txt"]);
  });

  it("preserves the newest expansion when an automatic refresh snapshot goes stale", async () => {
    const { scope, list } = fixture();
    scope.treeRoots = [expandedDirectory("C:\\work\\src")];
    let changedDuringFirstRootRead = false;
    const lateTree = [
      expandedDirectory("C:\\work\\src", [
        { id: "late", name: "late.ts", path: "C:\\work\\src\\late.ts", kind: "file" }
      ])
    ];
    const realRefreshLoadedTree = scope.refreshLoadedTree;
    scope.refreshLoadedTree = async (...args: Parameters<typeof refreshLoadedTree>) => {
      if (!changedDuringFirstRootRead) {
        changedDuringFirstRootRead = true;
        scope.__lateTree = lateTree;
        vm.runInContext("treeRoots = __lateTree", scope);
      }
      return realRefreshLoadedTree(...args);
    };
    list.mockImplementation(async (directoryPath: string) => {
      if (directoryPath === "C:\\work") {
        return [directory("C:\\work\\src")];
      }
      return [file("C:\\work\\src\\fresh.ts")];
    });

    await scope.performTreeRefresh(true);

    const src = scope.treeRoots[0] as TreeNode;
    expect(src.children?.map((node) => node.name)).toEqual(["fresh.ts"]);
  });

  it("falls back to the project root when the selected file disappears", async () => {
    const { scope } = fixture();
    scope.treeRoots = [{ id: "gone", name: "gone.txt", path: "C:\\work\\gone.txt", kind: "file" }];
    scope.selectedPath = "C:\\work\\gone.txt";
    scope.api.paths.list.mockResolvedValue([]);

    await scope.performTreeRefresh(false);

    expect(scope.selectedPath).toBe("C:\\work");
  });

  it("skips DOM repaint when an automatic refresh sees an unchanged listing", async () => {
    const { scope, renderTree } = fixture();
    scope.treeRoots = [{ id: "same", name: "same.txt", path: "C:\\work\\same.txt", kind: "file" }];
    scope.api.paths.list.mockResolvedValue([file("C:\\work\\same.txt")]);

    await scope.performTreeRefresh(true);

    expect(renderTree).not.toHaveBeenCalled();
    expect(scope.treeRoots.map((node: TreeNode) => node.name)).toEqual(["same.txt"]);
  });

  it("serializes manual and automatic refreshes without losing the automatic result", async () => {
    const { scope, list } = fixture();
    const manual = createDeferred<DirectoryEntry[]>();
    list.mockReturnValueOnce(manual.promise).mockResolvedValueOnce([file("C:\\work\\auto.txt")]);

    const manualRefresh = scope.refreshTree(false);
    const automaticRefresh = scope.refreshTree(true);
    await Promise.resolve();
    expect(list).toHaveBeenCalledTimes(1);

    manual.resolve([file("C:\\work\\manual.txt")]);
    await manualRefresh;
    await automaticRefresh;

    expect(list).toHaveBeenCalledTimes(2);
    expect(scope.treeRoots.map((node: TreeNode) => node.name)).toEqual(["auto.txt"]);
  });

  it("ignores scheduled refresh work after the tree is disposed", async () => {
    vi.useFakeTimers();
    const { scope, list, renderTree } = fixture({ disposed: true });

    scope.scheduleAutomaticTreeRefresh();
    await vi.advanceTimersByTimeAsync(0);

    expect(scope.automaticTreeRefreshPending).toBe(false);
    expect(list).not.toHaveBeenCalled();
    expect(renderTree).not.toHaveBeenCalled();
  });
});
