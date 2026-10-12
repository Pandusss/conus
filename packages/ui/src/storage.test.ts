import { afterEach, describe, expect, it, vi } from 'vitest';
import { readStored, writeStored } from './storage';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe('storage', () => {
  it('round-trips a value and removes it on null', () => {
    writeStored('k', 'v');
    expect(readStored('k')).toBe('v');
    writeStored('k', null);
    expect(readStored('k')).toBeNull();
    expect(localStorage.getItem('k')).toBeNull();
  });
  it('never throws when the browser denies storage access', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied'); });
    expect(readStored('k')).toBeNull();
    expect(() => writeStored('k', 'v')).not.toThrow();
    expect(() => writeStored('k', null)).not.toThrow();
  });
});
