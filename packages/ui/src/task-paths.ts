import { useLocation } from 'react-router-dom';

/**
 * The task drawer opens over the page it was opened from: the overview (/tasks/:id) or the board (/board/tasks/:id).
 * These keep that background when the drawer closes or moves to another task.
 */
export function useTaskBase(): '' | '/board' {
  const { pathname } = useLocation();
  return pathname === '/board' || pathname.startsWith('/board/') ? '/board' : '';
}

export function useTaskPath(): (id: string) => string {
  const base = useTaskBase();
  return (id) => `${base}/tasks/${id}`;
}
