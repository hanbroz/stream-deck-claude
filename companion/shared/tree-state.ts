export type TreeNodeKind = "file" | "directory";

export type TreeNode = {
  id: string;
  name: string;
  path: string;
  kind: TreeNodeKind;
  expanded?: boolean;
  loading?: boolean;
  loaded?: boolean;
  children?: TreeNode[];
};

export type TreeRow = {
  node: TreeNode;
  depth: number;
};

export type CreateTarget = {
  parentPath: string;
  kind: TreeNodeKind;
  name: string;
};

function cloneNode(node: TreeNode): TreeNode {
  return {
    ...node,
    children: node.children?.map(cloneNode)
  };
}

function updateNode(nodes: TreeNode[], nodePath: string, update: (node: TreeNode) => TreeNode): TreeNode[] {
  return nodes.map((node) => {
    if (node.path === nodePath) {
      return update(cloneNode(node));
    }

    if (!node.children) {
      return cloneNode(node);
    }

    return {
      ...node,
      children: updateNode(node.children, nodePath, update)
    };
  });
}

function sortChildren(children: TreeNode[]): TreeNode[] {
  return [...children].sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "directory" ? -1 : 1;
    }

    return left.name.localeCompare(right.name, "ko");
  });
}

export function replaceRoots(nodes: TreeNode[]): TreeNode[] {
  return sortChildren(nodes.map(cloneNode));
}

export function setNodeExpanded(nodes: TreeNode[], nodePath: string, expanded: boolean): TreeNode[] {
  return updateNode(nodes, nodePath, (node) => ({
    ...node,
    expanded,
    loading: expanded && node.kind === "directory" && !node.loaded ? true : node.loading
  }));
}

export function setNodeChildren(nodes: TreeNode[], nodePath: string, children: TreeNode[]): TreeNode[] {
  return updateNode(nodes, nodePath, (node) => ({
    ...node,
    expanded: true,
    loading: false,
    loaded: true,
    children: sortChildren(children.map(cloneNode))
  }));
}

export function setNodeLoading(nodes: TreeNode[], nodePath: string, loading: boolean): TreeNode[] {
  return updateNode(nodes, nodePath, (node) => ({
    ...node,
    loading
  }));
}

/**
 * Merge a fresh directory listing with the nodes already shown: entries that
 * still exist keep their expanded/loaded state and children, so a refresh
 * (e.g. right after creating a file) does not collapse the tree under the user.
 */
export function mergeFreshChildren(previous: TreeNode[] | undefined, fresh: TreeNode[]): TreeNode[] {
  const byPath = new Map((previous ?? []).map((node) => [node.path, node]));
  return fresh.map((node) => {
    const existing = byPath.get(node.path);
    return existing && existing.kind === node.kind ? cloneNode(existing) : cloneNode(node);
  });
}

/**
 * Re-list every directory already opened, walking down from `rootPath`, so a
 * refresh triggered anywhere refreshes the whole project. `list` reads one
 * directory from disk.
 *
 * Folders never opened are skipped: they load fresh on first expand anyway, so
 * descending into them would turn a refresh into a full project scan. A folder
 * that cannot be re-listed (deleted mid-refresh, permissions) keeps the entries
 * it already had rather than failing the refresh for everything else.
 */
export async function refreshLoadedTree(
  rootPath: string,
  previous: TreeNode[] | undefined,
  list: (directoryPath: string) => Promise<TreeNode[]>
): Promise<TreeNode[]> {
  const merged = mergeFreshChildren(previous, await list(rootPath));

  return sortChildren(
    await Promise.all(
      merged.map(async (node) => {
        // `expanded` matters as much as `loaded`: a folder just expanded for an
        // inline create is showing its contents while still unloaded, and its
        // new entry has to appear.
        if (node.kind !== "directory" || !(node.loaded || node.expanded)) {
          return node;
        }

        try {
          return {
            ...node,
            loading: false,
            loaded: true,
            children: await refreshLoadedTree(node.path, node.children, list)
          };
        } catch {
          return node;
        }
      })
    )
  );
}

export function findNode(nodes: TreeNode[], nodePath: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.path === nodePath) {
      return node;
    }

    const child = node.children ? findNode(node.children, nodePath) : undefined;
    if (child) {
      return child;
    }
  }

  return undefined;
}

export function visibleTreeRows(nodes: TreeNode[]): TreeRow[] {
  const rows: TreeRow[] = [];

  function visit(node: TreeNode, depth: number): void {
    rows.push({ node, depth });

    if (!node.expanded || !node.children) {
      return;
    }

    for (const child of node.children) {
      visit(child, depth + 1);
    }
  }

  for (const node of nodes) {
    visit(node, 0);
  }

  return rows;
}

export function normalizeCreateName(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]/g, "-");
}

export function createTargetFor(node: TreeNode, kind: TreeNodeKind, name: string, asChild: boolean): CreateTarget {
  const safeName = normalizeCreateName(name);
  const parentPath = asChild && node.kind === "directory" ? node.path : parentPathOf(node.path);

  return {
    parentPath,
    kind,
    name: safeName
  };
}

export function parentPathOf(nodePath: string): string {
  const normalized = nodePath.replace(/[\\/]+$/, "");
  const slash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return slash > 0 ? normalized.slice(0, slash) : normalized;
}

/**
 * What "Copy Path" yields: the entry's path from the project root, forward
 * slashes, "./" prefixed — the form that can be pasted straight into a prompt
 * or a command. Compared case-insensitively because the tree's Windows paths
 * and the root differ in drive-letter case often enough to matter.
 *
 * A path that is not under the root has no relative form, so it is returned
 * whole rather than being mislabelled "./".
 */
export function projectRelativePath(root: string, nodePath: string): string {
  const base = root.replace(/[\\/]+$/, "");
  const boundary = nodePath[base.length];
  const inside =
    nodePath.slice(0, base.length).toLowerCase() === base.toLowerCase() &&
    (nodePath.length === base.length || boundary === "\\" || boundary === "/");
  if (!inside) {
    return nodePath.replace(/\\/g, "/");
  }
  const relative = nodePath.slice(base.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
  return relative ? `./${relative}` : "./";
}
