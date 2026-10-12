import { randomInt, timingSafeEqual } from 'node:crypto';

// No 0/O, 1/I/L: the code is read from a terminal and typed into a browser.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** The one-time code that proves the person finishing setup in the browser can read the server's logs (or .env). */
export function newSetupCode(): string {
  const c = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

const normalize = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Case, spaces and dashes do not matter; the comparison takes the same time for any wrong code of the same length. */
export function setupCodeMatches(given: string, expected: string): boolean {
  const a = Buffer.from(normalize(given));
  const b = Buffer.from(normalize(expected));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}
