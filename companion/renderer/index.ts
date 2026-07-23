import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  contextPercentValue,
  formatClaudePhase,
  formatModelName,
  projectNameFromPath
} from "./labels";
import { parseModelId, REPRESENTATIVE_MODEL_ID } from "../shared/model-name";
import type { ClaudeCompanionApi } from "../preload";
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODELS,
  type ClaudeEffort,
  type ClaudeModel,
  type ClaudeSessionStarted,
  type DirectoryEntry
} from "../shared/claude-command";
import {
  addComposerImages,
  createComposerState,
  imageId,
  navigateHistory,
  pushHistory,
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
  mergeFreshChildren,
  parentPathOf,
  replaceRoots,
  setNodeChildren,
  setNodeExpanded,
  setNodeLoading,
  visibleTreeRows,
  type TreeNode,
  type TreeNodeKind
} from "../shared/tree-state";
import type { ClaudeEvent, ClaudePhase } from "../shared/claude-stream";
import { diag, setDiagSink } from "../shared/diag";
import { createTurn, paintTurn, type Turn, type TurnRole } from "./transcript";
import { companionBuildVersion } from "../shared/build-version";
import { explorerIconPath } from "./explorer-icons";
import { adjustSplitForKey, clampSplit, type SplitterOrientation } from "./splitter";

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
const bodyShell = mustElement<HTMLElement>("body-shell");
const titleProjectName = mustElement<HTMLElement>("title-project-name");
const titleBuildVersion = mustElement<HTMLElement>("title-build-version");
const claudeStatus = mustElement<HTMLElement>("claude-status");
const claudeStatusText = mustElement<HTMLElement>("claude-status-text");
const claudeStatusDetail = mustElement<HTMLElement>("claude-status-detail");
const explorerProjectName = mustElement<HTMLElement>("explorer-project-name");
const ctxMeter = mustElement<HTMLElement>("ctx-meter");
const ctxMeterCover = mustElement<HTMLElement>("ctx-meter-cover");
const ctxMeterValue = mustElement<HTMLElement>("ctx-meter-value");
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
const resumeSessionInput = mustElement<HTMLInputElement>("resume-session-id");
const resumeSessionButton = mustElement<HTMLButtonElement>("resume-session");
const openExplorerButton = mustElement<HTMLButtonElement>("open-explorer");
const openTerminalButton = mustElement<HTMLButtonElement>("open-terminal");
const explorerRail = mustElement<HTMLButtonElement>("explorer-rail");
const explorerToggle = mustElement<HTMLButtonElement>("explorer-toggle");
const explorerResizer = mustElement<HTMLDivElement>("explorer-resizer");
const workspaceElement = mustElement<HTMLElement>("workspace");
const workSplitElement = mustElement<HTMLElement>("work-split");
const terminalPanelElement = mustElement<HTMLElement>("terminal-panel");
const terminalResizer = mustElement<HTMLDivElement>("terminal-resizer");
const composerPanel = mustElement<HTMLElement>("composer");
const composerResizer = mustElement<HTMLDivElement>("composer-resizer");
const modelSelect = mustElement<HTMLSelectElement>("model-select");
const effortSelect = mustElement<HTMLSelectElement>("effort-select");
const applyModelButton = mustElement<HTMLButtonElement>("apply-model");
const clearSessionButton = mustElement<HTMLButtonElement>("clear-session");
const windowMinimize = mustElement<HTMLButtonElement>("window-minimize");
const windowMaximize = mustElement<HTMLButtonElement>("window-maximize");
const windowClose = mustElement<HTMLButtonElement>("window-close");
const terminalSplitToggle = mustElement<HTMLButtonElement>("terminal-split-toggle");
const terminalPanelClose = mustElement<HTMLButtonElement>("terminal-panel-close");
const terminalPanelTitle = mustElement<HTMLElement>("terminal-panel-title");
const terminalCopyToast = mustElement<HTMLElement>("terminal-copy-toast");
const terminalSplitSign = mustElement<HTMLElement>("terminal-split-sign");
const terminalElement = mustElement<HTMLElement>("terminal");
const consoleElement = mustElement<HTMLElement>("console-log");

const buildVersion = companionBuildVersion();
titleBuildVersion.textContent = buildVersion;
document.title = `Claude Companion ${buildVersion}`;

// Renderer diagnostics are invisible when Code Start launches with stdio
// "ignore", so mirror them into the main process log alongside the console.
setDiagSink((line) => {
  console.log(line);
  api?.diag(line);
});
diag("renderer.boot", { buildVersion });

const projectRoot = api?.runtime.folder || ".";
let treeRoots: TreeNode[] = [];
let selectedPath: string | undefined;
let contextPath: string | undefined;
let composer: ComposerState = createComposerState();
// Shell-style input history: sent messages (oldest first) recalled with Up/Down.
// historyIndex points into inputHistory; === length means the live draft.
const inputHistory: string[] = [];
let historyIndex = 0;
let historyDraft = "";
let activeClaudeSession: ClaudeSessionStarted | undefined;
let claudeStartPromise: Promise<void> | undefined;
const pendingClaudeOutput = new Map<string, ClaudeEvent[]>();
const pendingResumeIntents = new Map<string, SubmitIntent[]>();
const abandonedClaudeSessions = new Set<string>();
let resumeRecoveryPromise: Promise<void> | undefined;
let terminalSessionId: string | undefined;
let terminalStarting = false;
let sessionStatusTimer: ReturnType<typeof setInterval> | undefined;
let lastSessionState: SessionStatus["state"] = "idle";
// Derived from the stream's own usage, because --print never writes a status line.
let lastContextPercentage: number | undefined;
// The model id the stream actually ran (init.model), so the status bar shows the
// real model instead of the OMC statusline bridge cache, which cannot see a
// --print session and otherwise leaves the bar reading "Claude Code".
let lastStreamModel: string | undefined;
// Seed from the model/effort the user last applied for this folder (restored by
// the main process), falling back to the opus/high default on first launch.
const seededModel = api?.runtime.model;
const seededEffort = api?.runtime.effort;
let claudeModel: ClaudeModel = CLAUDE_MODELS.includes(seededModel as ClaudeModel)
  ? (seededModel as ClaudeModel)
  : "opus";
let claudeEffort: ClaudeEffort = CLAUDE_EFFORTS.includes(seededEffort as ClaudeEffort)
  ? (seededEffort as ClaudeEffort)
  : "high";
modelSelect.value = claudeModel;
effortSelect.value = claudeEffort;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let terminalCopyToastTimer: ReturnType<typeof setTimeout> | undefined;
let terminalsReady = false;
let explorerWidth = readSplitSetting("explorer-width", 260);
let terminalWidth = readSplitSetting("terminal-width", 380);
let composerHeight = readSplitSetting("composer-height", 280);

applyExplorerWidth(explorerWidth, false);
applyTerminalWidth(terminalWidth, false);
applyComposerHeight(composerHeight, false);
installSplitters();

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

// Copy the selection to the clipboard when a drag ends, and confirm with a
// brief toast under the terminal — xterm has no copy affordance of its own.
// The copy goes through the main-process clipboard because the renderer's
// navigator.clipboard rejects with NotAllowedError when the document is not
// focused (e.g. mid-drag), which silently dropped both the copy and the toast.
terminalElement.addEventListener("mouseup", () => {
  const selection = terminal.getSelection();
  diag("renderer.terminal.copy", { length: selection.length });
  if (selection.trim().length === 0) {
    return;
  }
  void api?.clipboardWriteText(selection).then(
    () => showTerminalCopyToast(),
    () => { /* leave the selection for a manual Ctrl+C if the write failed */ }
  );
});

/**
 * The Console is a DOM transcript, not a terminal: turns need roles, Markdown
 * needs real elements, and native selection gives copy/paste for free.
 */
const turns: Turn[] = [];
let activeAssistantTurn: Turn | undefined;
let repaintHandle = 0;
const HISTORY_PAGE = 20;
// Paging state for the resumed conversation shown above live messages.
let historySessionId: string | undefined;
let historyOffset = 0;
let historyHasMore = false;
let historyLoading = false;

function appendTurn(role: TurnRole, text: string): Turn {
  const turn = createTurn(role);
  turn.text = text;
  paintTurn(turn);
  turns.push(turn);
  consoleElement.append(turn.element);
  scrollConsoleToBottom();
  return turn;
}

/** Insert an older history message above everything, keeping the view steady. */
function prependTurn(role: TurnRole, text: string): void {
  const turn = createTurn(role);
  turn.text = text;
  paintTurn(turn);
  turns.unshift(turn);
  consoleElement.prepend(turn.element);
}

function scrollConsoleToBottom(): void {
  consoleElement.scrollTop = consoleElement.scrollHeight;
}

async function loadInitialHistory(sessionId: string): Promise<void> {
  if (!api) {
    return;
  }
  const page = await api.claude.history(sessionId, 0, HISTORY_PAGE);
  diag("renderer.history.initial", { total: page.total, shown: page.messages.length });
  if (page.messages.length === 0) {
    return;
  }
  for (const message of page.messages) {
    appendTurn(message.role, message.text);
  }
  historySessionId = sessionId;
  historyOffset = page.messages.length;
  historyHasMore = page.hasMore;
  scrollConsoleToBottom();
}

async function loadOlderHistory(): Promise<void> {
  if (!api || !historySessionId || !historyHasMore || historyLoading) {
    return;
  }
  historyLoading = true;
  try {
    const page = await api.claude.history(historySessionId, historyOffset, HISTORY_PAGE);
    if (page.messages.length === 0) {
      historyHasMore = false;
      return;
    }
    // Preserve the reading position: keep the same content under the viewport
    // after older messages are inserted above it.
    const before = consoleElement.scrollHeight;
    for (let index = page.messages.length - 1; index >= 0; index -= 1) {
      prependTurn(page.messages[index].role, page.messages[index].text);
    }
    consoleElement.scrollTop += consoleElement.scrollHeight - before;
    historyOffset += page.messages.length;
    historyHasMore = page.hasMore;
    diag("renderer.history.older", { offset: historyOffset, hasMore: historyHasMore });
  } catch (error) {
    // A failed page must not become an unhandled rejection; stop paging and let
    // the user retry by scrolling again later.
    diag("renderer.history.error", { reason: error instanceof Error ? error.message : "unknown" });
    historyHasMore = false;
  } finally {
    historyLoading = false;
  }
}

consoleElement.addEventListener("scroll", () => {
  if (consoleElement.scrollTop <= 40) {
    void loadOlderHistory();
  }
});
terminalsReady = true;
fitTerminals();
// The transcript is ordinary DOM, so Ctrl+C over a selection is handled natively.

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
  diag("renderer.onData", {
    sessionId: message.sessionId,
    activeSessionId: activeClaudeSession?.sessionId ?? "none",
    eventCount: message.events.length,
    abandoned: abandonedClaudeSessions.has(message.sessionId)
  });
  if (abandonedClaudeSessions.has(message.sessionId)) {
    return;
  }

  const missingConversation = message.events.some(
    (event) => event.kind === "error" && event.missingConversation
  );
  if (
    activeClaudeSession?.sessionId === message.sessionId &&
    activeClaudeSession.mode === "resume" &&
    missingConversation
  ) {
    const failedSession = activeClaudeSession;
    const retryIntents = pendingResumeIntents.get(failedSession.sessionId) ?? [];
    pendingResumeIntents.delete(failedSession.sessionId);
    abandonedClaudeSessions.add(failedSession.sessionId);
    activeClaudeSession = undefined;
    pendingClaudeOutput.delete(failedSession.sessionId);
    void recoverFromMissingResume(failedSession.cwd, retryIntents);
    return;
  }

  if (!activeClaudeSession || message.sessionId === activeClaudeSession.sessionId) {
    if (activeClaudeSession) {
      if (activeClaudeSession.mode === "resume") {
        pendingResumeIntents.delete(activeClaudeSession.sessionId);
      }
      applyClaudeEvents(message.events);
    } else {
      pendingClaudeOutput.set(message.sessionId, [
        ...(pendingClaudeOutput.get(message.sessionId) ?? []),
        ...message.events
      ]);
    }
  }
});

api?.claude.onExit((message) => {
  abandonedClaudeSessions.delete(message.sessionId);
  if (activeClaudeSession?.sessionId === message.sessionId) {
    renderStatus({ state: "ended", cwd: activeClaudeSession.cwd });
    activeClaudeSession = undefined;
    showToast("Claude session ended.");
  }
});

window.addEventListener("resize", () => {
  applyExplorerWidth(explorerWidth, false);
  applyTerminalWidth(terminalWidth, false);
  applyComposerHeight(composerHeight, false);
  fitTerminals();
});
document.addEventListener("click", () => hideContextMenu());


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
  // Real typing leaves history navigation and starts a fresh draft.
  historyIndex = inputHistory.length;
});

function setPromptValue(text: string): void {
  // Programmatic value changes do not fire "input", so update composer here.
  promptInput.value = text;
  composer = setComposerText(composer, text);
  promptInput.setSelectionRange(text.length, text.length);
}

function caretOnFirstLine(): boolean {
  return !promptInput.value.slice(0, promptInput.selectionStart ?? 0).includes("\n");
}

function caretOnLastLine(): boolean {
  return !promptInput.value.slice(promptInput.selectionEnd ?? 0).includes("\n");
}

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
    return;
  }
  if (event.isComposing || composer.isComposing) {
    return;
  }
  // Up/Down recall previous inputs, but only from the edge line so multi-line
  // editing keeps normal cursor movement.
  if (event.key === "ArrowUp" && caretOnFirstLine()) {
    if (historyIndex === inputHistory.length) {
      historyDraft = promptInput.value;
    }
    const move = navigateHistory(inputHistory, historyIndex, historyDraft, "up");
    if (move) {
      historyIndex = move.index;
      setPromptValue(move.text);
      event.preventDefault();
    }
  } else if (event.key === "ArrowDown" && caretOnLastLine()) {
    const move = navigateHistory(inputHistory, historyIndex, historyDraft, "down");
    if (move) {
      historyIndex = move.index;
      setPromptValue(move.text);
      event.preventDefault();
    }
  }
});

// Esc interrupts the message Claude is currently generating, wherever focus is.
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && claudeStatus.dataset.busy === "true") {
    event.preventDefault();
    void interruptClaude();
  }
});

// The dropdowns only stage a selection; nothing takes effect until Apply, which
// configures the session, persists the choice per folder, and refreshes the
// Code Start key. The button lights up while the selection differs from what is
// applied so the pending change is obvious.
function refreshApplyPending(): void {
  const pending = modelSelect.value !== claudeModel || effortSelect.value !== claudeEffort;
  applyModelButton.disabled = !pending;
  applyModelButton.classList.toggle("is-pending", pending);
}

async function applyModelSelection(): Promise<void> {
  claudeModel = modelSelect.value as ClaudeModel;
  claudeEffort = effortSelect.value as ClaudeEffort;
  refreshApplyPending();
  // Reflect the applied model in the status bar now instead of on the next poll.
  void refreshSessionStatus();
  const modelLabel = modelSelect.selectedOptions[0]?.textContent ?? claudeModel;
  const effortLabel = effortSelect.selectedOptions[0]?.textContent ?? claudeEffort;
  try {
    await api?.claude.apply(activeClaudeSession?.sessionId ?? "", {
      model: claudeModel,
      effort: claudeEffort
    });
    showToast(`${modelLabel} · ${effortLabel} 적용됨`);
  } catch {
    showToast("적용에 실패했습니다.");
  }
}

modelSelect.addEventListener("change", refreshApplyPending);
effortSelect.addEventListener("change", refreshApplyPending);
applyModelButton.addEventListener("click", () => {
  void applyModelSelection();
});

clearSessionButton.addEventListener("click", () => {
  void clearSession();
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

// Right-clicking the empty area below the rows targets the project folder
// itself, which no longer has a row of its own.
treeElement.addEventListener("contextmenu", (event) => {
  if ((event.target as HTMLElement).closest(".tree-row")) {
    return; // the row's own handler already opened the menu
  }
  event.preventDefault();
  selectedPath = projectRoot;
  contextPath = projectRoot;
  renderTree();
  showContextMenu(event.clientX, event.clientY);
});

contextMenu.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
  if (!button || !contextPath) {
    return;
  }

  const node = nodeAt(contextPath);
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
  // VS Code-style explorer: the header names the project FOLDER and the tree
  // lists its contents directly — no synthetic root row duplicating the name.
  const rootChildren = entriesToNodes((await api?.paths.list(projectRoot)) ?? []);
  treeRoots = replaceRoots(rootChildren);
  selectedPath = projectRoot;
  renderTree();

  const resumeSessionId = api?.runtime.resumeSessionId;
  if (resumeSessionId && api.runtime.folder) {
    resumeSessionInput.value = resumeSessionId;
  }
  try {
    await startClaudeSession(resumeSessionId);
  } catch (error) {
    renderStatus({ state: "ended" });
    appendConsoleOutput(`[Claude Code failed to start: ${error instanceof Error ? error.message : "unknown error"}]\n`);
  }
}

type SplitBounds = {
  minimum: number;
  maximum: number;
};

function readSplitSetting(name: string, fallback: number): number {
  try {
    const raw = window.localStorage.getItem(`claude-companion:split:${name}`);
    const value = raw === null ? fallback : Number(raw);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writeSplitSetting(name: string, value: number): void {
  try {
    window.localStorage.setItem(`claude-companion:split:${name}`, String(Math.round(value)));
  } catch {
    // A locked-down renderer can still resize; persistence is supplemental.
  }
}

function updateSplitterAria(separator: HTMLElement, value: number, bounds: SplitBounds): void {
  separator.setAttribute("aria-valuemin", String(Math.round(bounds.minimum)));
  separator.setAttribute("aria-valuemax", String(Math.round(bounds.maximum)));
  separator.setAttribute("aria-valuenow", String(Math.round(value)));
  separator.setAttribute("aria-valuetext", `${Math.round(value)} pixels`);
}

function explorerBounds(): SplitBounds {
  return { minimum: 210, maximum: 380 };
}

function terminalBounds(): SplitBounds {
  const minimumConsoleWidth = 300;
  const availableWidth = workSplitElement.clientWidth;
  const separatorWidth = terminalResizer.offsetWidth || 2;
  return {
    minimum: 260,
    maximum: availableWidth > 0
      ? Math.max(260, availableWidth - minimumConsoleWidth - separatorWidth)
      : 520
  };
}

function composerBounds(): SplitBounds {
  const minimumWorkHeight = 180;
  const sessionTabs = workspaceElement.querySelector<HTMLElement>(".session-tabs");
  const availableHeight = workspaceElement.clientHeight;
  const separatorHeight = composerResizer.offsetHeight || 2;
  return {
    minimum: 180,
    maximum: availableHeight > 0
      ? Math.max(180, availableHeight - (sessionTabs?.offsetHeight ?? 36) - separatorHeight - minimumWorkHeight)
      : 640
  };
}

function applyExplorerWidth(value: number, persist: boolean): void {
  explorerWidth = clampSplit(value, explorerBounds().minimum, explorerBounds().maximum);
  sidebar.style.width = `${explorerWidth}px`;
  sidebar.style.flexBasis = `${explorerWidth}px`;
  updateSplitterAria(explorerResizer, explorerWidth, explorerBounds());
  if (persist) {
    writeSplitSetting("explorer-width", explorerWidth);
  }
  if (terminalsReady) {
    fitTerminals();
  }
}

function applyTerminalWidth(value: number, persist: boolean): void {
  const bounds = terminalBounds();
  terminalWidth = clampSplit(value, bounds.minimum, bounds.maximum);
  terminalPanelElement.style.width = `${terminalWidth}px`;
  terminalPanelElement.style.flexBasis = `${terminalWidth}px`;
  updateSplitterAria(terminalResizer, terminalWidth, bounds);
  if (persist) {
    writeSplitSetting("terminal-width", terminalWidth);
  }
  if (terminalsReady) {
    fitTerminals();
  }
}

function applyComposerHeight(value: number, persist: boolean): void {
  const bounds = composerBounds();
  composerHeight = clampSplit(value, bounds.minimum, bounds.maximum);
  composerPanel.style.flexBasis = `${composerHeight}px`;
  updateSplitterAria(composerResizer, composerHeight, bounds);
  if (persist) {
    writeSplitSetting("composer-height", composerHeight);
  }
  if (terminalsReady) {
    fitTerminals();
  }
}

function installSplitter(
  separator: HTMLDivElement,
  orientation: SplitterOrientation,
  getValue: () => number,
  getBounds: () => SplitBounds,
  setValue: (value: number, persist: boolean) => void,
  pointerValue: (event: PointerEvent) => number
): void {
  const updateAria = (): void => {
    updateSplitterAria(separator, getValue(), getBounds());
  };

  separator.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 && event.pointerType !== "touch") {
      return;
    }

    event.preventDefault();
    separator.focus();
    separator.setPointerCapture(event.pointerId);
    document.body.classList.add("is-split-resizing", orientation === "vertical" ? "is-resizing-columns" : "is-resizing-rows");

    const onMove = (moveEvent: PointerEvent): void => {
      const bounds = getBounds();
      setValue(clampSplit(pointerValue(moveEvent), bounds.minimum, bounds.maximum), true);
    };
    const onEnd = (): void => {
      separator.removeEventListener("pointermove", onMove);
      separator.removeEventListener("pointerup", onEnd);
      separator.removeEventListener("pointercancel", onEnd);
      separator.removeEventListener("lostpointercapture", onEnd);
      document.body.classList.remove("is-split-resizing", "is-resizing-columns", "is-resizing-rows");
      if (separator.hasPointerCapture(event.pointerId)) {
        separator.releasePointerCapture(event.pointerId);
      }
    };

    separator.addEventListener("pointermove", onMove);
    separator.addEventListener("pointerup", onEnd);
    separator.addEventListener("pointercancel", onEnd);
    separator.addEventListener("lostpointercapture", onEnd);
  });

  separator.addEventListener("keydown", (event) => {
    const bounds = getBounds();
    const next = adjustSplitForKey(event.key, orientation, getValue(), bounds.minimum, bounds.maximum);
    if (next === undefined) {
      return;
    }

    event.preventDefault();
    setValue(next, true);
  });

  updateAria();
}

function installSplitters(): void {
  installSplitter(
    explorerResizer,
    "vertical",
    () => explorerWidth,
    explorerBounds,
    applyExplorerWidth,
    (event) => event.clientX - bodyShell.getBoundingClientRect().left
  );
  installSplitter(
    terminalResizer,
    "vertical",
    () => terminalWidth,
    terminalBounds,
    applyTerminalWidth,
    (event) => workSplitElement.getBoundingClientRect().right - event.clientX
  );
  installSplitter(
    composerResizer,
    "horizontal",
    () => composerHeight,
    composerBounds,
    applyComposerHeight,
    (event) => workspaceElement.getBoundingClientRect().bottom - event.clientY
  );
}

function fitTerminal(): void {
  fitAddon.fit();
  if (terminalSessionId && terminal.cols > 0 && terminal.rows > 0) {
    api?.terminal.resize(terminalSessionId, terminal.cols, terminal.rows);
  }
}

function fitTerminals(): void {
  fitTerminal();
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
  // Truth-of-record for the running model: the stream's init.model wins; before
  // the first reply, fall back to the dropdown's own label (the model the next
  // message will use) so the bar never reads a stale bridge value.
  sessionModel.textContent =
    parseModelId(lastStreamModel)?.label ??
    parseModelId(REPRESENTATIVE_MODEL_ID[claudeModel])?.label ??
    formatModelName(status.model);
  renderContextMeter(status);
}

/**
 * Relabel the picker's option with the running model's actual version, e.g.
 * `Opus 4.8`, so the shown version stays correct even if an alias later
 * resolves to a new release.
 */
function updateModelOptionLabel(model: string | undefined): void {
  const display = parseModelId(model);
  if (!display) {
    return;
  }
  const option = Array.from(modelSelect.options).find((entry) => entry.value === display.family);
  if (option && option.textContent !== display.label) {
    option.textContent = display.label;
  }
}

function renderContextMeter(status: SessionStatus): void {
  const percent = contextPercentValue(status);
  // The cover hides the unused right portion; revealing more of the fixed
  // green->red gradient turns the bar redder as the context fills.
  ctxMeterCover.style.left = percent === null ? "0%" : `${percent}%`;
  ctxMeterValue.textContent = percent === null ? "--" : `${percent}%`;
  ctxMeter.setAttribute("aria-valuenow", percent === null ? "0" : String(percent));
}

/**
 * The project folder itself has no tree row (its children are the top level),
 * so root-level operations use this synthetic node.
 */
function projectRootNode(): TreeNode {
  return {
    id: projectRoot,
    name: projectNameFromPath(projectRoot),
    path: projectRoot,
    kind: "directory",
    expanded: true,
    loaded: true,
    children: treeRoots
  };
}

function nodeAt(path: string): TreeNode | undefined {
  return path === projectRoot ? projectRootNode() : findNode(treeRoots, path);
}

function chevronSvg(): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M6 4l4 4-4 4");
  svg.append(path);
  return svg;
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

    // An SVG chevron centres in the 16px cell regardless of font metrics; the
    // old text glyphs ("›"/"⌄") sat on the text baseline and drifted out of
    // line with the row icon.
    const chevron = document.createElement("span");
    chevron.className = "tree-row__chevron";
    chevron.setAttribute("aria-hidden", "true");
    if (row.node.kind === "directory") {
      if (row.node.loading) {
        chevron.textContent = "…";
      } else {
        if (row.node.expanded) {
          chevron.classList.add("is-expanded");
        }
        chevron.append(chevronSvg());
      }
    }

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

/**
 * Re-list a directory from disk and swap it into the tree, keeping the
 * expanded state of entries that still exist. The project root swaps the
 * top-level list itself since it has no node of its own.
 */
async function refreshPath(directoryPath: string): Promise<void> {
  const fresh = entriesToNodes((await api?.paths.list(directoryPath)) ?? []);
  if (directoryPath === projectRoot) {
    treeRoots = replaceRoots(mergeFreshChildren(treeRoots, fresh));
  } else {
    const current = findNode(treeRoots, directoryPath);
    treeRoots = setNodeChildren(treeRoots, directoryPath, mergeFreshChildren(current?.children, fresh));
  }
  renderTree();
}

async function refreshNode(node: TreeNode): Promise<void> {
  try {
    await refreshPath(node.kind === "directory" ? node.path : parentPathOf(node.path));
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
  const input = document.createElement("input");
  input.className = "inline-create";
  input.placeholder = kind === "directory" ? "New folder name" : "New file name";
  if (row) {
    row.insertAdjacentElement("afterend", input);
  } else {
    // The project root has no row; creating at the top level puts the input
    // at the head of the tree.
    treeElement.prepend(input);
  }
  input.focus();

  // Removing a focused input fires a synchronous blur; detaching the blur
  // listener FIRST prevents the re-entrant remove() that used to throw inside
  // commitInlineCreate and silently skip the tree refresh after a create.
  function dispose(): void {
    input.removeEventListener("blur", onBlur);
    input.remove();
  }
  function onBlur(): void {
    dispose();
  }
  input.addEventListener("blur", onBlur);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      dispose();
    } else if (event.key === "Enter") {
      event.preventDefault();
      void commitInlineCreate(node, kind, input, dispose);
    }
  });
}

async function commitInlineCreate(
  node: TreeNode,
  kind: TreeNodeKind,
  input: HTMLInputElement,
  dispose: () => void
): Promise<void> {
  const request = createTargetFor(node, kind, input.value, node.kind === "directory");
  if (request.name.length === 0) {
    dispose();
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
    dispose();
  }

  if (createdPath) {
    // Always re-list the parent from disk so the new entry appears immediately
    // (sorted in place) without a manual refresh.
    selectedPath = createdPath;
    if (request.parentPath !== projectRoot) {
      treeRoots = setNodeExpanded(treeRoots, request.parentPath, true);
    }
    try {
      await refreshPath(request.parentPath);
    } catch {
      showToast("Refresh failed.");
    }
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

  diag("renderer.submitPrompt", {
    inputLength: promptInput.value.length,
    isComposing: composer.isComposing,
    hasIntent: result.intent !== undefined
  });

  if (!result.intent) {
    return;
  }

  if (result.intent.text.length > 0) {
    pushHistory(inputHistory, result.intent.text);
  }
  historyIndex = inputHistory.length;
  historyDraft = "";

  promptInput.value = composer.text;
  renderImagePreview();
  void sendIntent(result.intent);
}

async function interruptClaude(): Promise<void> {
  if (!api || !activeClaudeSession) {
    return;
  }
  const interrupted = await api.claude.interrupt(activeClaudeSession.sessionId);
  if (interrupted) {
    finishAssistantTurn();
    renderClaudeStatus("waiting");
    showToast("응답을 중단했습니다.");
  }
}

async function startClaudeSession(sessionId?: string): Promise<void> {
  if (!api) {
    renderStatus({ state: "ended" });
    return;
  }

  if (claudeStartPromise) {
    await claudeStartPromise;
    return;
  }

  claudeStartPromise = (async () => {
    clearConsoleOutput();
    diag("renderer.startClaudeSession", {
      cwd: projectRoot,
      mode: sessionId ? "resume" : "new"
    });
    activeClaudeSession = await api.claude.start({
      cwd: projectRoot,
      mode: sessionId ? "resume" : "new",
      sessionId,
      model: claudeModel,
      effort: claudeEffort
    });
    diag("renderer.startClaudeSession.ok", {
      sessionId: activeClaudeSession.sessionId,
      mode: activeClaudeSession.mode
    });
    renderStatus({ state: "running", cwd: activeClaudeSession.cwd });
    // A session no longer spawns a process until the first message, so there is
    // no startup stream to move the strip off its initial label. Invite input.
    renderClaudeStatus("ready");
    // Resuming a saved conversation shows its recent messages so the Console is
    // not blank; older ones load as the user scrolls up.
    if (sessionId) {
      await loadInitialHistory(sessionId);
    }
    const pending = pendingClaudeOutput.get(activeClaudeSession.sessionId);
    pendingClaudeOutput.delete(activeClaudeSession.sessionId);
    applyClaudeEvents(pending ?? []);
    promptInput.focus();
  })();

  try {
    await claudeStartPromise;
  } finally {
    claudeStartPromise = undefined;
  }
}

async function recoverFromMissingResume(cwd: string, retryIntents: SubmitIntent[] = []): Promise<void> {
  if (resumeRecoveryPromise) {
    await resumeRecoveryPromise;
    return;
  }

  resumeRecoveryPromise = (async () => {
    resumeSessionInput.value = "";
    clearConsoleOutput();
    renderStatus({ state: "idle", cwd });
    showToast("Saved Claude session was unavailable. Started a new session.");
    try {
      await startClaudeSession();
      for (const intent of retryIntents) {
        await sendIntent(intent);
      }
    } catch (error) {
      renderStatus({ state: "ended", cwd });
      appendConsoleOutput(`[Claude Code failed to start: ${error instanceof Error ? error.message : "unknown error"}]\n`);
    }
  })();

  try {
    await resumeRecoveryPromise;
  } finally {
    resumeRecoveryPromise = undefined;
  }
}

async function clearSession(): Promise<void> {
  if (activeClaudeSession) {
    await api?.claude.clear(activeClaudeSession.sessionId);
  }
  clearConsoleOutput();
  lastContextPercentage = undefined;
  lastStreamModel = undefined;
  renderStatus({ state: lastSessionState, contextPercentage: null });
  renderClaudeStatus("ready");
  showToast("새 대화를 시작했습니다.");
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
  try {
    diag("renderer.sendIntent", {
      activeSessionId: activeClaudeSession?.sessionId ?? "none",
      mode: activeClaudeSession?.mode ?? "none",
      textLength: intent.text.length,
      imageCount: intent.images.length
    });

    // Show the question immediately so the transcript reads as a conversation
    // rather than a stream of answers with no prompts.
    finishAssistantTurn();
    const label = intent.images.length > 0
      ? `${intent.text}${intent.text.length > 0 ? "\n" : ""}[이미지 ${intent.images.length}장 첨부]`
      : intent.text;
    appendTurn("user", label);
    // Respond before the process spawns so Enter feels immediate.
    renderClaudeStatus("requesting");
    if (!activeClaudeSession) {
      await startClaudeSession();
    }

    if (!api || !activeClaudeSession) {
      throw new Error("Claude session is not available");
    }

    const session = activeClaudeSession;
    // The dropdowns are the source of truth: apply them right before sending so
    // a change that landed while the session was still starting (or that never
    // reached configure) always takes effect on this message.
    await api.claude.configure(session.sessionId, { model: claudeModel, effort: claudeEffort });
    if (session.mode === "resume") {
      pendingResumeIntents.set(session.sessionId, [
        ...(pendingResumeIntents.get(session.sessionId) ?? []),
        intent
      ]);
    }

    if (intent.text.length > 0 || intent.images.length > 0) {
      try {
        await api.claude.write(
          session.sessionId,
          intent.text,
          intent.images.map((image) => image.dataUrl)
        );
      } catch (error) {
        if (session.mode === "resume") {
          const queued = pendingResumeIntents.get(session.sessionId) ?? [];
          const remaining = queued.filter((queuedIntent) => queuedIntent !== intent);
          if (remaining.length > 0) {
            pendingResumeIntents.set(session.sessionId, remaining);
          } else {
            pendingResumeIntents.delete(session.sessionId);
          }
        }
        throw error;
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    appendConsoleOutput(`[Claude Code error] Message was not sent: ${reason}\n`);
    showToast("Claude message was not sent.");
  }
}

async function setTerminalSplit(open: boolean, cwd = terminalCwdForSelection()): Promise<void> {
  appShell.classList.toggle("is-terminal-split", open);
  terminalSplitSign.textContent = open ? "x" : "+";
  if (open) {
    applyTerminalWidth(terminalWidth, false);
    await ensureProjectTerminal(cwd);
  }
  window.setTimeout(fitTerminals, 0);
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
    terminalPanelTitle.textContent = started.shell === "cmd" ? "Command Prompt" : "PowerShell";
    if (!terminalSessionId) {
      terminal.writeln("[project terminal did not return a session id]");
    }
  } finally {
    terminalStarting = false;
  }
}

function appendConsoleOutput(data: string): void {
  diag("renderer.consoleWrite", { length: data.length });
  if (!activeAssistantTurn) {
    activeAssistantTurn = appendTurn("assistant", "");
  }
  activeAssistantTurn.text += data;

  // Deltas arrive many times per second; repaint once per frame instead.
  if (repaintHandle === 0) {
    repaintHandle = requestAnimationFrame(() => {
      repaintHandle = 0;
      if (activeAssistantTurn) {
        paintTurn(activeAssistantTurn);
        scrollConsoleToBottom();
      }
    });
  }
}

function finishAssistantTurn(): void {
  if (!activeAssistantTurn) {
    return;
  }
  if (repaintHandle !== 0) {
    cancelAnimationFrame(repaintHandle);
    repaintHandle = 0;
  }
  paintTurn(activeAssistantTurn);
  activeAssistantTurn = undefined;
  scrollConsoleToBottom();
}

function renderContextUsage(usedTokens: number, windowTokens: number): void {
  const percentage = Math.min(100, Math.max(0, (usedTokens / windowTokens) * 100));
  lastContextPercentage = percentage;
  renderStatus({ state: lastSessionState, contextPercentage: percentage });
}

function renderClaudeStatus(phase: ClaudePhase | "error", detail?: string): void {
  const label = phase === "error"
    ? { text: "오류", detail: detail ?? "", busy: false }
    : formatClaudePhase(phase, detail);
  claudeStatus.dataset.phase = phase;
  claudeStatus.dataset.busy = String(label.busy);
  claudeStatusText.textContent = label.text;
  claudeStatusDetail.textContent = label.detail;
  claudeStatusDetail.title = label.detail;
}

function applyClaudeEvents(events: readonly ClaudeEvent[]): void {
  for (const event of events) {
    if (event.kind === "text") {
      appendConsoleOutput(event.text);
    } else if (event.kind === "phase") {
      diag("renderer.phase", { phase: event.phase, hasDetail: event.detail !== undefined });
      // A finished turn closes the assistant bubble so the next reply is its own.
      if (event.phase === "waiting" || event.phase === "ready") {
        finishAssistantTurn();
      }
      renderClaudeStatus(event.phase, event.detail);
    } else if (event.kind === "context") {
      diag("renderer.context", { usedTokens: event.usedTokens, windowTokens: event.windowTokens });
      if (event.model) {
        lastStreamModel = event.model;
      }
      renderContextUsage(event.usedTokens, event.windowTokens);
      updateModelOptionLabel(event.model);
    } else {
      finishAssistantTurn();
      renderClaudeStatus("error", event.message);
      appendTurn("error", event.message);
    }
  }
}

function setExplorerCollapsed(collapsed: boolean): void {
  appShell.classList.toggle("is-explorer-collapsed", collapsed);
  explorerRail.hidden = !collapsed;
}

function updateProjectName(sourcePath: string): void {
  titleProjectName.textContent = sourcePath;
  // The explorer header names the project FOLDER (like a VS Code workspace),
  // not the Stream Deck project label — the folder is the tree's top level.
  explorerProjectName.textContent = projectNameFromPath(projectRoot);
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

function showTerminalCopyToast(): void {
  if (terminalCopyToastTimer) {
    clearTimeout(terminalCopyToastTimer);
  }
  terminalCopyToast.hidden = false;
  terminalCopyToast.classList.add("is-visible");
  terminalCopyToastTimer = setTimeout(() => {
    terminalCopyToast.classList.remove("is-visible");
    terminalCopyToast.hidden = true;
  }, 1400);
}

async function refreshSessionStatus(): Promise<void> {
  try {
    const status = await api?.session?.status?.();
    if (status) {
      // The statusline bridge cannot see a --print session, so its context
      // reading is absent or stale; the live stream value wins when we have one.
      renderStatus({
        state: activeClaudeSession ? "running" : lastSessionState,
        ...status,
        ...(lastContextPercentage !== undefined
          ? { contextPercentage: lastContextPercentage }
          : {})
      });
    }
  } catch {
    // Status is supplemental; the Claude PTY remains usable if the cache is unavailable.
  }
}

function clearConsoleOutput(): void {
  if (repaintHandle !== 0) {
    cancelAnimationFrame(repaintHandle);
    repaintHandle = 0;
  }
  activeAssistantTurn = undefined;
  turns.length = 0;
  consoleElement.replaceChildren();
  historySessionId = undefined;
  historyOffset = 0;
  historyHasMore = false;
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
