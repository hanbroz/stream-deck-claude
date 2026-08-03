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

/**
 * Structural rather than the main-process `CopyResult` type: shared/ must not
 * import from main/.
 */
export type CopySummary = {
  copied: string[];
  failed: string[];
};

/** The transcript-free summary a finished drop reports. */
export function copyResultMessage(result: CopySummary): string {
  const head =
    result.copied.length > 0
      ? `'${result.copied[0]}'${
          result.copied.length > 1 ? ` 외 ${result.copied.length - 1}개` : ""
        }를 복사했습니다.`
      : "복사한 항목이 없습니다.";
  return result.failed.length > 0
    ? `${head} ${result.failed.length}개는 실패했습니다.`
    : head;
}

/**
 * Takes the destination's already-resolved folder name rather than a path:
 * path handling (e.g. `projectNameFromPath`) is a renderer concern, so the
 * caller resolves it before calling in.
 */
export function copyConfirmMessage(measurement: CopyMeasurement, destinationName: string): string {
  const count = `${measurement.fileCount.toLocaleString()}개${
    measurement.truncated ? " 이상" : ""
  }`;
  const size = `${formatCopySize(measurement.totalBytes)}${
    measurement.truncated ? " 이상" : ""
  }`;
  // Naming the destination folder means a drop onto the wrong row is caught by
  // the same dialog that catches a drop that is too big.
  return `파일 ${count}(${size})를 '${destinationName}' 폴더로 복사합니다. 계속할까요?`;
}
