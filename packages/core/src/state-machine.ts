import { DomainError } from './errors';
import { OPEN_STATUSES, type Status } from './types';

export type TransitionCommand = 'promote' | 'start' | 'block' | 'complete' | 'drop' | 'reopen' | 'janitor_release';

// `start` from in_progress is handled separately (no-op / claim takeover), see lifecycle.ts.
export const TRANSITIONS: Record<TransitionCommand, readonly Status[]> = {
  promote: ['proposed'],
  start: ['proposed', 'todo', 'blocked', 'review'],
  block: ['todo', 'in_progress'],
  complete: ['todo', 'in_progress', 'blocked', 'review'],
  drop: ['proposed', 'todo', 'in_progress', 'blocked', 'review'],
  reopen: ['done', 'dropped'],
  janitor_release: ['in_progress'],
};

export function assertTransition(cmd: TransitionCommand, from: Status, ref: string): void {
  if (!TRANSITIONS[cmd].includes(from)) {
    throw new DomainError('invalid_transition', `Cannot ${cmd.replace('_', ' ')} ${ref}: it is ${from}.`, {
      current: from,
      command: cmd,
      ref,
    });
  }
}

export function isOpen(s: Status): boolean {
  return OPEN_STATUSES.includes(s);
}
