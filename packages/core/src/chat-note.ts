import { t } from './lang';

export type ChatNoteKind =
  | 'created' | 'created_started' | 'proposed' | 'started' | 'blocked' | 'completed'
  | 'review' | 'dropped' | 'updated' | 'promoted' | 'reopened';

export function shortTitle(title: string, max = 40): string {
  const s = title.trim().replace(/\s+/g, ' ');
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + '…';
}

export function chatNote(kind: ChatNoteKind, task: { ref: string; title: string }): string {
  switch (kind) {
    case 'created': return `+${task.ref} ${shortTitle(task.title)}`;
    case 'created_started': return `+${task.ref} ${shortTitle(task.title)} → ${t('in progress', 'в работе')}`;
    case 'proposed': return `?${task.ref} ${shortTitle(task.title)}`;
    case 'started': return `${task.ref} → ${t('in progress', 'в работе')}`;
    case 'blocked': return `${task.ref} → ${t('blocked', 'заблокирована')}`;
    case 'completed': return `${task.ref} → ${t('done', 'готово')}`;
    case 'review': return `${task.ref} → ${t('review', 'на проверку')}`;
    case 'dropped': return `${task.ref} → ${t('dropped', 'отменена')}`;
    case 'updated': return `${task.ref} ${t('updated', 'обновлена')}`;
    case 'promoted': return `${task.ref} → ${t('to do', 'к выполнению')}`;
    case 'reopened': return `${task.ref} → ${t('reopened', 'открыта снова')}`;
  }
}
