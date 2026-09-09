// Shared by the browser composer and the main-process IPC boundary. Limits
// measure the encoded data URL, matching the payload that crosses IPC.
export const MAX_IMAGE_COUNT = 10;
export const MAX_IMAGE_DATA_URL_LENGTH = 20 * 1024 * 1024;
export const MAX_IMAGE_BATCH_LENGTH = 30 * 1024 * 1024;

export function optionalImageDataUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("imageDataUrl must be a string");
  if (value.length > MAX_IMAGE_DATA_URL_LENGTH || !/^data:image\/[a-z0-9.+-]+;base64,/iu.test(value)) {
    throw new Error("imageDataUrl must be a base64 encoded image under 20 MB");
  }
  return value;
}

export function optionalImageDataUrls(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("imageDataUrls must be an array");
  if (value.length > MAX_IMAGE_COUNT) {
    throw new Error("imageDataUrls must contain at most 10 images");
  }
  const dataUrls = value.map((entry) => {
    const dataUrl = optionalImageDataUrl(entry);
    if (!dataUrl) throw new Error("imageDataUrls must contain image data URLs");
    return dataUrl;
  });
  if (dataUrls.reduce((sum, dataUrl) => sum + dataUrl.length, 0) > MAX_IMAGE_BATCH_LENGTH) {
    throw new Error("imageDataUrls must total under 30 MB");
  }
  return dataUrls;
}

/** Validate before clearing a draft; the IPC boundary repeats this check. */
export function imageAttachmentErrorMessage(dataUrls: readonly string[]): string | undefined {
  try {
    optionalImageDataUrls(dataUrls);
    return undefined;
  } catch {
    if (dataUrls.length > MAX_IMAGE_COUNT) return "이미지는 한 번에 최대 10개까지 보낼 수 있습니다.";
    if (dataUrls.some((dataUrl) => dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH)) {
      return "이미지 한 개의 전송 크기는 20 MB 이하여야 합니다.";
    }
    if (dataUrls.reduce((sum, dataUrl) => sum + dataUrl.length, 0) > MAX_IMAGE_BATCH_LENGTH) {
      return "이미지의 총 전송 크기는 30 MB 이하여야 합니다.";
    }
    return "첨부한 이미지 형식을 확인해 주세요.";
  }
}
