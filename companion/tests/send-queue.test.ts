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
