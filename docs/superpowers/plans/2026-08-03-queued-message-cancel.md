# Queued Message Cancel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user take back a message queued behind a running Claude turn, handing its text and images back to the composer.

**Architecture:** The "다음 작업 예약" badge is promoted from a CSS `::before` to a real element so it can carry a cancel button. `pendingSendQueue` is the single source of truth for whether a message can still be cancelled — a cancel that cannot take its entry out of the queue does nothing, which is what makes a late click harmless.

**Tech Stack:** Electron 43, TypeScript, vitest, plain DOM/CSS.

## Global Constraints

- Cancelling removes the turn entirely; it never leaves a greyed-out remnant.
- The composer is restored only when it holds neither text nor images.
- The cancel button must disappear on every exit from the queue: sent, or released after a failed turn.
- New user-facing strings are Korean; comments are English.
- Every task ends with `npx vitest run companion/tests` and `npx tsc --noEmit` both clean.
- Run all commands from `d:/020_PROJECT/20260716_STREAMDECK/_FIRST/claude-usage-streamdeck`.

## File Structure

| File | Responsibility |
| --- | --- |
| `companion/shared/send-queue.ts` (new) | The two decisions worth testing — may this still be cancelled, and may the composer be overwritten. Pure, no DOM. |
| `companion/renderer/index.ts` (modify) | Badge element, cancel handler, turn removal, composer restore, badge cleanup on every queue exit. |
| `companion/renderer/styles.css` (modify) | Drop the two `content:` rules; style the real badge and its button. |

---

### Task 1: Queue and restore predicates

**Files:**
- Create: `companion/shared/send-queue.ts`
- Test: `companion/tests/send-queue.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `takeQueuedEntry<T, E extends { turn: T }>(queue: E[], turn: T): E | undefined`, `canRestoreToComposer(text: string, imageCount: number): boolean`.

- [ ] **Step 1: Write the failing test**

Create `companion/tests/send-queue.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { canRestoreToComposer, takeQueuedEntry } from "../shared/send-queue";

describe("takeQueuedEntry", () => {
  it("removes and returns the entry for a queued turn", () => {
    const first = { turn: "a" };
    const second = { turn: "b" };
    const queue = [first, second];

    expect(takeQueuedEntry(queue, "a")).toBe(first);
    expect(queue).toEqual([second]);
  });

  // The turn is still on screen wearing its badge for one tick after the queue
  // has already shifted it toward the send. A click in that window must be inert.
  it("returns undefined once the turn has left the queue", () => {
    const queue = [{ turn: "b" }];

    expect(takeQueuedEntry(queue, "a")).toBeUndefined();
    expect(queue).toHaveLength(1);
  });

  it("removes only the requested entry and keeps the rest in order", () => {
    const queue = [{ turn: "a" }, { turn: "b" }, { turn: "c" }];

    takeQueuedEntry(queue, "b");

    expect(queue.map((entry) => entry.turn)).toEqual(["a", "c"]);
  });
});

describe("canRestoreToComposer", () => {
  it("is true only when the composer holds nothing", () => {
    expect(canRestoreToComposer("", 0)).toBe(true);
    expect(canRestoreToComposer("   \n ", 0)).toBe(true);
    expect(canRestoreToComposer("draft", 0)).toBe(false);
    expect(canRestoreToComposer("", 1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run companion/tests/send-queue.test.ts`
Expected: FAIL — `Failed to resolve import "../shared/send-queue"`.

- [ ] **Step 3: Write the implementation**

Create `companion/shared/send-queue.ts`:

```ts
/**
 * Take a queued entry out of the queue, or report that it is no longer there.
 *
 * Queue membership is the only thing that decides whether a message can still
 * be cancelled. When a turn ends the queue is shifted and the send is scheduled
 * on a later tick, so there is a window in which the entry has already left the
 * queue while its turn is still on screen wearing the badge. Returning
 * undefined for that case is what stops a late click from "cancelling" a
 * message that is already on its way to Claude.
 *
 * Generic over the turn type so tests can drive it with plain objects instead
 * of DOM nodes.
 */
export function takeQueuedEntry<T, E extends { turn: T }>(
  queue: E[],
  turn: T
): E | undefined {
  const index = queue.findIndex((entry) => entry.turn === turn);
  if (index < 0) {
    return undefined;
  }
  return queue.splice(index, 1)[0];
}

/**
 * A cancelled message goes back to the composer only when there is nothing to
 * lose there. Someone who kept typing while waiting must not have that draft
 * overwritten by an undo of something else.
 */
export function canRestoreToComposer(text: string, imageCount: number): boolean {
  return text.trim().length === 0 && imageCount === 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run companion/tests/send-queue.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add companion/shared/send-queue.ts companion/tests/send-queue.test.ts
git commit -m "feat: 예약 큐 취소 판정 모듈 추가"
```

---

### Task 2: Cancel control on the queued badge

**Files:**
- Modify: `companion/renderer/index.ts`
  - imports at the top
  - the queue branch inside `sendIntent` (around line 1722)
  - the flush branch inside `sendIntent` (around line 1734)
  - `releasePendingSends` (around line 1837)
  - new functions after `releasePendingSends`
- Modify: `companion/renderer/styles.css` (the two `::before` rules around lines 695-717)

**Interfaces:**
- Consumes: `takeQueuedEntry`, `canRestoreToComposer` (Task 1); existing renderer state `pendingSendQueue`, `turns`, `composer`, `promptInput`; existing helpers `showToast`, `renderImagePreview`, `addComposerImages`, `setComposerText`; `Turn` and `SubmitIntent` types.
- Produces: nothing consumed by later tasks — this is the last one.

- [ ] **Step 1: Add the import**

In `companion/renderer/index.ts`, add near the other `../shared/*` imports:

```ts
import { canRestoreToComposer, takeQueuedEntry } from "../shared/send-queue";
```

- [ ] **Step 2: Add the badge and cancel functions**

Insert directly after the `releasePendingSends` function:

```ts
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
  showToast(
    restoreComposer(entry.intent)
      ? "예약을 취소하고 작성기로 되돌렸습니다."
      : "예약을 취소했습니다."
  );
}
```

Confirm `addComposerImages` and `setComposerText` are already in the import block from `"../shared/composer"`; add whichever is missing.

- [ ] **Step 3: Attach the badge when a message is queued**

In `sendIntent`, replace the queue branch:

```ts
    if (!queuedTurn && claudeStatus.dataset.busy === "true") {
      const turn = appendTurn("user", composerTurnLabel(intent));
      turn.element.classList.add("is-queued");
      pendingSendQueue.push({ intent, turn });
      showToast("응답 생성 중 — 다음 작업으로 예약했습니다.");
      return;
    }
```

with:

```ts
    if (!queuedTurn && claudeStatus.dataset.busy === "true") {
      const turn = appendTurn("user", composerTurnLabel(intent));
      turn.element.classList.add("is-queued");
      attachQueuedBadge(turn);
      pendingSendQueue.push({ intent, turn });
      showToast("응답 생성 중 — 다음 작업으로 예약했습니다.");
      return;
    }
```

- [ ] **Step 4: Remove the badge when the message is sent**

Still in `sendIntent`, replace:

```ts
    if (queuedTurn) {
      queuedTurn.element.classList.remove("is-queued");
    } else {
```

with:

```ts
    if (queuedTurn) {
      queuedTurn.element.classList.remove("is-queued");
      removeQueuedBadge(queuedTurn);
    } else {
```

- [ ] **Step 5: Relabel the badge when the queue is released**

In `releasePendingSends`, replace:

```ts
  for (const { turn } of released) {
    turn.element.classList.add("is-unsent");
  }
```

with:

```ts
  for (const { turn } of released) {
    turn.element.classList.add("is-unsent");
    markQueuedBadgeUnsent(turn);
  }
```

- [ ] **Step 6: Move the badge text out of CSS**

In `companion/renderer/styles.css`, replace this block:

```css
/* Typed while Claude was still generating: on screen, waiting its turn. The
   badge is CSS-only because a user turn deliberately carries no header. */
.turn--user.is-queued .turn__body {
  border-style: dashed;
  color: #a9a9a9;
}

.turn--user.is-queued .turn__body::before {
  content: "다음 작업 예약";
  display: block;
  margin-bottom: 6px;
  color: var(--accent, #d97757);
  font-size: 11px;
  letter-spacing: 0.04em;
}

/* The queue never flushed because the turn failed. Keeps the dashed body of
   is-queued and only relabels it, so the message is not mistaken for sent.
   Must stay after the is-queued rule: same specificity, later wins. */
.turn--user.is-unsent .turn__body::before {
  content: "전송되지 않음";
  color: #c8553d;
}
```

with:

```css
/* Typed while Claude was still generating: on screen, waiting its turn. */
.turn--user.is-queued .turn__body {
  border-style: dashed;
  color: #a9a9a9;
}

/* The badge is a real element, not a ::before, because it carries the cancel
   button and a pseudo-element receives no clicks. */
.turn__queued-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  color: var(--accent, #d97757);
  font-size: 11px;
  letter-spacing: 0.04em;
}

.turn__queued-cancel {
  padding: 0 2px;
  border: 0;
  background: none;
  color: inherit;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
}

.turn__queued-cancel:hover {
  color: var(--accent-strong, #c15f3c);
}

/* The queue never flushed because the turn failed. Keeps the dashed body and
   only recolours the badge, so the message is not mistaken for sent. */
.turn--user.is-unsent .turn__queued-badge {
  color: #c8553d;
}
```

- [ ] **Step 7: Verify the build**

Run: `npx vitest run companion/tests && npx tsc --noEmit && npm run companion:build`
Expected: tests pass, typecheck clean, build succeeds.

- [ ] **Step 8: Commit**

```bash
git add companion/renderer/index.ts companion/renderer/styles.css
git commit -m "feat: 예약된 메시지를 취소하고 작성기로 되돌리기"
```

- [ ] **Step 9: Manual verification**

Requires a Companion rebuild, which means closing the running app — **ask the user before doing this.** Then, with the app running:

1. Send a prompt, and while Claude is generating send a second one → it appears badged "다음 작업 예약" with a ✕.
2. Click ✕ with an empty composer → the turn disappears, the text is back in the composer with the caret at the end, toast says it was restored.
3. Queue a message, type something else in the composer, then click ✕ → the turn disappears, the composer keeps what was typed, toast says only that it was cancelled.
4. Queue a message with an image attached, then cancel with an empty composer → the image chip comes back too.
5. Queue three messages, cancel the middle one → the other two stay, in order, and both still send.
6. Queue a message and let the turn finish → the badge and ✕ vanish as it sends.
7. Queue a message and force a failed turn → the badge reads "전송되지 않음" and has no ✕.

---

## Self-Review

**Spec coverage:**

| Spec criterion | Task |
| --- | --- |
| 1 cancel control on every queued turn | 2 (`attachQueuedBadge`) |
| 2 cancel removes the turn | 2 (`removeTurn`) |
| 3 restore only into an empty composer | 1 (`canRestoreToComposer`) + 2 (`restoreComposer`) |
| 4 toast distinguishes the outcomes | 2 (`cancelQueuedSend`) |
| 5 other queued messages keep order | 1 (`takeQueuedEntry` splice) |
| 6 control disappears on send and on release | 2 (Steps 4 and 5) |
| 7 late click is inert | 1 (`takeQueuedEntry` undefined) + 2 (early return) |
| 8 released message keeps its label, loses the button | 2 (`markQueuedBadgeUnsent`) |
| 9 real, tab-reachable, labelled button | 2 (`<button>` + `aria-label`) |

No gaps.

**Not needed:** `clearSession` already empties `pendingSendQueue` after `clearConsoleOutput()` removes every turn, so the badges go with them. No cleanup to add there.

**Type consistency:** `takeQueuedEntry(pendingSendQueue, turn)` matches the declared `pendingSendQueue: { intent: SubmitIntent; turn: Turn }[]`, so `E` infers to that entry type and `entry.intent` is a `SubmitIntent` — the type `restoreComposer` takes.
