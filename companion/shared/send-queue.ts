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
