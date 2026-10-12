import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { json, renderPage } from '../test-utils';
import { Sessions } from './Sessions';

afterEach(() => vi.restoreAllMocks());

const session = {
  id: 's1', ref: 'S-1', agentName: 'claude-code@laptop', projectKey: 'WB', state: 'stale', branch: 'main',
  startedAt: '2026-10-08T10:00:00Z', lastSeenAt: '2026-10-08T11:30:00Z', endedAt: null, taskOps: 7, nudges: 3, nudgesActed: 2, janitorReleases: 1,
};

describe('Sessions', () => {
  it('lists sessions with their state, duration and counters, and a row opens the session', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => json({ sessions: [session] }));
    renderPage(
      <Routes><Route path="/sessions" element={<Sessions />} /><Route path="/sessions/:id" element={<p>страница сессии</p>} /></Routes>,
      { path: '/sessions' },
    );
    const row = (await screen.findByText('claude-code@laptop')).closest('tr')!;
    expect(within(row).getByText('молчит')).toBeTruthy();
    expect(within(row).getByText('1 ч 30 мин')).toBeTruthy();
    const cells = within(row).getAllByRole('cell').map((c) => c.textContent);
    expect(cells).toContain('7');
    expect(cells).toContain('3 (2)');
    await userEvent.click(within(row).getByText('main'));
    expect(screen.getByText('страница сессии')).toBeTruthy();
  });
});
