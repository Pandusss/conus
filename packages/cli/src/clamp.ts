/**
 * At most `max` UTF-16 units, never ending in the first half of a surrogate pair (a lone surrogate makes the
 * server's jsonb insert fail). Null stays null.
 */
export function clamp(s: string, max: number): string;
export function clamp(s: string | null | undefined, max: number): string | null;
export function clamp(s: string | null | undefined, max: number): string | null {
  if (s == null) return null;
  let t = s.length > max ? s.slice(0, max) : s;
  const last = t.charCodeAt(t.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1);
  return t;
}
