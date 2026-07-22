import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { formatHeaderContext, formatModelName, projectNameFromPath } from "./labels";
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
import { explorerChevron, explorerIconPath } from "./explorer-icons";

type SessionStatus = {
  state: "idle" | "running" | "waiting" | "ended";
  model?: string;
  cwd?: string;
  contextPercentage?: number | null;
  context?: { usedPercentage?: number | null } | number | null;
};

type RendererCompanionApi = ClaudeCompanionApi & {
  session?: {
    status?(): Promise<SessionStatus>;
  };
};

declare global {
  interface Window {
    claudeCompanion?: RendererCompanionApi;
  }
}

const api = window.claudeCompanion;
const appShell = mustElement<HTMLElement>("app-shell");
const titleProjectName = mustElement<HTMLElement>("title-project-name");
const explorerProjectName = mustElement<HTMLElement>("explorer-project-name");
const tabProjectName = mustElement<HTMLElement>("tab-project-name");
const tabModel = mustElement<HTMLElement>("tab-model");
const tabContext = mustElement<HTMLElement>("tab-context");
const sessionTabDot = mustElement<HTMLElement>("session-tab-dot");
const treeElement = mustElement<HTMLElement>("tree");
const sidebar = mustElement<HTMLElement>("sidebar");
const contextMenu = mustElement<HTMLElement>("context-menu");
const contextMenuTitle = mustElement<HTMLElement>("context-menu-title");
const promptInput = mustElement<HTMLTextAreaElement>("prompt-input");
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
const windowMinimize = mustElement<HTMLButtonElement>("window-minimize");
const windowMaximize = mustElement<HTMLButtonElement>("window-maximize");
const windowClose = mustElement<HTMLButtonElement>("window-close");
const terminalSplitToggle = mustElement<HTMLButtonElement>("terminal-split-toggle");
const terminalPanelClose = mustElement<HTMLButtonElement>("terminal-panel-close");
const terminalSplitSign = mustElement<HTMLElement>("terminal-split-sign");
const terminalElement = mustElement<HTMLElement>("terminal");
const consoleElement = mustElement<HTMLElement>("console-log");

const projectRoot = api?.runtime.folder || ".";
let treeRoots: TreeNode[] = [];
let selectedPath: string | undefined;
let contextPath: string | undefined;
let composer: ComposerState = createComposerState();
let activeClaudeSession: ClaudeSessionStarted | undefined;
const pendingClaudeOutput = new Map<string, string[]>();
let terminalSessionId: string | undefined;
let terminalStarting = false;
let sessionStatusTimer: ReturnType<typeof setInterval> | undefined;
let lastSessionState: SessionStatus["state"] = "idle";
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

const consoleTerminal = new Terminal({
  convertEol: true,
  cursorBlink: false,
  disableStdin: true,
  fontFamily: '"Cascadia Code", "D2Coding", Consolas, monospace',
  fontSize: 13,
  scrollback: 10_000,
  theme: {
    background: "#1e1e1e",
    foreground: "#e6e6e6",
    selectionBackground: "#5a3a2f"
  }
});
const consoleFitAddon = new FitAddon();
consoleTerminal.loadAddon(consoleFitAddon);
consoleTerminal.open(consoleElement);
fitTerminals();
consoleTerminal.attachCustomKeyEventHandler((event) => {
  if (event.type !== "keydown") {
    return false;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && consoleTerminal.hasSelection()) {
    void navigator.clipboard?.writeText(consoleTerminal.getSelection());
    event.preventDefault();
  }
  return false;
});

terminal.onData((data) => {
  if (terminalSessionId) {
    api?.terminal.write(terminalSessionId, data);
  }
});
api?.terminal.onData((message) => {
  if (!terminalSessionId || message.sessionId === terminalSessionId) {
    terminal.write(message.data);
  }
});

api?.terminal.onExit((message) => {
  if (terminalSessionId && message.sessionId === terminalSessionId) {
    terminalSessionId = undefined;
    terminal.writeln("\r\n[terminal exited]");
    showToast("Project terminal exited.");
  }
});

api?.claude.onData((message) => {
  if (!activeClaudeSession || message.sessionId === activeClaudeSession.sessionId) {
    if (activeClaudeSession) {
      appendConsoleOutput(message.data);
    } else {
      pendingClaudeOutput.set(message.sessionId, [
        ...(pendingClaudeOutput.get(message.sessionId) ?? []),
        message.data
      ]);
    }
  }
});

api?.claude.onExit((message) => {
  if (activeClaudeSession?.sessionId === message.sessionId) {
    renderStatus({ state: "ended", cwd: activeClaudeSession.cwd });
    activeClaudeSession = undefined;
    showToast("Claude session ended.");
  }
});

window.addEventListener("resize", fitTerminals);
document.addEventListener("click", () => hideContextMenu());

newSessionButton.addEventListener("click", () => {
  void startClaudeSession();
});

explorerToggle.addEventListener("click", () => {
  setExplorerCollapsed(true);
});

explorerRail.addEventListener("click", () => {
  setExplorerCollapsed(false);
});

windowMinimize.addEventListener("click", () => {
  void api?.windowControls.minimize();
});

windowMaximize.addEventListener("click", () => {
  void api?.windowControls.toggleMaximize();
});

windowClose.addEventListener("click", () => {
  void api?.windowControls.close();
});

terminalSplitToggle.addEventListener("click", () => {
  void setTerminalSplit(
    !appShell.classList.contains("is-terminal-split"),
    terminalCwdForSelection()
  );
});

terminalPanelClose.addEventListener("click", () => {
  void setTerminalSplit(false);
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
  if (projectRoot !== ".") {
    void api?.paths.open(projectRoot);
  }
});

openTerminalButton.addEventListener("click", () => {
  void api?.terminal.openFolder(projectRoot);
});

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
  } else if (button.dataset.action === "open-terminal") {
    void api?.terminal.openFolder(node.kind === "directory" ? node.path : parentPathOf(node.path));
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
  updateProjectName(api?.runtime.projectName || projectNameFromPath(projectRoot));
  const initialStatus = await api?.session?.status?.();
  renderStatus({ state: "idle", ...initialStatus });
  sessionStatusTimer = setInterval(() => {
    void refreshSessionStatus();
  }, 1_000);
  const rootChildren = entriesToNodes((await api?.paths.list(projectRoot)) ?? []);
  treeRoots = replaceRoots([{
    id: projectRoot,
    name: projectNameFromPath(projectRoot),
    path: projectRoot,
    kind: "directory",
    expanded: true,
    loaded: true,
    children: rootChildren
  }]);
  selectedPath = projectRoot;
  renderTree();

  if (api?.runtime.resumeSessionId && api.runtime.folder) {
    resumeSessionInput.value = api.runtime.resumeSessionId;
    try {
      await startClaudeSession(api.runtime.resumeSessionId);
    } catch (error) {
      renderStatus({ state: "ended" });
      appendConsoleOutput(`[resume failed: ${error instanceof Error ? error.message : "unknown error"}]\n`);
    }
  }
}

function fitTerminal(): void {
  fitAddon.fit();
  if (terminalSessionId && terminal.cols > 0 && terminal.rows > 0) {
    api?.terminal.resize(terminalSessionId, terminal.cols, terminal.rows);
  }
}

function fitTerminals(): void {
  fitTerminal();
  consoleFitAddon.fit();
}

function renderStatus(status: SessionStatus): void {
  lastSessionState = status.state;
  statusDot.className = `status-dot is-${status.state}`;
  sessionTabDot.className = `tab-dot is-${status.state}`;
  sessionState.textContent = status.state === "running"
    ? "Running"
    : status.state === "waiting"
      ? "Waiting"
      : status.state === "ended"
        ? "Closed"
        : "Idle";
  const model = formatModelName(status.model);
  sessionModel.textContent = model;
  tabModel.textContent = model;
  tabContext.textContent = formatContext(status);
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
    chevron.textContent = explorerChevron(row.node.kind, Boolean(row.node.expanded), Boolean(row.node.loading));
    chevron.setAttribute("aria-hidden", "true");

    const icon = document.createElement("img");
    icon.className = "tree-row__icon";
    icon.src = explorerIconPath(row.node.name, row.node.kind);
    icon.alt = "";
    icon.setAttribute("aria-hidden", "true");

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
  contextMenuTitle.textContent = contextPath ? projectNameFromPath(contextPath) : projectNameFromPath(projectRoot);
  contextMenu.hidden = false;
  contextMenu.style.left = `${Math.min(x, window.innerWidth - 248)}px`;
  contextMenu.style.top = `${Math.min(y, window.innerHeight - 228)}px`;
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
    treeRoots = setNodeChildren(treeRoots, node.path, [...(current?.children ?? []), entryToNode({
      name: request.name,
      path: createdPath,
      isDirectory: kind === "directory"
    })]);
    renderTree();
  } else if (createdPath) {
    await refreshNode(node);
  }
}

async function addImages(files: File[]): Promise<void> {
  const images = await Promise.all(files.map(fileToComposerImage));
  composer = addComposerImages(composer, images);
  renderImagePreview();
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

async function startClaudeSession(sessionId?: string): Promise<void> {
  if (!api) {
    renderStatus({ state: "ended" });
    return;
  }

  clearConsoleOutput();
  activeClaudeSession = await api.claude.start({
    cwd: projectRoot,
    mode: sessionId ? "resume" : "new",
    sessionId
  });
  renderStatus({ state: "running", cwd: activeClaudeSession.cwd });
  const pending = pendingClaudeOutput.get(activeClaudeSession.sessionId);
  pendingClaudeOutput.delete(activeClaudeSession.sessionId);
  for (const output of pending ?? []) {
    appendConsoleOutput(output);
  }
  appendConsoleOutput(sessionId ? "[session resumed]\n" : "[new session started]\n");
  promptInput.focus();
}

async function resumeSession(): Promise<void> {
  const sessionId = resumeSessionInput.value.trim();
  if (sessionId.length === 0) {
    resumeSessionInput.focus();
    return;
  }

  await startClaudeSession(sessionId);
}

async function sendIntent(intent: SubmitIntent): Promise<void> {
  if (!activeClaudeSession) {
    await startClaudeSession();
  }

  if (!api || !activeClaudeSession) {
    return;
  }

  for (const image of intent.images) {
    await api.claude.pasteClipboardImage(activeClaudeSession.sessionId, image.dataUrl);
    appendConsoleOutput(`[image attached: ${image.name}]\n`);
  }

  if (intent.text.length > 0) {
    appendConsoleOutput(`> ${intent.text}\n`);
    api.claude.write(activeClaudeSession.sessionId, `${intent.text}\r`);
  }
}

async function setTerminalSplit(open: boolean, cwd = terminalCwdForSelection()): Promise<void> {
  appShell.classList.toggle("is-terminal-split", open);
  terminalSplitSign.textContent = open ? "x" : "+";
  if (open) {
    await ensureProjectTerminal(cwd);
  }
  window.setTimeout(fitTerminal, 0);
}

function terminalCwdForSelection(): string {
  const node = selectedPath ? findNode(treeRoots, selectedPath) : undefined;
  if (!node) {
    return projectRoot;
  }
  return node.kind === "directory" ? node.path : parentPathOf(node.path);
}

async function ensureProjectTerminal(cwd: string): Promise<void> {
  if (terminalSessionId || terminalStarting) {
    return;
  }

  if (!api?.terminal) {
    terminal.writeln("[project terminal API unavailable]");
    return;
  }

  terminalStarting = true;
  try {
    const started = await api.terminal.start({ cwd, cols: terminal.cols, rows: terminal.rows });
    terminalSessionId = started.sessionId;
    if (!terminalSessionId) {
      terminal.writeln("[project terminal did not return a session id]");
    }
  } finally {
    terminalStarting = false;
  }
}

function appendConsoleOutput(data: string): void {
  consoleTerminal.write(data);
  consoleTerminal.scrollToBottom();
}

function setExplorerCollapsed(collapsed: boolean): void {
  appShell.classList.toggle("is-explorer-collapsed", collapsed);
  explorerRail.hidden = !collapsed;
}

function updateProjectName(sourcePath: string): void {
  titleProjectName.textContent = sourcePath;
  explorerProjectName.textContent = sourcePath;
  tabProjectName.textContent = sourcePath;
}

function formatContext(status: SessionStatus): string {
  return formatHeaderContext(status);
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

async function refreshSessionStatus(): Promise<void> {
  try {
    const status = await api?.session?.status?.();
    if (status) {
      renderStatus({ state: activeClaudeSession ? "running" : lastSessionState, ...status });
    }
  } catch {
    // Status is supplemental; the Claude PTY remains usable if the cache is unavailable.
  }
}

function clearConsoleOutput(): void {
  consoleTerminal.reset();
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

function cssEscape(value: string): string {
  if ("CSS" in window && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }

  return value.replace(/"/g, '\\"');
}
