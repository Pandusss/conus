// localStorage can throw (private windows, blocked site data); the UI must work without it.

export function readStored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

/** `null` removes the key. */
export function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage unavailable: the preference just isn't remembered */ }
}
