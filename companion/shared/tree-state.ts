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
