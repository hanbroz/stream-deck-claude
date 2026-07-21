import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { ClaudeCompanionApi } from "../preload";
import type { ClaudeSessionStarted, DirectoryEntry } from "../shared/claude-command";
import {
  addComposerImages,
  createComposerState,
  imageId,
  removeComposerImage,
  setComposerText,
  setComposing,
  shouldSubmitFromKeyboard,
  submitComposer,
  type ComposerImage,
  type ComposerState,
  type SubmitIntent
} from "../shared/composer";
import {
  createTargetFor,
  findNode,
  parentPathOf,
  replaceRoots,
  setNodeChildren,
  setNodeExpanded,
  setNodeLoading,
  visibleTreeRows,
  type TreeNode,
  type TreeNodeKind
} from "../shared/tree-state";

type SessionStatus = {
  state: "idle" | "running" | "waiting" | "ended";
  model?: string;
  cwd?: string;
};

declare global {
  interface Window {
    claudeCompanion?: ClaudeCompanionApi;
  }
}

const api = window.claudeCompanion;
const appShell = mustElement<HTMLElement>("app-shell");
const titleProjectName = mustElement<HTMLElement>("title-project-name");
const explorerProjectName = mustElement<HTMLElement>("explorer-project-name");
const tabProjectName = mustElement<HTMLElement>("tab-project-name");
const tabModel = mustElement<HTMLElement>("tab-model");
const sessionTabDot = mustElement<HTMLElement>("session-tab-dot");
const treeElement = mustElement<HTMLElement>("tree");
const sidebar = mustElement<HTMLElement>("sidebar");
const contextMenu = mustElement<HTMLElement>("context-menu");
const contextMenuTitle = mustElement<HTMLElement>("context-menu-title");
const promptInput = mustElement<HTMLTextAreaElement>("prompt-input");
const sendPromptButton = mustElement<HTMLButtonElement>("send-prompt");
const copySelectionButton = mustElement<HTMLButtonElement>("copy-selection");
const imagePreview = mustElement<HTMLElement>("image-preview");
const toast = mustElement<HTMLElement>("toast");
const statusDot = mustElement<HTMLElement>("status-dot");
const sessionState = mustElement<HTMLElement>("session-state");
const sessionModel = mustElement<HTMLElement>("session-model");
const newSessionButton = mustElement<HTMLButtonElement>("new-session");
const resumeSessionInput = mustElement<HTMLInputElement>("resume-session-id");
const resumeSessionButton = mustElement<HTMLButtonElement>("resume-session");
const openExplorerButton = mustElement<HTMLButtonElement>("open-explorer");
const openTerminalButton = mustElement<HTMLButtonElement>("open-terminal");
const explorerRail = mustElement<HTMLButtonElement>("explorer-rail");
const explorerToggle = mustElement<HTMLButtonElement>("explorer-toggle");
const terminalSplitToggle = mustElement<HTMLButtonElement>("terminal-split-toggle");
const terminalPanelClose = mustElement<HTMLButtonElement>("terminal-panel-close");
const terminalSplitSign = mustElement<HTMLElement>("terminal-split-sign");
const terminalElement = mustElement<HTMLElement>("terminal");
const terminalPanel = mustElement<HTMLElement>("terminal-panel");
const explorerResizer = mustElement<HTMLElement>("explorer-resizer");
const terminalResizer = mustElement<HTMLElement>("terminal-resizer");

let treeRoots: TreeNode[] = [];
let selectedPath: string | undefined;
let contextPath: string | undefined;
let composer: ComposerState = createComposerState();
let activeSession: ClaudeSessionStarted | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const terminal = new Terminal({
  allowProposedApi: false,
  cursorBlink: true,
  fontFamily: '"Cascadia Code", "D2Coding", Consolas, monospace',
  fontSize: 12.5,
  theme: {
    background: "#181818",
    foreground: "#dcdcdc",
    cursor: "#cccccc",
    selectionBackground: "#5a3a2f"
  }
});
const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(terminalElement);
fitTerminal();

terminal.onData((data) => {
  if (activeSession) {
    api?.claude.write(activeSession.sessionId, data);
  }
});

terminal.onSelectionChange(() => {
  copySelectionButton.disabled = terminal.getSelection().length === 0;
});

api?.claude.onData((message) => {
  if (!activeSession || message.sessionId === activeSession.sessionId) {
    terminal.write(message.data);
  }
});

api?.claude.onExit((message) => {
  if (activeSession?.sessionId === message.sessionId) {
    renderStatus({ state: "ended", cwd: activeSession.cwd });
    activeSession = undefined;
    appShell.classList.remove("is-session-active");
    showToast("Session ended.");
  }
});

window.addEventListener("resize", fitTerminal);
document.addEventListener("click", () => hideContextMenu());

copySelectionButton.addEventListener("click", () => {
  const selection = terminal.getSelection();
  if (selection.length > 0) {
    void navigator.clipboard?.writeText(selection);
    showToast("Selection copied.");
  }
});

newSessionButton.addEventListener("click", () => {
  void startSession();
});

explorerToggle.addEventListener("click", () => {
  setExplorerCollapsed(true);
});

explorerRail.addEventListener("click", () => {
  setExplorerCollapsed(false);
});

terminalSplitToggle.addEventListener("click", () => {
  setTerminalSplit(!appShell.classList.contains("is-terminal-split"));
});

terminalPanelClose.addEventListener("click", () => {
  setTerminalSplit(false);
});

explorerResizer.addEventListener("mousedown", (event) => {
  startColumnResize(event, "explorer");
});

terminalResizer.addEventListener("mousedown", (event) => {
  startColumnResize(event, "terminal");
});

resumeSessionButton.addEventListener("click", () => {
  void resumeSession();
});

resumeSessionInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void resumeSession();
  }
});

openExplorerButton.addEventListener("click", () => {
  if (api?.runtime.folder) {
    void api.paths.open(api.runtime.folder);
    showToast("Opening project folder.");
  }
});

openTerminalButton.addEventListener("click", () => {
  if (api?.runtime.folder) {
    void api.terminal.openFolder(api.runtime.folder);
    showToast("Opening project terminal.");
  }
});

sendPromptButton.addEventListener("click", submitPrompt);

promptInput.addEventListener("input", () => {
  composer = setComposerText(composer, promptInput.value);
});

promptInput.addEventListener("compositionstart", () => {
  composer = setComposing(composer, true);
});

promptInput.addEventListener("compositionend", () => {
  composer = setComposing(setComposerText(composer, promptInput.value), false);
});

promptInput.addEventListener("keydown", (event) => {
  if (shouldSubmitFromKeyboard({ key: event.key, shiftKey: event.shiftKey, isComposing: event.isComposing || composer.isComposing })) {
    event.preventDefault();
    submitPrompt();
  }
});

promptInput.addEventListener("paste", (event) => {
  const files = event.clipboardData
    ? Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"))
    : [];
  if (files.length > 0) {
    event.preventDefault();
    void addImages(files);
  }
});

contextMenu.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
  if (!button || !contextPath) {
    return;
  }

  const node = findNode(treeRoots, contextPath);
  if (!node) {
    return;
  }

  hideContextMenu();

  if (button.dataset.action === "new-file") {
    startInlineCreate(node, "file");
  } else if (button.dataset.action === "new-folder") {
    startInlineCreate(node, "directory");
  } else if (button.dataset.action === "refresh") {
    void refreshNode(node);
  } else if (button.dataset.action === "show-explorer") {
    void api?.paths.reveal(node.path);
    showToast("Revealing item.");
  } else if (button.dataset.action === "open-terminal") {
    void api?.terminal.openFolder(node.kind === "directory" ? node.path : parentPathOf(node.path));
    showToast("Opening terminal here.");
  }
});

void initialize();

function mustElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing renderer element: ${id}`);
  }

  return element as T;
}

async function initialize(): Promise<void> {
  const rootPath = api?.runtime.folder || ".";
  updateProjectName(rootPath);
  renderStatus({ state: "idle" });
  const rootChildren = entriesToNodes((await api?.paths.list()) ?? []);
  treeRoots = replaceRoots([{
    id: rootPath,
    name: projectNameFromPath(rootPath),
    path: rootPath,
    kind: "directory",
    expanded: true,
    loaded: true,
    children: rootChildren
  }]);
  selectedPath = rootPath;
  renderTree();

  if (api?.runtime.resumeSessionId && api.runtime.folder) {
    resumeSessionInput.value = api.runtime.resumeSessionId;
    try {
      await startSession(api.runtime.resumeSessionId);
    } catch (error) {
      renderStatus({ state: "ended" });
      terminal.writeln(`\r\n[Resume failed: ${error instanceof Error ? error.message : "unknown error"}]`);
      showToast("Resume failed.");
    }
  }
}

function fitTerminal(): void {
  fitAddon.fit();
  if (activeSession && terminal.cols > 0 && terminal.rows > 0) {
    api?.claude.resize(activeSession.sessionId, terminal.cols, terminal.rows);
  }
}

function renderStatus(status: SessionStatus): void {
  statusDot.className = `status-dot is-${status.state}`;
  sessionTabDot.className = `tab-dot is-${status.state}`;
  sessionState.textContent =
    status.state === "running"
      ? "Running"
      : status.state === "waiting"
        ? "Waiting"
        : status.state === "ended"
          ? "Closed"
          : "Idle";
  const model = status.model ?? "Claude Code";
  sessionModel.textContent = model;
  tabModel.textContent = model;
  selectedPath = selectedPath ?? status.cwd;
  if (status.cwd) {
    updateProjectName(status.cwd);
  }
}

function renderTree(): void {
  treeElement.replaceChildren();

  for (const row of visibleTreeRows(treeRoots)) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `tree-row${row.node.path === selectedPath ? " is-selected" : ""}`;
    item.style.paddingLeft = `${8 + row.depth * 15}px`;
    item.dataset.path = row.node.path;
    item.setAttribute("aria-label", row.node.name);

    const chevron = document.createElement("span");
    chevron.className = "tree-row__chevron";
    chevron.textContent = row.node.kind === "directory" ? (row.node.loading ? "..." : "▸") : "";
    chevron.classList.toggle("is-expanded", row.node.kind === "directory" && Boolean(row.node.expanded));

    const icon = document.createElement("span");
    icon.className = `tree-row__icon${row.node.kind === "directory" ? " is-folder" : isCodeFile(row.node.name) ? " is-code" : ""}`;
    icon.textContent = row.node.kind === "directory"
      ? (row.node.expanded ? "📂" : "📁")
      : fileIcon(row.node.name);

    const name = document.createElement("span");
    name.className = "tree-row__name";
    name.textContent = row.node.name;

    item.append(chevron, icon, name);
    item.addEventListener("click", () => selectNode(row.node));
    item.addEventListener("dblclick", () => {
      if (row.node.kind === "directory") {
        void toggleDirectory(row.node);
      } else {
        void api?.paths.open(row.node.path);
      }
    });
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      selectedPath = row.node.path;
      contextPath = row.node.path;
      renderTree();
      showContextMenu(event.clientX, event.clientY);
    });

    treeElement.append(item);
  }
}

function selectNode(node: TreeNode): void {
  selectedPath = node.path;
  renderTree();

  if (node.kind === "directory") {
    void toggleDirectory(node);
  }
}

async function toggleDirectory(node: TreeNode): Promise<void> {
  const nextExpanded = !node.expanded;
  treeRoots = setNodeExpanded(treeRoots, node.path, nextExpanded);
  renderTree();

  if (nextExpanded && !node.loaded) {
    try {
      treeRoots = setNodeChildren(treeRoots, node.path, entriesToNodes((await api?.paths.list(node.path)) ?? []));
    } catch {
      treeRoots = setNodeLoading(treeRoots, node.path, false);
      showToast("Folder load failed.");
    }
    renderTree();
  }
}

async function refreshNode(node: TreeNode): Promise<void> {
  const requestedPath = node.kind === "directory" ? node.path : parentPathOf(node.path);
  try {
    const entries = entriesToNodes((await api?.paths.list(requestedPath)) ?? []);
    if (node.kind === "directory") {
      treeRoots = setNodeChildren(treeRoots, node.path, entries);
    } else {
      const parent = findNode(treeRoots, requestedPath);
      treeRoots = parent?.kind === "directory" ? setNodeChildren(treeRoots, requestedPath, entries) : replaceRoots(entries);
    }
    renderTree();
    showToast("Explorer refreshed.");
  } catch {
    showToast("Refresh failed.");
  }
}

function showContextMenu(x: number, y: number): void {
  contextMenuTitle.textContent = contextPath ? projectNameFromPath(contextPath) : "PROJECT";
  contextMenu.hidden = false;
  const width = 240;
  const height = 220;
  contextMenu.style.left = `${Math.min(x, window.innerWidth - width - 8)}px`;
  contextMenu.style.top = `${Math.min(y, window.innerHeight - height - 8)}px`;
}

function hideContextMenu(): void {
  contextMenu.hidden = true;
}

function startInlineCreate(node: TreeNode, kind: TreeNodeKind): void {
  const row = treeElement.querySelector<HTMLElement>(`[data-path="${cssEscape(node.path)}"]`);
  if (!row) {
    return;
  }

  const input = document.createElement("input");
  input.className = "inline-create";
  input.placeholder = kind === "directory" ? "New folder name" : "New file name";
  row.insertAdjacentElement("afterend", input);
  input.focus();

  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      input.remove();
    } else if (event.key === "Enter") {
      event.preventDefault();
      void commitInlineCreate(node, kind, input);
    }
  });
  input.addEventListener("blur", () => {
    input.remove();
  });
}

async function commitInlineCreate(node: TreeNode, kind: TreeNodeKind, input: HTMLInputElement): Promise<void> {
  const request = createTargetFor(node, kind, input.value, node.kind === "directory");
  if (request.name.length === 0) {
    input.remove();
    return;
  }

  let createdPath: string | undefined;
  try {
    createdPath = kind === "directory"
      ? await api?.paths.createDirectory(request.parentPath, request.name)
      : await api?.paths.createFile(request.parentPath, request.name);
  } catch {
    showToast("Create failed.");
  } finally {
    input.remove();
  }

  if (createdPath && node.kind === "directory") {
    const current = findNode(treeRoots, node.path);
    const created = entryToNode({
      name: request.name,
      path: createdPath,
      isDirectory: kind === "directory"
    });
    treeRoots = setNodeChildren(treeRoots, node.path, [...(current?.children ?? []), created]);
    renderTree();
    showToast(`${kind === "directory" ? "Folder" : "File"} created: ${request.name}`);
  } else if (createdPath) {
    await refreshNode(node);
    showToast(`${kind === "directory" ? "Folder" : "File"} created: ${request.name}`);
  }
}

async function addImages(files: File[]): Promise<void> {
  const images = await Promise.all(files.map(fileToComposerImage));
  composer = addComposerImages(composer, images);
  renderImagePreview();
  showToast(`${images.length} image(s) attached.`);
}

function fileToComposerImage(file: File): Promise<ComposerImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve({
        id: imageId(file.name, file.size, file.lastModified),
        name: file.name,
        mimeType: file.type,
        dataUrl: String(reader.result)
      });
    });
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

function renderImagePreview(): void {
  imagePreview.replaceChildren();

  for (const image of composer.images) {
    const chip = document.createElement("div");
    chip.className = "image-chip";

    const thumbnail = document.createElement("img");
    thumbnail.src = image.dataUrl;
    thumbnail.alt = image.name;

    const label = document.createElement("span");
    label.textContent = image.name;

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "x";
    remove.title = "Remove image";
    remove.addEventListener("click", () => {
      composer = removeComposerImage(composer, image.id);
      renderImagePreview();
    });

    chip.append(thumbnail, label, remove);
    imagePreview.append(chip);
  }
}

function submitPrompt(): void {
  composer = setComposerText(composer, promptInput.value);
  const result = submitComposer(composer);
  composer = result.state;

  if (!result.intent) {
    return;
  }

  promptInput.value = composer.text;
  renderImagePreview();
  void sendIntent(result.intent);
}

async function startSession(sessionId?: string): Promise<void> {
  if (!api) {
    renderStatus({ state: "ended" });
    showToast("Companion API is unavailable.");
    return;
  }

  const cwd = api.runtime.folder || selectedPath || ".";
  activeSession = await api.claude.start({
    cwd,
    mode: sessionId ? "resume" : "new",
    sessionId,
    cols: terminal.cols,
    rows: terminal.rows
  });
  appShell.classList.add("is-session-active");
  fitTerminal();
  terminal.clear();
  renderStatus({ state: "running", cwd: activeSession.cwd });
  updateProjectName(activeSession.cwd);
  showToast(sessionId ? "Session resumed." : "New session started.");
  terminal.focus();
}

async function resumeSession(): Promise<void> {
  const sessionId = resumeSessionInput.value.trim();
  if (sessionId.length === 0) {
    resumeSessionInput.focus();
    showToast("Enter a session ID to resume.");
    return;
  }

  await startSession(sessionId);
}

async function sendIntent(intent: SubmitIntent): Promise<void> {
  if (!activeSession) {
    await startSession();
  }

  if (!api || !activeSession) {
    return;
  }

  for (const image of intent.images) {
    await api.claude.pasteClipboardImage(activeSession.sessionId, image.dataUrl);
    terminal.writeln(`[image attached: ${image.name}]`);
  }

  if (intent.text.length > 0) {
    api.claude.write(activeSession.sessionId, `${intent.text}\r`);
  }
}

function setExplorerCollapsed(collapsed: boolean): void {
  appShell.classList.toggle("is-explorer-collapsed", collapsed);
  explorerRail.hidden = !collapsed;
}

function setTerminalSplit(open: boolean): void {
  appShell.classList.toggle("is-terminal-split", open);
  terminalSplitSign.textContent = open ? "×" : "+";
  window.setTimeout(fitTerminal, 0);
}

function startColumnResize(event: MouseEvent, target: "explorer" | "terminal"): void {
  event.preventDefault();
  const startX = event.clientX;
  const element = target === "explorer" ? sidebar : terminalPanel;
  const startWidth = element.getBoundingClientRect().width;
  const onMove = (moveEvent: MouseEvent) => {
    const delta = moveEvent.clientX - startX;
    const nextWidth = target === "explorer"
      ? Math.max(180, Math.min(520, startWidth + delta))
      : Math.max(240, Math.min(900, startWidth - delta));
    element.style.width = `${nextWidth}px`;
    element.style.flexBasis = `${nextWidth}px`;
    fitTerminal();
  };
  const onUp = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.style.userSelect = "";
  };
  document.body.style.userSelect = "none";
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}

function updateProjectName(sourcePath: string): void {
  const name = projectNameFromPath(sourcePath);
  titleProjectName.textContent = name;
  explorerProjectName.textContent = name;
  tabProjectName.textContent = name;
}

function projectNameFromPath(sourcePath: string): string {
  const normalized = sourcePath.replace(/[\\/]+$/, "");
  const slash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return (slash >= 0 ? normalized.slice(slash + 1) : normalized) || "project";
}

function showToast(message: string): void {
  if (toastTimer) {
    clearTimeout(toastTimer);
  }

  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 2600);
}

function entriesToNodes(entries: DirectoryEntry[]): TreeNode[] {
  return entries.map(entryToNode);
}

function entryToNode(entry: DirectoryEntry): TreeNode {
  return {
    id: entry.path,
    name: entry.name,
    path: entry.path,
    kind: entry.isDirectory ? "directory" : "file"
  };
}

function fileIcon(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "ts" || extension === "tsx") {
    return "⬡";
  }
  if (extension === "js") {
    return "◆";
  }
  if (extension === "json") {
    return "{}";
  }
  if (extension === "md") {
    return "≡";
  }
  if (extension === "css") {
    return "#";
  }
  return "≡";
}

function isCodeFile(name: string): boolean {
  const extension = name.split(".").pop()?.toLowerCase();
  return extension === "ts" || extension === "tsx" || extension === "js";
}

function cssEscape(value: string): string {
  if ("CSS" in window && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }

  return value.replace(/"/g, '\\"');
}
