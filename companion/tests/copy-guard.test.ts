import { describe, expect, it } from "vitest";

import {
  CONFIRM_FILE_COUNT,
  CONFIRM_TOTAL_BYTES,
  formatCopySize,
  needsCopyConfirm
} from "../shared/copy-guard";

describe("needsCopyConfirm", () => {
  it("asks at the file-count threshold but not below it", () => {
    expect(
      needsCopyConfirm({ fileCount: CONFIRM_FILE_COUNT - 1, totalBytes: 10, truncated: false })
    ).toBe(false);
    expect(
      needsCopyConfirm({ fileCount: CONFIRM_FILE_COUNT, totalBytes: 10, truncated: false })
    ).toBe(true);
  });

  it("asks above the size threshold even for a single file", () => {
    expect(
      needsCopyConfirm({ fileCount: 1, totalBytes: CONFIRM_TOTAL_BYTES, truncated: false })
    ).toBe(false);
    expect(
      needsCopyConfirm({ fileCount: 1, totalBytes: CONFIRM_TOTAL_BYTES + 1, truncated: false })
    ).toBe(true);
  });

  it("always asks when the measurement was cut short", () => {
    expect(needsCopyConfirm({ fileCount: 1, totalBytes: 1, truncated: true })).toBe(true);
  });
});

describe("formatCopySize", () => {
  it("scales to the largest unit that keeps the number small", () => {
    expect(formatCopySize(512)).toBe("512B");
    expect(formatCopySize(1536)).toBe("1.5KB");
    expect(formatCopySize(3 * 1024 * 1024)).toBe("3.0MB");
  });
});
