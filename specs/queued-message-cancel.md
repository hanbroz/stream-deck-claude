# Cancelling a queued message

Date: 2026-08-03

## Goal

A message typed while Claude is still generating is queued and shown as a turn
badged "다음 작업 예약". There is currently no way to take it back: once queued it
will be sent when the turn ends. Give it a cancel control, and hand the text back
to the composer so a mistyped prompt can be corrected rather than retyped.

## Acceptance criteria

1. Every queued turn shows a cancel control inside its "다음 작업 예약" badge.
2. Cancelling removes the turn from the transcript entirely. A message that was
   never sent leaves no trace in the conversation.
3. Cancelling restores the message's text and images to the composer, but only
   when the composer is empty of both. Text typed while waiting is never
   overwritten.
4. The toast distinguishes the two outcomes: restored to the composer, or
   cancelled without restoring.
5. Cancelling one queued message leaves the others queued and in order.
6. The cancel control disappears the moment the message leaves the queue, by any
   route: sent when the turn ended, or released because the turn failed.
7. Clicking cancel on a message that has already left the queue does nothing —
   it does not remove a sent turn and does not touch the composer.
8. A released-but-unsent message keeps its "전송되지 않음" label and loses its
   cancel control, since it can no longer be cancelled.
9. The control is a real button: tab-reachable and labelled for screen readers.

## Design

### The badge becomes a real element

The badge is currently drawn by CSS alone:

```css
.turn--user.is-queued .turn__body::before { content: "다음 작업 예약"; }
.turn--user.is-unsent .turn__body::before { content: "전송되지 않음"; }
```

A pseudo-element cannot hold a button — it is not in the DOM and receives no
events. The badge becomes a real node, inserted as the first child of
`turn.body` so the current visual (badge inside the dashed body) is unchanged:

```html
<div class="turn__queued-badge">
  <span class="turn__queued-label">다음 작업 예약</span>
  <button class="turn__queued-cancel" aria-label="예약 취소">✕</button>
</div>
```

Both `content:` declarations are removed; the CSS keeps only layout and the
`is-unsent` colour override. Releasing a queued message rewrites the label text
to "전송되지 않음" and removes the button.

User turns are painted exactly once — only assistant turns stream — so the badge
cannot be overwritten by a later repaint.

### Queue membership is the single source of truth

`pendingSendQueue` decides whether a message can still be cancelled. Cancelling
tries to take the entry out of the queue first and stops if it is not there:

```
cancelQueuedSend(turn):
  entry = takeQueuedEntry(pendingSendQueue, turn)
  if !entry: return                  // already flushed — the click lost the race
  removeTurn(turn)                   // out of `turns` and out of the DOM
  restored = restoreComposer(entry.intent)
  toast(restored ? "예약을 취소하고 작성기로 되돌렸습니다." : "예약을 취소했습니다.")
```

The race is real: when a turn ends, the queue is shifted and the send is
scheduled through `setTimeout(…, 0)`, so there is a window in which the entry has
left the queue but the turn is still on screen wearing its badge. The `if !entry`
line is the whole defence — no flag, no disabling, no timer.

The other direction must close too. Today only the CSS class tracks queue
membership; with a real button, every exit from the queue has to remove it:

- sent (`sendIntent` with a `queuedTurn`) — badge removed with the class
- released (`releasePendingSends`) — button removed, label relabelled

### Restoring the composer

```
restoreComposer(intent):
  if composer has text or images: return false
  promptInput.value = intent.text
  composer = addComposerImages(setComposerText(composer, intent.text), intent.images)
  renderImagePreview()
  focus the composer, caret at the end
  return true
```

`submitComposer` already trimmed the text when the intent was built, so the
restored draft is the trimmed form.

### `shared/send-queue.ts` (new)

The two decisions worth testing do not need the DOM, so they move out of the
renderer, following `shared/composer.ts` and `shared/tree-state.ts`:

```
takeQueuedEntry<T>(queue: { turn: T }[], turn: T): { turn: T } | undefined
canRestoreToComposer(text: string, imageCount: number): boolean
```

`takeQueuedEntry` is generic over the turn type, so tests drive it with plain
objects and never touch a DOM node.

## Files changed

| File | Change |
| --- | --- |
| `companion/shared/send-queue.ts` | new — `takeQueuedEntry`, `canRestoreToComposer` |
| `companion/renderer/index.ts` | badge element, `cancelQueuedSend`, `removeTurn`, `restoreComposer`, badge cleanup on send and on release |
| `companion/renderer/styles.css` | drop the two `content:` rules, add `.turn__queued-badge` / `.turn__queued-cancel` |

## Tests

`companion/tests/send-queue.test.ts` (new):

1. `takeQueuedEntry` returns the entry and removes it from the queue.
2. `takeQueuedEntry` returns undefined for a turn already out of the queue, and
   leaves the queue untouched — the race in criterion 7.
3. `takeQueuedEntry` removes only the requested entry and preserves the order of
   the rest — criterion 5.
4. `canRestoreToComposer` is false when text is present, false when images are
   present, true only when both are empty.

## Non-goals

- Editing a queued message in place. Cancel and retype covers it.
- Reordering the queue.
- Cancelling a message that is already being generated — that is Escape/interrupt,
  which already exists.
