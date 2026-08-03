import { describe, expect, it } from "vitest";

import {
  CONFIRM_FILE_COUNT,
  CONFIRM_TOTAL_BYTES,
  copyConfirmMessage,
  copyResultMessage,
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

describe("copyResultMessage", () => {
  it("names the single copied item", () => {
    expect(copyResultMessage({ copied: ["a.txt"], failed: [] })).toBe(
      "'a.txt'를 복사했습니다."
    );
  });

  it("names the first copied item and counts the rest", () => {
    expect(copyResultMessage({ copied: ["a.txt", "b.txt", "c.txt"], failed: [] })).toBe(
      "'a.txt' 외 2개를 복사했습니다."
    );
  });

  it("appends the failure count when some items failed", () => {
    expect(copyResultMessage({ copied: ["a.txt", "b.txt"], failed: ["c.txt"] })).toBe(
      "'a.txt' 외 1개를 복사했습니다. 1개는 실패했습니다."
    );
  });

  it("reports nothing copied when the copy list is empty", () => {
    expect(copyResultMessage({ copied: [], failed: ["a.txt"] })).toBe(
      "복사한 항목이 없습니다. 1개는 실패했습니다."
    );
  });
});

describe("copyConfirmMessage", () => {
  it("states the exact count and size for an untruncated measurement, with the 를 particle", () => {
    expect(
      copyConfirmMessage({ fileCount: 5, totalBytes: 1536, truncated: false }, "project")
    ).toBe("파일 5개(1.5KB)를 'project' 폴더로 복사합니다. 계속할까요?");
  });

  it("adds the 이상 suffix to both count and size when truncated, with the 을 particle", () => {
    expect(
      copyConfirmMessage({ fileCount: 5, totalBytes: 1536, truncated: true }, "project")
    ).toBe("파일 5개 이상(1.5KB 이상)을 'project' 폴더로 복사합니다. 계속할까요?");
  });
});
