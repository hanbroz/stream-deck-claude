/**
 * "@" file mentions in the composer.
 *
 * Typing "@" opens a project-file picker anchored at the caret. Picking a
 * file replaces the token with "@<relative path> " and the renderer
 * highlights exactly the mentions that were picked through the UI — an "@"
 * the user leaves alone stays plain text.
 */
export type MentionQuery = {
  /** Index of the "@" character in the draft. */
  start: number;
  /** What the user typed after "@" so far (never contains whitespace). */
  query: string;
};

/** The @token the caret is currently completing, or null when none. */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^\s@]{0,120})$/u.exec(before);
  if (!match) {
    return null;
  }
  return { start: caret - match[2].length - 1, query: match[2] };
}

/** Replace the @token with the picked path; returns the new draft and caret. */
export function applyMention(
  text: string,
  mention: MentionQuery,
  caret: number,
  path: string
): { text: string; caret: number } {
  const inserted = `@${path} `;
  return {
    text: text.slice(0, mention.start) + inserted + text.slice(caret),
    caret: mention.start + inserted.length
  };
}

/** Case-insensitive filter over relative paths; name-prefix hits sort first. */
export function filterMentionFiles(
  files: readonly string[],
  query: string,
  limit = 50
): string[] {
  const lowered = query.toLowerCase();
  const scored: Array<{ path: string; score: number }> = [];
  for (const file of files) {
    const path = file.toLowerCase();
    const name = path.slice(path.lastIndexOf("/") + 1);
    const score = name.startsWith(lowered)
      ? 0
      : path.includes(lowered)
        ? 1
        : -1;
    if (score >= 0) {
      scored.push({ path: file, score });
    }
  }
  return scored
    .sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((entry) => entry.path);
}
