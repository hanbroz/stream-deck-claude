/**
 * Interactive multiple-choice questions over plain --print output.
 *
 * The real AskUserQuestion tool is disabled in non-interactive print mode, so
 * the Companion appends a system-prompt instruction teaching Claude to end a
 * reply with a fenced ```question block containing JSON. The transcript
 * renders that block as a clickable option card; clicking sends the chosen
 * option as the next user message.
 */
export type QuestionBlock = {
  question: string;
  options: string[];
};

export const QUESTION_SYSTEM_PROMPT = [
  "When you need the user to pick between options, end your reply with exactly one fenced code block whose language tag is `question`, containing JSON of the shape:",
  '{"question": "<the question>", "options": ["<option 1>", "<option 2>", ...]}',
  "Rules: use it only when you are genuinely asking the user to choose; give 2-6 short, self-contained options (each must make sense when sent back verbatim as the user's answer); the block must be the last thing in the reply; write the question and options in the user's language. For open-ended questions, do not use the block."
].join(" ");

/** Parse a ```question block body; null means render it as a plain code block. */
export function parseQuestionBlock(code: string): QuestionBlock | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(code);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as { question?: unknown; options?: unknown };
  if (typeof record.question !== "string" || !Array.isArray(record.options)) {
    return null;
  }
  const question = record.question.trim();
  const options = record.options
    .filter((option): option is string => typeof option === "string" && option.trim().length > 0)
    .map((option) => option.trim())
    .slice(0, 6);
  return question.length > 0 && options.length >= 2 ? { question, options } : null;
}
