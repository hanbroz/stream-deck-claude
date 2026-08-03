/**
 * A drop can pull in far more than the user meant: one folder row in Windows
 * Explorer can be a node_modules tree. Past either threshold the copy is
 * confirmed first, because a mis-drag is otherwise silent and unbounded.
 */
export const CONFIRM_FILE_COUNT = 5;
export const CONFIRM_TOTAL_BYTES = 500 * 1024 * 1024;

export type CopyMeasurement = {
  fileCount: number;
  totalBytes: number;
  truncated: boolean;
};

/**
 * `truncated` always confirms: the walk only gives up once it is already past
 * the caps, so a cut-short measurement is by construction a large drop.
 */
export function needsCopyConfirm(measurement: CopyMeasurement): boolean {
  return (
    measurement.truncated ||
    measurement.fileCount >= CONFIRM_FILE_COUNT ||
    measurement.totalBytes > CONFIRM_TOTAL_BYTES
  );
}

/** Short enough to sit inside a one-line confirmation: "842.3MB". */
export function formatCopySize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)}${units[unit]}`;
}
