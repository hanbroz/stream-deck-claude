export type ComposerImage = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
};

/**
 * A block of pasted text held outside the input box.
 *
 * Pasting a log of a few hundred lines into the textarea buried whatever the
 * user was writing and left a box nobody could scroll. Past the threshold the
 * paste becomes an attachment instead: out of the way on screen, sent verbatim.
 */
export type ComposerPaste = {
  id: string;
  text: string;
  lineCount: number;
};

export type ComposerState = {
  text: string;
  images: ComposerImage[];
  pastes: ComposerPaste[];
  isComposing: boolean;
};

/** Lines at or above which a paste is attached rather than inserted. */
export const PASTE_ATTACH_MIN_LINES = 20;

/**
 * Ceiling on one attachment, and on how many ride along at once.
 *
 * An attachment is not a one-off cost: `--resume` carries it in the prefix of
 * every later turn until a compaction drops it, so a clipboard the user never
 * looked at is re-billed for the rest of the conversation. 200k characters is
 * roughly 50k tokens — large enough for the log someone actually meant to
 * share, small enough that a stray buffer cannot quietly resize the session.
 */
export const PASTE_ATTACH_MAX_CHARS = 200_000;
export const PASTE_ATTACH_MAX_COUNT = 5;

/** Cut an oversized paste to the ceiling, reporting how much was dropped. */
export function clampPasteText(text: string): { text: string; dropped: number } {
  if (text.length <= PASTE_ATTACH_MAX_CHARS) {
    return { text, dropped: 0 };
  }
  const dropped = text.length - PASTE_ATTACH_MAX_CHARS;
  return {
    text: `${text.slice(0, PASTE_ATTACH_MAX_CHARS)}
[...${dropped.toLocaleString("ko-KR")}자 잘림]`,
    dropped
  };
}

export function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r\n|\r|\n/u).length;
}

export function shouldAttachPaste(text: string): boolean {
  return countLines(text) >= PASTE_ATTACH_MIN_LINES;
}

export type SubmitIntent = {
  /**
   * What the user TYPED — attachments are not folded in here. Slash-command
   * detection and the input history both read this, and neither should have to
   * step over a thousand pasted lines. `composeOutgoingText` builds the body
   * that actually goes to Claude.
   */
  text: string;
  images: ComposerImage[];
  pastes: ComposerPaste[];
  /**
   * Where the text came from. "model" marks text the assistant wrote — a
   * question-card option label. That text must never be treated as a local
   * command: the local branches run CLI subcommands and write into a live
   * shell, so one click on a model-authored `/mcp add …` would execute it.
   * Absent means the user typed it.
   */
  origin?: "model";
};

export function createComposerState(): ComposerState {
  return {
    text: "",
    images: [],
    pastes: [],
    isComposing: false
  };
}

export function setComposerText(state: ComposerState, text: string): ComposerState {
  return {
    ...state,
    text
  };
}

export function setComposing(state: ComposerState, isComposing: boolean): ComposerState {
  return {
    ...state,
    isComposing
  };
}

export function addComposerImages(state: ComposerState, images: ComposerImage[]): ComposerState {
  const nextImages = [...state.images];

  for (const image of images) {
    if (!nextImages.some((existing) => existing.id === image.id)) {
      nextImages.push(image);
    }
  }

  return {
    ...state,
    images: nextImages
  };
}

export function removeComposerImage(state: ComposerState, imageId: string): ComposerState {
  return {
    ...state,
    images: state.images.filter((image) => image.id !== imageId)
  };
}

export function addComposerPaste(state: ComposerState, paste: ComposerPaste): ComposerState {
  return {
    ...state,
    pastes: [...state.pastes, paste]
  };
}

export function removeComposerPaste(state: ComposerState, pasteId: string): ComposerState {
  return {
    ...state,
    pastes: state.pastes.filter((paste) => paste.id !== pasteId)
  };
}

/**
 * The message body Claude receives: what was typed, then each attachment in
 * full. The header line tells Claude the block is pasted material rather than
 * something the user wrote, and gives it a number to refer back to.
 */
export function composeOutgoingText(intent: SubmitIntent): string {
  if (intent.pastes.length === 0) {
    return intent.text;
  }
  const blocks = intent.pastes.map(
    (paste, index) => `[붙여넣은 텍스트 #${index + 1} · ${paste.lineCount}줄]\n${paste.text}`
  );
  return [intent.text, ...blocks].filter((part) => part.length > 0).join("\n\n");
}

export function submitComposer(state: ComposerState): { state: ComposerState; intent?: SubmitIntent } {
  if (state.isComposing) {
    return { state };
  }

  const text = state.text.trim();
  // An attachment alone is a message: pasting a log and pressing Enter with
  // nothing typed has to send.
  if (text.length === 0 && state.images.length === 0 && state.pastes.length === 0) {
    return { state };
  }

  return {
    state: createComposerState(),
    intent: {
      text,
      images: state.images,
      pastes: state.pastes
    }
  };
}

export function shouldSubmitFromKeyboard(input: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}): boolean {
  return input.key === "Enter" && !input.shiftKey && !input.isComposing;
}

export function imageId(name: string, size: number, lastModified: number): string {
  return `${name}:${size}:${lastModified}`;
}

/**
 * Append a sent message to the recall history, skipping blanks and immediate
 * duplicates so Up/Down navigation stays useful.
 */
export function pushHistory(history: string[], text: string): void {
  const trimmed = text.trim();
  if (trimmed.length === 0 || history[history.length - 1] === trimmed) {
    return;
  }
  history.push(trimmed);
}

/**
 * Context share at which the conversation is compacted automatically.
 *
 * ponytail: 85, overriding the measured cost-optimal mark of 45 (kept below,
 * unchanged) per explicit user instruction on 2026-09-01, to match the CLI's
 * own auto-compact window (also raised to 85% / 850k of the 1M window). The
 * user was told this reopens the exact regression the 70→45 change below was
 * made to fix — firing later than the ~450k break-even point makes each
 * compaction (a full-prefix-reading paid turn) more expensive than the tokens
 * it saves — and chose 85 anyway. Upgrade path: if cost creeps back up, revert
 * toward 45-50 and re-measure rather than guessing.
 *
 * Original rationale, still true, now overridden:
 * Cost is (requests × prefix size), so every turn taken at 90% pays for a
 * ~900k-token prefix; measured sessions ran at a ~450k MEAN prefix over more
 * than a thousand requests. On a 1M window 70% did not fire until ~700k,
 * 1.55x that break-even, which is why 45 replaced it.
 *
 * The floor is the limit on going lower: a conversation cannot compact below
 * its preamble, and `autoCompactArmed` only re-arms once usage falls back under
 * the mark, so a mark at or under the floor would fire once and then never
 * again. 45% of a 1M window is 450k against a preamble measured at ~22k.
 */
export const AUTO_COMPACT_AT_PERCENT = 85;

/**
 * May the app compact right now?
 *
 * Only while WAITING FOR THE USER — never mid-conversation. Compaction takes
 * minutes and replaces the transcript, so it must not land between a question
 * and its answer, on top of a queued message, or over a compaction already in
 * flight.
 *
 * `armed` is the one-shot latch: it is cleared when a compaction starts and set
 * again only once usage falls back under the mark, so a compaction that frees
 * too little cannot loop.
 */
export function shouldAutoCompact(input: {
  percentage: number | undefined;
  armed: boolean;
  busy: boolean;
  queuedCount: number;
  compacting: boolean;
  hasSession: boolean;
}): boolean {
  return (
    input.armed &&
    input.hasSession &&
    !input.busy &&
    !input.compacting &&
    input.queuedCount === 0 &&
    input.percentage !== undefined &&
    input.percentage >= AUTO_COMPACT_AT_PERCENT
  );
}

// A unit of work that usually ENDS a line of conversation, and a word saying it
// actually finished. Both must appear: "커밋할까요?" is a plan, not a milestone.
const MILESTONE_MARKERS = [
  /커밋/u, /푸시/u, /배포/u, /릴리[즈스]/u, /빌드/u, /컴파일/u, /머지/u,
  /\bcommit(?:ted)?\b/iu, /\bpush(?:ed)?\b/iu, /\bdeploy(?:ed)?\b/iu,
  /\brelease[sd]?\b/iu, /\bbuild\b/iu, /\bmerged?\b/iu
];
const COMPLETION_MARKERS = [
  /완료/u, /했습니다/u, /됐습니다/u, /되었습니다/u, /끝났습니다/u, /마쳤습니다/u,
  /\bdone\b/iu, /\bsucce/iu, /\bcomplete/iu, /\bfinished\b/iu
];

/**
 * Does this reply read like one unit of work just finished?
 *
 * A HEURISTIC, and used only to OFFER a fresh conversation — never to start one.
 * A wrong guess costs an ignored button, so it is tuned to be quiet rather than
 * clever: it needs both a milestone word and a completion word, and it reads
 * only the tail, because that is where a reply says what it finished rather
 * than what it is about to attempt.
 */
export function looksLikeCompletedMilestone(text: string): boolean {
  const tail = text.slice(-1200);
  return (
    MILESTONE_MARKERS.some((marker) => marker.test(tail)) &&
    COMPLETION_MARKERS.some((marker) => marker.test(tail))
  );
}

/**
 * Should Up recall history, or leave the key to the caret?
 *
 * Only an EMPTY box starts a recall — Up used to fire whenever the caret sat on
 * the first line, so it hijacked the key from anyone editing the top line of a
 * draft. Once a recall is under way the box is no longer empty, so navigation
 * has to stay allowed or history would be exactly one step deep.
 *
 * Down needs no equivalent: navigateHistory already returns null when no recall
 * is in progress, which leaves the key to the caret on its own.
 */
export function shouldRecallHistory(input: {
  draft: string;
  historyIndex: number;
  historyLength: number;
}): boolean {
  return input.draft.length === 0 || input.historyIndex < input.historyLength;
}

export type HistoryNavigation = { index: number; text: string };

/**
 * Move through the recall history. `index` runs [0, history.length]; the last
 * slot is the live draft. Returns the new index and the text to show, or null
 * when the caret should keep the arrow key for normal cursor movement.
 */
export function navigateHistory(
  history: string[],
  index: number,
  draft: string,
  direction: "up" | "down"
): HistoryNavigation | null {
  if (direction === "up") {
    if (index <= 0 || history.length === 0) {
      return null;
    }
    return { index: index - 1, text: history[index - 1] };
  }
  if (index >= history.length) {
    return null;
  }
  const next = index + 1;
  return { index: next, text: next === history.length ? draft : history[next] };
}
