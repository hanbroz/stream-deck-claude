export type SplitterOrientation = "horizontal" | "vertical";

export function clampSplit(value: number, minimum: number, maximum: number): number {
  const lower = Math.min(minimum, maximum);
  const upper = Math.max(minimum, maximum);
  if (!Number.isFinite(value)) {
    return lower;
  }
  return Math.min(upper, Math.max(lower, value));
}

export function adjustSplitForKey(
  key: string,
  orientation: SplitterOrientation,
  current: number,
  minimum: number,
  maximum: number,
  step = 16
): number | undefined {
  if (key === "Home") {
    return minimum;
  }
  if (key === "End") {
    return maximum;
  }

  const negative = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
  const positive = orientation === "vertical" ? "ArrowRight" : "ArrowDown";
  if (key !== negative && key !== positive) {
    return undefined;
  }

  const direction = key === negative ? -1 : 1;
  return clampSplit(current + direction * Math.max(1, step), minimum, maximum);
}
