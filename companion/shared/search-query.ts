/**
 * Whether a search query is searchable, as one answer both processes share.
 *
 * The renderer used to check only the minimum while the search itself also
 * dropped anything past the maximum, so an over-long query came back empty and
 * rendered as a confident "결과 없음" for a search that never ran.
 *
 * This lives in `shared/` rather than beside the search: the renderer bundles
 * for the browser, so importing a value out of `main/` drags `node:fs` and
 * friends into a bundle that cannot resolve them. Types erase and are safe to
 * import across that line; values are not.
 */

export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 200;

export type QueryLengthVerdict = "too-short" | "too-long" | "ok";

export function queryLengthVerdict(query: string): QueryLengthVerdict {
  const needle = query.trim();
  if (needle.length < MIN_QUERY_LENGTH) {
    return "too-short";
  }
  if (needle.length > MAX_QUERY_LENGTH) {
    return "too-long";
  }
  return "ok";
}
