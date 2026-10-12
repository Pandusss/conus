import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

// Node 25+ has its own localStorage and sessionStorage globals (undefined without --localstorage-file),
// and they shadow jsdom's: hand the tests jsdom's storage back.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;
if (dom) {
  for (const key of ['localStorage', 'sessionStorage'] as const) {
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
}

// The tests read the Russian UI. Set before every test: some tests clear localStorage when they finish.
beforeEach(() => localStorage.setItem('conus.lang', 'ru'));

// Testing Library only auto-cleans when vitest globals are on; they are not, so unmount between tests explicitly.
afterEach(() => cleanup());
