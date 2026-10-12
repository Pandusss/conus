import { initials } from '../labels';

/** A stable hue per name, so the same agent always gets the same colour. */
function tone(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 6;
}

export function Avatar({ name, size = 'sm' }: { name: string; size?: 'xs' | 'sm' }) {
  return <span className={`avatar avatar-${size} tone-${tone(name)}`} aria-hidden="true">{initials(name)}</span>;
}
