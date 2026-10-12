/** Truncates to at most n UTF-16 units (ellipsis included) without splitting a surrogate pair. */
export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  let end = Math.max(0, n - 1);
  if (end > 0 && s.charCodeAt(end - 1) >= 0xd800 && s.charCodeAt(end - 1) <= 0xdbff) end--;
  return s.slice(0, end) + '…';
}

/** Angle brackets become look-alikes, so quoted text can never open or close a tag such as </data> or </task-manager>. */
export function neutralizeAngles(s: string): string {
  return s.replace(/</g, '‹').replace(/>/g, '›');
}
