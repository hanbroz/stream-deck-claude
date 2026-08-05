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
import type { GitBranchInfo } from "../main/git-branch";
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
import type { AgentOutcome, ClaudeEvent, ClaudePhase } from "../shared/claude-stream";
import {
  applySlashCommand,
  filterSlashCommands,
  isBridgedCliCommand,
  isTerminalHandoffCommand,
  type SlashCommand
} from "../shared/slash-commands";
import { applyMention, filterMentionFiles, mentionQueryAt } from "../shared/mention";
import { diag, setDiagSink } from "../shared/diag";
import {
  createAgentBoard,
  createAgentRow,
  createTurn,
  paintTurn,
  type AgentRowRefs,
  type Turn,
  type TurnRole
} from "./transcript";
import { companionBuildVersion } from "../shared/build-version";
import { explorerIconPath } from "./explorer-icons";
import { adjustSplitForKey, clampSplit, type SplitterOrientation } from "./splitter";
import {
  copyConfirmMessage,
  copyResultMessage,
  needsCopyConfirm,
  type CopyMeasurement
} from "../shared/copy-guard";
import { canRestoreToComposer, takeQueuedEntry } from "../shared/send-queue";

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
const collapseExplorerButton = mustElement<HTMLButtonElement>("collapse-explorer");
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
const commandMenu = mustElement<HTMLElement>("command-menu");
const mentionMenu = mustElement<HTMLElement>("mention-menu");
const promptHighlight = mustElement<HTMLElement>("prompt-highlight");
const gitBranchElement = mustElement<HTMLElement>("git-branch");
const gitBranchName = mustElement<HTMLElement>("git-branch-name");
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
const agentLive = mustElement<HTMLElement>("agent-live");

const buildVersion = companionBuildVersion();
titleBuildVersion.textContent = buildVersion;
// The window title is set from the project name in updateProjectName, so that
// several Companions open at once stay apart in the taskbar and Alt+Tab.

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
// /compact runs silently for a long time — SessionStart hooks alone can take
// minutes before the summary even starts — and then answers with an EMPTY
// result. Without a live placeholder the turn shows nothing at all and reads
// as if the command was ignored. Holds that placeholder while the run is out.
let compactingTurn: Turn | undefined;
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

// Right-click pastes, the Windows Terminal convention: PowerShell passes Ctrl+V
// through to the shell instead of pasting, so the terminal had no paste at all.
// The text is read in the main process for the same reason the copy above writes
// there — the sandboxed renderer has no navigator.clipboard.
terminalElement.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  const sessionId = terminalSessionId;
  if (!sessionId) {
    return;
  }
  void api?.clipboardReadText().then(
    (text) => {
      if (text.length === 0) {
        return;
      }
      diag("renderer.terminal.paste", { length: text.length });
      // A PTY reads CR as Enter, and Windows clipboards carry CRLF — pasting it
      // raw would submit a blank line after every real one.
      api?.terminal.write(sessionId, text.replace(/\r?\n/gu, "\r"));
      terminal.focus();
    },
    () => { /* nothing usable on the clipboard */ }
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
  // A killed session emits no phase boundary, so a /compact in flight would
  // leave its "compacting…" note on screen for good.
  discardCompactingPlaceholder();
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


collapseExplorerButton.addEventListener("click", () => {
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
  updateCommandMenu();
  updateMentionMenu();
  updatePromptHighlight();
});

// The mirror layer must scroll in lockstep with the textarea.
promptInput.addEventListener("scroll", () => {
  promptHighlight.scrollTop = promptInput.scrollTop;
  promptHighlight.scrollLeft = promptInput.scrollLeft;
});

// ── Slash command menu ──
// Typing "/" lists the available commands; picking one stages "/name " with
// the caret after the space so the user can add arguments, and Enter then
// sends it like any other message.
let slashCommands: SlashCommand[] = [];
let commandMatches: SlashCommand[] = [];
let commandIndex = 0;
let commandsScannedAtMs = 0;

function hideCommandMenu(): void {
  commandMatches = [];
  commandMenu.hidden = true;
}

function updateCommandMenu(): void {
  // Re-scan the inventory whenever a slash draft is being typed — BEFORE the
  // match check, or a command installed after launch could never appear (no
  // match in the stale list → early return → no rescan, a catch-22). The
  // per-message CLI runs already pick new skills/plugins up automatically.
  if (/^\/[^\s/]*$/u.test(promptInput.value) && Date.now() - commandsScannedAtMs > 30_000) {
    commandsScannedAtMs = Date.now();
    void api?.claude.commands().then((commands) => {
      slashCommands = commands;
      updateCommandMenu();
    }).catch(() => {});
  }
  const matches = filterSlashCommands(slashCommands, promptInput.value);
  if (!matches) {
    hideCommandMenu();
    return;
  }
  commandMatches = matches;
  commandIndex = Math.min(commandIndex, matches.length - 1);
  renderCommandMenu();
}

function renderCommandMenu(): void {
  commandMenu.replaceChildren();
  commandMatches.forEach((command, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `command-item${index === commandIndex ? " is-active" : ""}`;
    item.setAttribute("role", "option");

    const name = document.createElement("span");
    name.className = "command-item__name";
    name.textContent = `/${command.name}`;

    const description = document.createElement("span");
    description.className = "command-item__desc";
    description.textContent = command.description ?? command.source;

    item.append(name, description);
    // mousedown, not click: click fires after the textarea loses focus.
    item.addEventListener("mousedown", (event) => {
      event.preventDefault();
      selectCommand(index);
    });
    item.addEventListener("mouseenter", () => {
      commandIndex = index;
      renderCommandMenu();
    });
    commandMenu.append(item);
  });
  commandMenu.hidden = false;
}

/** Keyboard navigation only: hovering must not yank the scroll position. */
function scrollActiveCommandIntoView(): void {
  commandMenu.querySelector(".command-item.is-active")?.scrollIntoView({ block: "nearest" });
}

function selectCommand(index: number): void {
  const command = commandMatches[index];
  if (!command) {
    return;
  }
  setPromptValue(applySlashCommand(command));
  hideCommandMenu();
  promptInput.focus();
}

// ── "@" file mention menu ──
// Typing "@" lists project files at the caret; picking one inserts
// "@<relative path> " and highlights it in the input (mirror layer). An "@"
// left alone stays plain text.
let projectFiles: string[] = [];
let projectFilesScannedAtMs = 0;
// Messages sent while Claude is still generating wait here and auto-send when
// the turn ends (terminal parity), instead of failing with an error. Each one
// keeps the transcript turn it is already shown in, so queueing never hides what
// the user typed and the same turn is reused when it finally sends.
const pendingSendQueue: { intent: SubmitIntent; turn: Turn }[] = [];
let mentionMatches: string[] = [];
let mentionIndex = 0;
const pickedMentions = new Set<string>();

function hideMentionMenu(): void {
  mentionMatches = [];
  mentionMenu.hidden = true;
}

function updateMentionMenu(): void {
  const caret = promptInput.selectionStart ?? promptInput.value.length;
  const query = mentionQueryAt(promptInput.value, caret);
  if (!query) {
    hideMentionMenu();
    return;
  }
  // Refresh the file inventory while the picker is in use (30s cooldown), so
  // files created after launch appear without a restart.
  if (Date.now() - projectFilesScannedAtMs > 30_000) {
    projectFilesScannedAtMs = Date.now();
    void api?.paths.files().then((files) => {
      projectFiles = files;
      updateMentionMenu();
    }).catch(() => {});
  }
  const matches = filterMentionFiles(projectFiles, query.query);
  if (matches.length === 0) {
    hideMentionMenu();
    return;
  }
  mentionMatches = matches;
  mentionIndex = Math.min(mentionIndex, matches.length - 1);
  renderMentionMenu();
}

function renderMentionMenu(): void {
  mentionMenu.replaceChildren();
  mentionMatches.forEach((file, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `command-item${index === mentionIndex ? " is-active" : ""}`;
    item.setAttribute("role", "option");

    const name = document.createElement("span");
    name.className = "command-item__name";
    name.textContent = file.slice(file.lastIndexOf("/") + 1);

    const directory = document.createElement("span");
    directory.className = "command-item__desc";
    directory.textContent = file;

    item.append(name, directory);
    item.addEventListener("mousedown", (event) => {
      event.preventDefault(); // keep the textarea focused
      selectMention(index);
    });
    item.addEventListener("mouseenter", () => {
      mentionIndex = index;
      renderMentionMenu();
    });
    mentionMenu.append(item);
  });
  mentionMenu.hidden = false;
  mentionMenu.querySelector(".command-item.is-active")?.scrollIntoView({ block: "nearest" });
}

function selectMention(index: number): void {
  const picked = mentionMatches[index];
  const caret = promptInput.selectionStart ?? promptInput.value.length;
  const query = mentionQueryAt(promptInput.value, caret);
  if (!picked || !query) {
    hideMentionMenu();
    return;
  }
  const applied = applyMention(promptInput.value, query, caret, picked);
  pickedMentions.add(picked);
  promptInput.value = applied.text;
  composer = setComposerText(composer, applied.text);
  promptInput.setSelectionRange(applied.caret, applied.caret);
  hideMentionMenu();
  updatePromptHighlight();
  promptInput.focus();
}

/**
 * Mirror layer behind the textarea: transparent text, but each mention the
 * user picked through the UI gets a coloured chip background that shows
 * through. Hand-typed "@" text never highlights.
 */
function updatePromptHighlight(): void {
  promptHighlight.replaceChildren();
  const text = promptInput.value;
  if (pickedMentions.size === 0 || text.length === 0) {
    return;
  }
  const tokens = [...pickedMentions]
    .map((path) => `@${path}`)
    .sort((a, b) => b.length - a.length);
  let index = 0;
  while (index < text.length) {
    let bestPosition = -1;
    let bestToken = "";
    for (const token of tokens) {
      const position = text.indexOf(token, index);
      if (position !== -1 && (bestPosition === -1 || position < bestPosition)) {
        bestPosition = position;
        bestToken = token;
      }
    }
    if (bestPosition === -1) {
      promptHighlight.append(document.createTextNode(text.slice(index)));
      break;
    }
    if (bestPosition > index) {
      promptHighlight.append(document.createTextNode(text.slice(index, bestPosition)));
    }
    const chip = document.createElement("span");
    chip.className = "prompt-highlight__mention";
    chip.textContent = bestToken;
    promptHighlight.append(chip);
    index = bestPosition + bestToken.length;
  }
}

function setPromptValue(text: string): void {
  // Programmatic value changes do not fire "input", so update composer here.
  promptInput.value = text;
  composer = setComposerText(composer, text);
  promptInput.setSelectionRange(text.length, text.length);
  updateCommandMenu();
  updateMentionMenu();
  updatePromptHighlight();
}

promptInput.addEventListener("blur", () => {
  hideCommandMenu();
  hideMentionMenu();
});

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
  // The "@" mention menu owns navigation keys while open (same contract as
  // the slash menu below; the two are never open at the same time).
  if (mentionMatches.length > 0 && !(event.isComposing || composer.isComposing)) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      mentionIndex = (mentionIndex + step + mentionMatches.length) % mentionMatches.length;
      renderMentionMenu();
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      selectMention(mentionIndex);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      hideMentionMenu();
      return;
    }
  }
  // While the command menu is open it owns the navigation keys: Enter/Tab pick
  // (never send), arrows move, Escape closes without interrupting Claude.
  if (commandMatches.length > 0 && !(event.isComposing || composer.isComposing)) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      commandIndex = (commandIndex + step + commandMatches.length) % commandMatches.length;
      renderCommandMenu();
      scrollActiveCommandIntoView();
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      selectCommand(commandIndex);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      hideCommandMenu();
      return;
    }
  }
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

// Clicking an option in a ```question card sends that answer immediately,
// AskUserQuestion-style; the card locks so it reads as answered.
consoleElement.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-question-answer]");
  if (!button || button.disabled || claudeStatus.dataset.busy === "true") {
    return;
  }
  const answer = button.dataset.questionAnswer ?? "";
  if (answer.length === 0) {
    return;
  }
  const card = button.closest(".question-card");
  card?.classList.add("is-answered");
  card?.querySelectorAll("button").forEach((option) => {
    (option as HTMLButtonElement).disabled = true;
  });
  button.classList.add("is-chosen");
  // The label is whatever the model wrote, so it is sent as an answer only —
  // never as a local command. See SubmitIntent.origin.
  void sendIntent({ text: answer, images: [], origin: "model" });
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

// Dropping files from Windows Explorer copies them into the folder under the
// pointer. Only external drags carry "Files"; an internal drag of a row does
// not, so the tree ignores it and internal move stays out of scope.
let dropTargetRow: HTMLElement | undefined;
let dropTargetIsRoot = false;

function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

function rowUnder(target: EventTarget | null): HTMLElement | undefined {
  return (target as HTMLElement | null)?.closest<HTMLElement>(".tree-row") ?? undefined;
}

function rowForPath(path: string): HTMLElement | undefined {
  return treeElement.querySelector<HTMLElement>(`.tree-row[data-path="${cssEscape(path)}"]`) ?? undefined;
}

/**
 * Outlines the row for the *resolved destination*, not the row under the
 * pointer — hovering a file row targets its parent folder, so the parent is
 * what has to light up. The project root has no row of its own, so it
 * outlines the tree element instead.
 */
function highlightDropTarget(destination: string | undefined): void {
  const isRoot = destination !== undefined && destination === projectRoot;
  const row = destination !== undefined && !isRoot ? rowForPath(destination) : undefined;

  if (dropTargetRow !== row) {
    dropTargetRow?.classList.remove("is-drop-target");
    row?.classList.add("is-drop-target");
    dropTargetRow = row;
  }
  if (dropTargetIsRoot !== isRoot) {
    treeElement.classList.toggle("is-drop-target", isRoot);
    dropTargetIsRoot = isRoot;
  }
}

/**
 * A folder row takes the drop itself, a file row hands it to its parent, and
 * the empty area below the rows is the project folder — the same rule the
 * context menu already uses, so every spot in the tree is a valid destination.
 */
function dropDestination(target: EventTarget | null): string {
  const row = rowUnder(target);
  const node = row?.dataset.path ? nodeAt(row.dataset.path) : undefined;
  if (!node) {
    return projectRoot;
  }
  return node.kind === "directory" ? node.path : parentPathOf(node.path);
}

treeElement.addEventListener("dragover", (event) => {
  if (!carriesFiles(event)) {
    return;
  }
  // Without preventDefault the element is not a drop target at all.
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = "copy";
  }
  highlightDropTarget(dropDestination(event.target));
});

treeElement.addEventListener("dragleave", (event) => {
  // Moving between two rows fires dragleave on the one being left; only clear
  // the highlight when the pointer has actually left the tree.
  if (!treeElement.contains(event.relatedTarget as Node | null)) {
    highlightDropTarget(undefined);
  }
});

treeElement.addEventListener("drop", (event) => {
  if (!carriesFiles(event)) {
    return;
  }
  event.preventDefault();
  const destination = dropDestination(event.target);
  const files = Array.from(event.dataTransfer?.files ?? []);
  highlightDropTarget(undefined);
  void copyDroppedFiles(destination, files);
});

// Without this a file dropped outside the tree makes Chromium navigate the
// renderer to it. Scoped to file drags so ordinary text dragging — into the
// composer, or within it — keeps working.
document.addEventListener("dragover", (event) => {
  if (!carriesFiles(event)) {
    return;
  }
  event.preventDefault();
  // Outside the tree there is no destination, so say so rather than showing a
  // copy cursor over the console and composer.
  if (event.dataTransfer && !treeElement.contains(event.target as Node)) {
    event.dataTransfer.dropEffect = "none";
  }
});
document.addEventListener("drop", (event) => {
  if (carriesFiles(event)) {
    event.preventDefault();
  }
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
  } else if (button.dataset.action === "delete") {
    void deleteNode(node);
  }
});

/** Move a tree entry to the Recycle Bin after confirmation, then re-list its parent. */
async function deleteNode(node: TreeNode): Promise<void> {
  if (node.path === projectRoot) {
    showToast("프로젝트 폴더는 삭제할 수 없습니다.");
    return;
  }
  const label = node.kind === "directory" ? "폴더" : "파일";
  if (!window.confirm(`${label} '${node.name}'을(를) 휴지통으로 이동할까요?`)) {
    return;
  }
  try {
    await api?.paths.delete(node.path);
  } catch {
    showToast("삭제하지 못했습니다.");
    return;
  }
  if (selectedPath === node.path || selectedPath?.startsWith(`${node.path}\\`)) {
    selectedPath = projectRoot;
  }
  try {
    await refreshPath(parentPathOf(node.path));
  } catch {
    showToast("Refresh failed.");
  }
  showToast(`'${node.name}'을(를) 휴지통으로 이동했습니다.`);
}

async function copyDroppedFiles(destination: string, files: File[]): Promise<void> {
  if (!api) {
    return;
  }
  // A silent no-op here reads as a drop that landed nowhere; every other
  // outcome of a drop gets a toast, so this one should too.
  if (files.length === 0) {
    showToast("드롭한 항목의 경로를 읽지 못했습니다.");
    return;
  }

  const sourcePaths = files
    .map((file) => {
      try {
        // webUtils.getPathForFile throws for a File with no filesystem path
        // (a virtual or cloud-provider item). Treat it like an unreadable
        // entry rather than letting the drop die as an unhandled rejection.
        return api.paths.filePath(file);
      } catch {
        return "";
      }
    })
    .filter((entry) => entry.length > 0);
  if (sourcePaths.length === 0) {
    showToast("드롭한 항목의 경로를 읽지 못했습니다.");
    return;
  }

  let measurement: CopyMeasurement;
  try {
    measurement = await api.paths.measureCopy(sourcePaths);
  } catch {
    showToast("복사할 항목을 확인하지 못했습니다.");
    return;
  }

  if (
    needsCopyConfirm(measurement) &&
    !window.confirm(copyConfirmMessage(measurement, projectNameFromPath(destination)))
  ) {
    return;
  }

  let result;
  try {
    result = await api.paths.copyInto(destination, sourcePaths);
  } catch {
    showToast("복사하지 못했습니다.");
    return;
  }

  try {
    await refreshPath(destination);
  } catch {
    // The copy already landed; only the tree is stale. Saying "복사하지 못했습니다"
    // here would send the user back to drag again and make a (1) duplicate.
    showToast("복사했지만 탐색기를 새로고침하지 못했습니다.");
    return;
  }

  showToast(copyResultMessage(result));
}

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
  // Branches change from the embedded terminal, so the indicator has to poll.
  // .git/HEAD is one small read, but it is far less volatile than the session
  // status above — 5s keeps it current without a read every tick.
  void refreshGitBranch();
  setInterval(() => {
    void refreshGitBranch();
  }, 5_000);
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
  // Load the "/" menu inventory in the background; failure just leaves it empty.
  void api?.claude.commands().then((commands) => {
    slashCommands = commands;
  }).catch(() => {});
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
    // Images are draggable by default in Chromium; without this, dragging a
    // row by its icon starts a ghost drag carrying the icon URL instead of
    // nothing (there is no internal row drag — see the drop handlers above).
    icon.draggable = false;

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
    // Pasted images are all called image.png, so showing the name says nothing
    // and crowds out the one thing that identifies the attachment — the picture
    // itself. The name stays as alt text, where it is still the only
    // description a screen reader has.
    thumbnail.alt = image.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "x";
    remove.title = "Remove image";
    remove.addEventListener("click", () => {
      composer = removeComposerImage(composer, image.id);
      renderImagePreview();
    });
    chip.append(thumbnail, remove);
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
  // The draft is gone; picked mentions belong to it, so hand-typed copies of
  // the same path in the NEXT draft must not auto-highlight.
  pickedMentions.clear();
  updatePromptHighlight();
  hideMentionMenu();
  renderImagePreview();
  void sendIntent(result.intent);
}

async function interruptClaude(): Promise<void> {
  if (!api || !activeClaudeSession) {
    return;
  }
  const interrupted = await api.claude.interrupt(activeClaudeSession.sessionId);
  if (interrupted) {
    // The process was killed mid-run — nothing was compacted.
    discardCompactingPlaceholder();
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
  pendingSendQueue.length = 0; // a fresh conversation abandons queued sends
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

/** The transcript label for a submission, noting any attached images. */
function composerTurnLabel(intent: SubmitIntent): string {
  return intent.images.length > 0
    ? `${intent.text}${intent.text.length > 0 ? "\n" : ""}[이미지 ${intent.images.length}장 첨부]`
    : intent.text;
}

/**
 * Re-read the "/" inventory now rather than waiting out the 30s rescan window,
 * so a plugin or skill installed seconds ago is selectable immediately.
 */
async function reloadCommandInventory(): Promise<void> {
  let commands: SlashCommand[] | undefined;
  try {
    commands = await api?.claude.commands();
  } catch (error) {
    // Left unhandled this surfaced as "Message was not sent", which is the
    // wrong story: nothing was being sent.
    appendTurn(
      "error",
      `명령 목록을 다시 읽지 못했습니다: ${error instanceof Error ? error.message : "알 수 없는 오류"}`
    );
    return;
  }
  // An empty result is far more likely a failed scan than a project with no
  // commands at all — keep what we have rather than blanking the menu and
  // then sitting on that blank for the 30s rescan window.
  if (!commands || commands.length === 0) {
    appendTurn("error", "명령 목록을 다시 읽지 못했습니다 (결과가 비어 있음). 기존 목록을 유지합니다.");
    return;
  }
  slashCommands = commands;
  commandsScannedAtMs = Date.now();
  const count = (source: SlashCommand["source"]): number =>
    commands.filter((command) => command.source === source).length;
  appendTurn(
    "notice",
    `명령 목록을 다시 읽었습니다 — 총 ${commands.length}개 (플러그인 ${count("plugin")}, ` +
      `프로젝트 ${count("project")}, 사용자 ${count("user")}, 기본 ${count("builtin")}). ` +
      `Claude 쪽은 메시지마다 새 프로세스가 디스크에서 다시 읽으므로 별도 재로드가 필요 없습니다.`
  );
}

/**
 * Open the TERMINAL tab and start an interactive Claude there with the slash
 * command already applied. `claude /config` resolves the command before any
 * model call, so the panel opens immediately and costs nothing.
 *
 * Only the allowlisted command NAME is written — no text the user typed
 * reaches the shell, so there is nothing to escape.
 */
async function handOffToTerminal(name: string): Promise<void> {
  const reusedTerminal = terminalSessionId !== undefined;
  await setTerminalSplit(true, projectRoot);
  if (!api || !terminalSessionId) {
    appendTurn("error", "TERMINAL 탭을 열지 못했습니다.");
    return;
  }
  const line = `claude /${name}`;
  // A shell this handoff just started is certainly sitting at its prompt. An
  // existing terminal may already be running something — including a Claude
  // TUI, where a stray Enter would send this line to the model as a message —
  // so there the line is only staged and the user presses Enter.
  api.terminal.write(terminalSessionId, reusedTerminal ? line : `${line}\r`);
  // terminal.write is fire-and-forget (ipcRenderer.send), so nothing here can
  // confirm the shell accepted the line — the wording must not claim it did.
  appendTurn(
    "notice",
    reusedTerminal
      ? `TERMINAL 탭에 \`${line}\` 을 입력해 뒀습니다. 터미널이 비어 있는지 확인하고 Enter를 누르세요.`
      : `TERMINAL 탭으로 \`${line}\` 을 보냈습니다. 이 대화와는 별개의 새 세션이며, ` +
        `프롬프트가 아직 준비 중이었다면 입력이 표시되지 않을 수 있으니 탭을 확인하세요.`
  );
}

/**
 * Run `claude <name> <args>` and show its output in place of a model reply.
 * The turn is appended first and repainted on completion, so a slow command
 * (a marketplace fetch) does not look like the app swallowed the input.
 */
// Why the output cannot be trusted as the whole answer. Without these a
// timeout's partial listing reads exactly like a complete one.
const CLI_FAILURE_NOTES: Record<string, string> = {
  timeout:
    "60초 안에 끝나지 않아 중단했습니다. 위 출력은 중단 시점까지의 일부이며 작업이 끝나지 않았을 수 있습니다. " +
    "오래 걸리거나 입력을 요구하는 명령은 TERMINAL 탭에서 직접 실행하세요.",
  truncated: "출력이 너무 길어 1MB에서 잘렸습니다. 전체를 보려면 TERMINAL 탭에서 실행하세요.",
  spawn: "claude 실행 파일을 찾지 못했거나 실행할 수 없습니다. PATH 설정을 확인하세요."
};

async function runBridgedCommand(name: string, argumentText: string): Promise<void> {
  const turn = appendTurn("assistant", `\`claude ${name}\` 실행 중…`);
  try {
    const result = await api?.cli?.run?.(name, argumentText);
    if (!result) {
      turn.text = "CLI를 실행할 수 없습니다.";
      return;
    }
    // Fenced so the CLI's own alignment survives the Markdown renderer.
    const body = result.output || (result.ok ? "(출력 없음)" : "실행에 실패했습니다.");
    const heading = result.ok ? "" : `\`claude ${name}\` 실행 실패\n\n`;
    const note = result.failure ? CLI_FAILURE_NOTES[result.failure] : undefined;
    turn.text = `${heading}\`\`\`\n${body}\n\`\`\`${note ? `\n\n> ${note}` : ""}`;
  } catch (error) {
    // The IPC call itself can reject (no handler registered, main gone).
    // Without this the "실행 중…" note would sit on screen for good.
    turn.text = `\`claude ${name}\` 을(를) 실행할 수 없습니다: ${
      error instanceof Error ? error.message : "알 수 없는 오류"
    }`;
  } finally {
    paintTurn(turn);
    scrollConsoleToBottom();
  }
}

/**
 * Send a message, or queue it when Claude is still generating.
 *
 * `queuedTurn` is the turn a queued message is already displayed in: it is
 * reused rather than appended again, so the message keeps its place in the
 * transcript from the moment it was typed.
 */
async function sendIntent(intent: SubmitIntent, queuedTurn?: Turn): Promise<void> {
  try {
    diag("renderer.sendIntent", {
      activeSessionId: activeClaudeSession?.sessionId ?? "none",
      mode: activeClaudeSession?.mode ?? "none",
      textLength: intent.text.length,
      imageCount: intent.images.length
    });

    // The message has left the queue no matter which branch below claims it,
    // so shed the queued badge here rather than only on the send path — an
    // early return used to leave a live cancel button on a message that was
    // never going to be sent.
    if (queuedTurn) {
      queuedTurn.element.classList.remove("is-queued");
      removeQueuedBadge(queuedTurn);
    }

    // Local commands are privileged — they run CLI subcommands, write into a
    // live shell, or reset the conversation — so only text the USER typed may
    // reach them. A question-card option is written by the model.
    const localCommandsAllowed = intent.origin !== "model";

    // /clear is the Companion's own command: start a fresh conversation
    // instead of sending the text to Claude. It drops the queue itself.
    if (localCommandsAllowed && intent.text.trim() === "/clear" && intent.images.length === 0) {
      await clearSession();
      return;
    }

    // /reload-skills and /reload-plugins are the Companion's own too. Claude
    // needs no reload here: every message spawns a fresh `claude --print` that
    // reads skills and plugins off disk, so the only thing that can lag behind
    // an install is this app's "/" inventory.
    const reloadCommand = intent.text.trim();
    if (
      localCommandsAllowed &&
      (reloadCommand === "/reload-skills" || reloadCommand === "/reload-plugins") &&
      intent.images.length === 0
    ) {
      finishAssistantTurn();
      if (!queuedTurn) {
        appendTurn("user", intent.text);
      }
      await reloadCommandInventory();
      // No run starts here, so no phase event will come to release the queue.
      flushNextPendingSend();
      return;
    }

    // Terminal-only builtins never reach print mode; answer locally and
    // instantly instead of paying a CLI round-trip for a polite refusal.
    const firstToken = intent.text.trim().split(/\s+/u)[0] ?? "";
    if (localCommandsAllowed && firstToken.startsWith("/") && intent.images.length === 0) {
      // /plugin and /mcp only look terminal-only: the CLI serves them as real
      // non-interactive subcommands, so run those and print what they said.
      const bridged = firstToken.slice(1);
      if (isBridgedCliCommand(bridged)) {
        finishAssistantTurn();
        if (!queuedTurn) {
          appendTurn("user", intent.text);
        }
        await runBridgedCommand(bridged, intent.text.trim().slice(firstToken.length).trim());
        flushNextPendingSend();
        return;
      }

      const command = slashCommands.find((entry) => `/${entry.name}` === firstToken);
      if (command?.description?.includes("터미널 전용")) {
        finishAssistantTurn();
        // A queued message is already on screen; appending again would
        // duplicate it.
        if (!queuedTurn) {
          appendTurn("user", intent.text);
        }
        const hint = command.description.replace(/\s*·\s*터미널 전용\s*$/u, "");
        if (isTerminalHandoffCommand(command.name)) {
          await handOffToTerminal(command.name);
        } else {
          appendTurn(
            "assistant",
            `${firstToken} 명령은 Claude Code 터미널 전용입니다. (${hint}) 터미널에서 열어도 ` +
              `이 대화가 아닌 새 대화에 적용되므로 넘기지 않았습니다.`
          );
        }
        flushNextPendingSend();
        return;
      }
    }

    // A message sent while Claude is still generating queues instead of failing
    // (terminal parity): it auto-sends the moment the turn ends. It is shown as a
    // pending turn right away — queueing it invisibly read as the input having
    // been thrown away, since the composer is cleared on submit either way.
    if (!queuedTurn && claudeStatus.dataset.busy === "true") {
      const turn = appendTurn("user", composerTurnLabel(intent));
      turn.element.classList.add("is-queued");
      attachQueuedBadge(turn);
      pendingSendQueue.push({ intent, turn });
      showToast("응답 생성 중 — 다음 작업으로 예약했습니다.");
      return;
    }

    // Show the question immediately so the transcript reads as a conversation
    // rather than a stream of answers with no prompts. A queued message is
    // already on screen (its pending marker was cleared above), so only a
    // fresh message needs a new turn appended here.
    finishAssistantTurn();
    // Respond before the process spawns so Enter feels immediate.
    renderClaudeStatus("requesting");
    // Starting a session can wipe the console (a resume of a deleted
    // transcript clears it), so draw nothing until it is up. When a session
    // already exists this does not await, so nothing is delayed.
    if (!activeClaudeSession) {
      await startClaudeSession();
    }
    if (!queuedTurn) {
      appendTurn("user", composerTurnLabel(intent));
    }
    // A placeholder from a /compact whose turn never resolved would be
    // orphaned in the DOM by the assignment below — drop it first.
    if (compactingTurn) {
      removeTurn(compactingTurn);
      compactingTurn = undefined;
    }
    if (firstToken === "/compact") {
      compactingTurn = appendTurn(
        "notice",
        "대화 컨텍스트를 압축하는 중입니다… 시작 훅과 요약을 합쳐 수 분 걸릴 수 있습니다."
      );
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
    // The send never got started, so a /compact placeholder raised just above
    // would otherwise outlive this turn and be resolved as success later.
    discardCompactingPlaceholder();
    const reason = error instanceof Error ? error.message : "unknown error";
    appendConsoleOutput(`[Claude Code error] Message was not sent: ${reason}\n`);
    showToast("Claude message was not sent.");
  }
}

const RELOGIN_COMMAND = "claude auth login";

/**
 * Recover from an expired login without leaving the app.
 *
 * `claude --print` carries no TTY, so the sign-in flow cannot run in the
 * conversation itself. The project terminal is a real PTY, so opening it and
 * handing it `claude auth login` puts the user one Enter away from being logged
 * in again. A terminal the user already opened is left alone — it may be running
 * something — and only gets the panel focus plus the instruction.
 */
let reloginPending = false;
async function offerRelogin(): Promise<void> {
  if (reloginPending) {
    return;
  }
  reloginPending = true;
  const hadTerminal = terminalSessionId !== undefined;
  try {
    await setTerminalSplit(true, projectRoot);
    const autoTyped = !hadTerminal && terminalSessionId !== undefined;
    if (autoTyped) {
      api?.terminal.write(terminalSessionId as string, `${RELOGIN_COMMAND}\r`);
    }
    appendTurn(
      "notice",
      autoTyped
        ? `Claude Code 로그인이 만료되었습니다. 아래 터미널에서 \`${RELOGIN_COMMAND}\` 를 실행했습니다. 로그인을 마친 뒤 메시지를 다시 보내주세요.`
        : `Claude Code 로그인이 만료되었습니다. 아래 터미널에서 \`${RELOGIN_COMMAND}\` 를 실행해 로그인한 뒤 메시지를 다시 보내주세요.`
    );
    showToast("Claude 로그인이 만료되었습니다.");
  } finally {
    reloginPending = false;
  }
}

/**
 * Give up on queued messages when the turn ends in failure.
 *
 * The queue only flushes on a `waiting`/`ready` phase, which a failed or
 * auth-expired turn never reaches. Without this the "다음 작업 예약" badge kept a
 * promise it could not honour: the turn sat on screen greyed out forever, and a
 * later message landed *below* it, so the transcript order lied too.
 */
function releasePendingSends(reason: string): void {
  if (pendingSendQueue.length === 0) {
    return;
  }
  const released = pendingSendQueue.splice(0, pendingSendQueue.length);
  for (const { turn } of released) {
    turn.element.classList.add("is-unsent");
    markQueuedBadgeUnsent(turn);
  }
  appendTurn(
    "notice",
    `${reason} 예약해 둔 메시지 ${released.length}건은 전송되지 않았습니다. 다시 보내주세요.`
  );
}

/**
 * The queued badge, as a real element.
 *
 * It used to be `.turn__body::before` with a CSS `content:` string, which is
 * why there was no way to cancel: a pseudo-element is not in the DOM and
 * receives no clicks. A user turn is painted exactly once — only assistant
 * turns stream — so nothing repaints over this later.
 */
function attachQueuedBadge(turn: Turn): void {
  const badge = document.createElement("div");
  badge.className = "turn__queued-badge";

  const label = document.createElement("span");
  label.className = "turn__queued-label";
  label.textContent = "다음 작업 예약";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "turn__queued-cancel";
  cancel.setAttribute("aria-label", "예약 취소");
  cancel.textContent = "✕";
  cancel.addEventListener("click", () => cancelQueuedSend(turn));

  badge.append(label, cancel);
  turn.body.prepend(badge);
}

/** The message left the queue toward Claude: the badge has nothing left to say. */
function removeQueuedBadge(turn: Turn): void {
  turn.body.querySelector(".turn__queued-badge")?.remove();
}

/**
 * The turn failed, so the queue was released without sending. Keep the badge as
 * the record that this never went out, but drop the button — there is no longer
 * a queue entry to cancel.
 */
function markQueuedBadgeUnsent(turn: Turn): void {
  turn.body.querySelector(".turn__queued-cancel")?.remove();
  const label = turn.body.querySelector(".turn__queued-label");
  if (label) {
    label.textContent = "전송되지 않음";
  }
}

/** Drop a turn from the transcript entirely, model and DOM together. */
function removeTurn(turn: Turn): void {
  const index = turns.indexOf(turn);
  if (index >= 0) {
    turns.splice(index, 1);
  }
  turn.element.remove();
}

/**
 * Drop the /compact placeholder without claiming anything happened. Every path
 * that ends the turn WITHOUT a real compaction goes through here — a stream
 * error, an auth wall, an interrupt, or the session being killed — because a
 * placeholder left behind is later resolved as success by the next `waiting`.
 */
function discardCompactingPlaceholder(): void {
  if (!compactingTurn) {
    return;
  }
  removeTurn(compactingTurn);
  compactingTurn = undefined;
}

/**
 * Release the next queued message, if any. A turn boundary releases one — and
 * so must every local-command branch that returns without starting a run, or
 * the queue stalls with no further phase event ever coming to wake it.
 */
function flushNextPendingSend(): void {
  const queued = pendingSendQueue.shift();
  if (queued) {
    setTimeout(() => { void sendIntent(queued.intent, queued.turn); }, 0);
  }
}

/** Hand a cancelled message back to the composer, unless that would clobber a draft. */
function restoreComposer(intent: SubmitIntent): boolean {
  if (!canRestoreToComposer(promptInput.value, composer.images.length)) {
    return false;
  }
  promptInput.value = intent.text;
  composer = addComposerImages(setComposerText(composer, intent.text), intent.images);
  renderImagePreview();
  promptInput.focus();
  promptInput.setSelectionRange(intent.text.length, intent.text.length);
  return true;
}

function cancelQueuedSend(turn: Turn): void {
  const entry = takeQueuedEntry(pendingSendQueue, turn);
  if (!entry) {
    return; // already flushed — the click lost the race with the send
  }
  removeTurn(turn);
  const restored = restoreComposer(entry.intent);
  if (!restored) {
    // restoreComposer only focuses the composer when it actually restores a
    // draft. removeTurn just deleted the element that held the focused cancel
    // button, so without this a keyboard user cancelling while holding their
    // own draft loses their place to document.body.
    promptInput.focus();
  }
  showToast(
    restored
      ? "예약을 취소하고 작성기로 되돌렸습니다."
      : "예약을 취소했습니다."
  );
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
  lastStatusPhase = phase;
  lastStatusDetail = detail;
  const label = phase === "error"
    ? { text: "오류", detail: detail ?? "", busy: false }
    : formatClaudePhase(phase, detail);
  // Parallel subagents (2+) get a persistent n/m prefix so the fan-out stays
  // visible while the strip churns through tool/thinking phases. It also
  // survives an idle phase: background agents run on after the reply ends.
  //
  // The 2+ threshold is deliberately NOT the board's: the pinned panel carries
  // per-agent detail from the very first agent, so the strip is left to say the
  // one thing the panel cannot — how big the fan-out is — and a lone agent
  // needs no count for that.
  const counts = agentCounts();
  const running = counts.total - counts.done;
  const detailText = running > 0 && counts.total >= 2
    ? `Agent ${counts.done}/${counts.total}${label.detail ? ` · ${label.detail}` : ""}`
    : label.detail;
  claudeStatus.dataset.phase = phase;
  claudeStatus.dataset.busy = String(label.busy);
  claudeStatusText.textContent = label.text;
  claudeStatusDetail.textContent = detailText;
  claudeStatusDetail.title = detailText;
}

type AgentBoardRow = { refs: AgentRowRefs; startedAt: number; done: boolean };
let agentBoard: { root: HTMLElement; rows: HTMLElement } | undefined;
const agentRows = new Map<string, AgentBoardRow>();
let agentTimer: number | undefined;
let lastStatusPhase: ClaudePhase | "error" = "ready";
let lastStatusDetail: string | undefined;

/**
 * How a settled agent row reads. "unknown" is deliberately NOT the failure
 * mark: the app could not see the result, and a grey "?" says that, where a red
 * "✗" claimed something it did not know.
 */
const AGENT_OUTCOME: Record<AgentOutcome, { icon: string; className: string; title: string }> = {
  ok: { icon: "✓", className: "is-done", title: "완료" },
  failed: { icon: "✗", className: "is-failed", title: "실패로 끝났습니다" },
  unknown: {
    icon: "?",
    className: "is-stopped",
    title: "실행하던 프로세스가 정리되어 결과를 확인하지 못했습니다. 실패한 것은 아닙니다."
  }
};

function agentCounts(): { done: number; total: number } {
  let done = 0;
  for (const row of agentRows.values()) {
    if (row.done) {
      done += 1;
    }
  }
  return { done, total: agentRows.size };
}

function formatAgentElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

function ensureAgentTimer(): void {
  if (agentTimer !== undefined) {
    return;
  }
  agentTimer = window.setInterval(() => {
    const now = Date.now();
    let running = false;
    for (const row of agentRows.values()) {
      if (row.done) {
        continue;
      }
      running = true;
      row.refs.time.textContent = formatAgentElapsed(now - row.startedAt);
    }
    if (!running) {
      window.clearInterval(agentTimer);
      agentTimer = undefined;
    }
  }, 1000);
}

function handleAgentEvent(event: Extract<ClaudeEvent, { kind: "agent" }>): void {
  if (event.op === "start") {
    const refs = createAgentRow(event.agentType, event.description);
    agentRows.set(event.toolUseId, { refs, startedAt: Date.now(), done: false });
    // A lone agent gets a row too. The strip does label a synchronous one
    // (`작업 진행 중 · Task …`), but that label says nothing about how long it has
    // been going, which tool it is on, or that it is an agent at all — and a
    // background agent gets no label whatsoever, because the main thread keeps
    // churning through its own phases while the agent works.
    let board = agentBoard;
    if (!board) {
      board = createAgentBoard();
      agentBoard = board;
      agentLive.append(board.root);
    }
    board.rows.append(refs.root);
    // A wide fan-out is taller than the panel, and a row nobody can see reports
    // nothing; the newest agent is the one worth showing.
    agentLive.scrollTop = agentLive.scrollHeight;
    ensureAgentTimer();
  } else if (event.op === "activity") {
    const row = agentRows.get(event.toolUseId);
    if (row && !row.done) {
      row.refs.detail.textContent = event.detail;
    }
  } else {
    const row = agentRows.get(event.toolUseId);
    if (row && !row.done) {
      row.done = true;
      row.refs.root.classList.remove("is-running");
      row.refs.root.classList.add(AGENT_OUTCOME[event.outcome].className);
      row.refs.icon.textContent = AGENT_OUTCOME[event.outcome].icon;
      row.refs.root.title = AGENT_OUTCOME[event.outcome].title;
      row.refs.time.textContent = formatAgentElapsed(Date.now() - row.startedAt);
    }
  }
  if (lastStatusPhase !== "error") {
    renderClaudeStatus(lastStatusPhase, lastStatusDetail);
  }
}

/**
 * Fold the pinned panel away once every agent in the batch has finished, moving
 * its board into the console so the run keeps a record.
 *
 * The turn that ends is the only trigger — deliberately not the agent `end`
 * that settles the batch, and not the next `start`. A background agent outlives
 * its turn, so settling can land while the NEXT turn is already streaming, and
 * moving the board right then closed that reply's bubble mid-sentence, wedged
 * an unrelated board into it and yanked the console to the bottom under the
 * reader. Settling also happens between agents that run one after another
 * inside a single turn, and retiring there left a one-row board per agent
 * instead of the one block per turn the console is meant to keep.
 *
 * A run that dies now emits an idle phase too, so a batch orphaned by a crash
 * still lands here rather than sitting in the panel for good.
 */
function retireSettledAgentBoard(): void {
  const counts = agentCounts();
  if (!agentBoard || counts.total === 0 || counts.done < counts.total) {
    return;
  }
  finishAssistantTurn();
  consoleElement.append(agentBoard.root);
  scrollConsoleToBottom();
  agentRows.clear();
  agentBoard = undefined;
}

function resetAgentBoard(): void {
  agentRows.clear();
  agentBoard = undefined;
  agentLive.replaceChildren();
  if (agentTimer !== undefined) {
    window.clearInterval(agentTimer);
    agentTimer = undefined;
  }
}

function applyClaudeEvents(events: readonly ClaudeEvent[]): void {
  for (const event of events) {
    if (event.kind === "text") {
      appendConsoleOutput(event.text);
    } else if (event.kind === "phase") {
      diag("renderer.phase", { phase: event.phase, hasDetail: event.detail !== undefined });
      // A finished turn closes the assistant bubble so the next reply is its own.
      // Agent rows are deliberately left alone: background agents keep working
      // after the reply ends, and the main process closes their rows when the
      // run actually dies.
      if (event.phase === "waiting" || event.phase === "ready") {
        // Only a real run ending emits `waiting`; `ready` is synthesised by
        // clear() and interrupt(), where nothing was compacted. Resolving on
        // `ready` declared success for a compaction the user had just aborted.
        //
        // Checked before finishAssistantTurn clears the handle, so the empty
        // reply that a real compaction gives can be told apart from a spoken
        // one like "Not enough messages to compact."
        if (compactingTurn && event.phase === "waiting") {
          const placeholder = compactingTurn;
          compactingTurn = undefined;
          if (activeAssistantTurn) {
            // The CLI answered in words; its own message says it better.
            removeTurn(placeholder);
          } else {
            placeholder.text =
              "대화 컨텍스트를 압축했습니다. 다음 메시지부터 CTX 사용량이 줄어듭니다.";
            paintTurn(placeholder);
          }
        }
        finishAssistantTurn();
        // A turn boundary is the safe moment to hand a finished batch over to
        // the console; nothing is mid-render here.
        retireSettledAgentBoard();
      }
      renderClaudeStatus(event.phase, event.detail);
      // The turn is over: flush the message the user queued mid-generation.
      if (event.phase === "waiting" || event.phase === "ready") {
        flushNextPendingSend();
      }
    } else if (event.kind === "context") {
      diag("renderer.context", { usedTokens: event.usedTokens, windowTokens: event.windowTokens });
      if (event.model) {
        lastStreamModel = event.model;
      }
      renderContextUsage(event.usedTokens, event.windowTokens);
      updateModelOptionLabel(event.model);
    } else if (event.kind === "agent") {
      handleAgentEvent(event);
    } else if (event.kind === "login") {
      // Nothing was compacted; the run stopped at the auth wall. A `waiting`
      // still follows this, and it would have declared the compaction done.
      discardCompactingPlaceholder();
      finishAssistantTurn();
      // The conversation is intact and the session is free again — the account
      // just has to sign in, so the strip goes back to inviting input.
      renderClaudeStatus("ready");
      releasePendingSends("로그인이 만료되어");
      void offerRelogin();
    } else {
      // A failed turn never reaches the phase boundary that resolves this, and
      // the error turn below explains the outcome better than the placeholder.
      discardCompactingPlaceholder();
      finishAssistantTurn();
      renderClaudeStatus("error", event.message);
      appendTurn("error", event.message);
      releasePendingSends("턴이 오류로 끝나");
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
  // The frameless window still reports document.title to the taskbar, Alt+Tab
  // and window previews, where several Companions are otherwise identical.
  // Project name leads because those surfaces truncate from the right.
  document.title = `${sourcePath} - Code Deck Companion ${buildVersion}`;
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

function renderGitBranch(info: GitBranchInfo | undefined): void {
  // No answer at all is NOT the same as "not a repository". Claiming the
  // latter sends the user hunting for a .git that is actually there.
  if (!info) {
    gitBranchElement.classList.add("is-untracked");
    gitBranchElement.classList.remove("is-detached");
    gitBranchElement.title = "Git 상태를 읽지 못했습니다";
    gitBranchName.textContent = "확인 중";
    return;
  }
  const detached = info.tracked && info.detached === true;
  // tracked with no branch: it IS a work tree, HEAD just would not read.
  const name = info.branch;
  gitBranchElement.classList.toggle("is-untracked", !info.tracked);
  gitBranchElement.classList.toggle("is-detached", detached);
  gitBranchElement.title = !info.tracked
    ? "이 폴더는 Git 저장소가 아닙니다"
    : !name
      ? "Git 저장소이지만 현재 브랜치를 읽지 못했습니다"
      : detached
        ? `분리된 HEAD: ${name}`
        : `현재 Git 브랜치: ${name}`;
  gitBranchName.textContent = info.tracked ? name ?? "브랜치 불명" : "Git 아님";
}

async function refreshGitBranch(): Promise<void> {
  try {
    renderGitBranch(await api?.git?.branch?.());
  } catch {
    // Display only: a failed read leaves the last known branch on screen.
  }
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
  compactingTurn = undefined;
  turns.length = 0;
  consoleElement.replaceChildren();
  resetAgentBoard();
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
