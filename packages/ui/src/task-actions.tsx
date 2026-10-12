import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type EventDto, type LinkDto, type Status, type TaskDto } from './api';
import { ReasonDialog } from './components/Dialog';
import { useToast } from './components/Toast';
import { useT } from './i18n';

export type TaskDetailDto = { task: TaskDto; events: EventDto[]; links: LinkDto[]; subtasks: TaskDto[] };
export type Move = { task: TaskDto; status: Status; reason?: string };
type TaskList = { tasks: TaskDto[] };

/**
 * Changes a task's status by hand. The change shows at once in every cached task list and in the task's detail,
 * and is rolled back if the server refuses it. `track` hooks a page's action error (useActionError) in.
 */
export function useSetStatus(track?: { onMutate?: () => void; onError?: (e: unknown) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useT();
  return useMutation({
    mutationFn: ({ task, status, reason }: Move) => api(`/tasks/${task.id}/status`, { method: 'POST', json: { status, reason } }),
    onMutate: async ({ task, status }: Move) => {
      track?.onMutate?.();
      await Promise.all([qc.cancelQueries({ queryKey: ['tasks'] }), qc.cancelQueries({ queryKey: ['task', task.id] })]);
      const lists = qc.getQueriesData<TaskList>({ queryKey: ['tasks'] });
      const detail = qc.getQueryData<TaskDetailDto>(['task', task.id]);
      const updatedAt = new Date().toISOString();
      qc.setQueriesData<TaskList>({ queryKey: ['tasks'] }, (d) =>
        d?.tasks ? { ...d, tasks: d.tasks.map((x) => (x.id === task.id ? { ...x, status, updatedAt } : x)) } : d);
      if (detail) qc.setQueryData<TaskDetailDto>(['task', task.id], { ...detail, task: { ...detail.task, status } });
      return { lists, detail };
    },
    onError: (e, { task }, ctx) => {
      ctx?.lists.forEach(([key, data]) => qc.setQueryData(key, data));
      if (ctx?.detail) qc.setQueryData(['task', task.id], ctx.detail);
      track?.onError?.(e);
    },
    onSuccess: (_r, { task, status }) => toast(`${task.ref} → ${t.status[status]}`),
    onSettled: (_r, _e, { task }) => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['task', task.id] });
    },
  });
}

/** The reason asked before blocking (required) or dropping (optional) a task. */
export function MoveReasonDialog({ move, busy, onConfirm, onCancel }: {
  move: { task: TaskDto; status: Status } | null; busy?: boolean; onConfirm: (reason: string | undefined) => void; onCancel: () => void;
}) {
  const { t } = useT();
  const blocking = move?.status === 'blocked';
  const ref = move?.task.ref ?? '';
  return (
    <ReasonDialog
      open={!!move}
      title={blocking ? t.move.blockTitle(ref) : t.move.dropTitle(ref)}
      message={move && <p className="muted">{move.task.title}</p>}
      label={blocking ? t.move.blockLabel : t.move.dropLabel}
      required={blocking}
      danger={!blocking}
      confirmLabel={blocking ? t.move.blockConfirm : t.move.dropConfirm}
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
