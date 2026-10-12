import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import type { EventDto } from '../api';
import { renderPage } from '../test-utils';
import { Timeline } from './Timeline';

const event: EventDto = {
  id: 1, taskId: 't1', type: 'status_changed', actorKind: 'user', actorName: null, sessionId: null, sessionRef: null, model: null,
  changes: { status: { from: 'todo', to: 'in_progress' } }, reason: null, note: null, createdAt: '2026-10-08T10:00:00Z',
};

describe('Timeline', () => {
  it('shows status changes as pills with Russian status names, not raw codes', () => {
    renderPage(<Timeline events={[event, { ...event, id: 2, changes: { status: { from: null, to: 'proposed' } } }]} />);
    const [first, second] = screen.getAllByRole('listitem');
    expect(within(first!).getByText('К выполнению')).toBeTruthy();
    expect(within(first!).getByText('В работе')).toBeTruthy();
    expect(within(second!).getByText('—')).toBeTruthy();
    expect(within(second!).getByText('Предложение')).toBeTruthy();
    expect(screen.queryByText(/in_progress/)).toBeNull();
  });

  it('names the actor, links the session, shows the model, the reason and the note', () => {
    renderPage(<Timeline events={[{
      ...event, type: 'blocked', actorKind: 'agent', actorName: 'claude-code@laptop', sessionId: 's1', sessionRef: 'S-4', model: 'opus',
      changes: {}, reason: 'ждём ключи', note: 'заметка агента',
    }]} />);
    expect(screen.getByText('claude-code@laptop')).toBeTruthy();
    expect(screen.getByText('заблокирована')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'S-4' }).getAttribute('href')).toBe('/sessions/s1');
    expect(screen.getByText('opus')).toBeTruthy();
    expect(screen.getByText('Причина: ждём ключи')).toBeTruthy();
    expect(screen.getByText('заметка агента')).toBeTruthy();
  });
});
