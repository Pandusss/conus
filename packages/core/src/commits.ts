/**
 * Commit refs come as full shas (hook facts) and as short ones (`task_complete` commits, 4–40 chars). Two refs name
 * the same commit when one is a case-insensitive prefix of the other; at least 4 characters must agree.
 */
export const MIN_COMMIT_REF = 4;

/** SQL condition: the text expressions `a` and `b` name the same commit. */
export function sameCommitSql(a: string, b: string): string {
  const n = `least(length(${a}), length(${b}))`;
  return `(${n} >= ${MIN_COMMIT_REF} AND left(lower(${a}), ${n}) = left(lower(${b}), ${n}))`;
}

export function sameCommit(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length);
  return n >= MIN_COMMIT_REF && a.slice(0, n).toLowerCase() === b.slice(0, n).toLowerCase();
}
