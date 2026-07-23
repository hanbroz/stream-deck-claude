/**
 * Temporary transport instrumentation for the Companion prompt path.
 *
 * Records stage names, session IDs, counts and lengths only. Message text,
 * clipboard image bytes and credentials must never be passed in here, because
 * these lines are written to a plain file when diagnostics are enabled.
 */
export type DiagValue = string | number | boolean | undefined;

export type DiagSink = (line: string) => void;

let sink: DiagSink | undefined;

export function setDiagSink(next: DiagSink | undefined): void {
  sink = next;
}

export function formatDiagLine(
  stage: string,
  fields: Record<string, DiagValue> = {}
): string {
  const parts = Object.entries(fields)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`);
  return [`[diag] ${stage}`, ...parts].join(" ");
}

/**
 * Emit a line that was already formatted in another process. Renderer input is
 * untrusted, so collapse newlines and cap length to keep one event on one line.
 */
export function emitDiagLine(line: string): void {
  const safe = line.replace(/[\r\n]+/gu, " ").slice(0, 500);
  if (sink) {
    sink(safe);
    return;
  }
  if (typeof process !== "undefined" && process.env?.VITEST) {
    return;
  }
  console.log(safe);
}

export function diag(stage: string, fields: Record<string, DiagValue> = {}): void {
  if (sink) {
    sink(formatDiagLine(stage, fields));
    return;
  }
  // Keep unit-test output readable; formatDiagLine stays directly covered.
  if (typeof process !== "undefined" && process.env?.VITEST) {
    return;
  }
  console.log(formatDiagLine(stage, fields));
}
