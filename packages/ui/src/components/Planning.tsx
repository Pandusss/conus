import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, ChevronDown, ChevronUp, ChevronsUp, Equal, type LucideIcon } from 'lucide-react';
import { api, type Priority, type TaskDto } from '../api';
import { useT, type Messages } from '../i18n';
import { PRIORITIES, dueLabel, dueState, formatDay } from '../labels';
import type { TaskDetailDto } from '../task-actions';
import type { MenuGroup } from './Menu';
import { useToast } from './Toast';

const ICON: Record<Priority, LucideIcon> = { urgent: ChevronsUp, high: ChevronUp, normal: Equal, low: ChevronDown };

export function PriorityIcon({ priority, size = 14 }: { priority: Priority; size?: number }) {
  const Icon = ICON[priority];
  return <Icon size={size} className={`prio-icon prio-${priority}`} aria-hidden />;
}

/** The priority as a small badge; 'normal' shows nothing unless `always`. */
export function PriorityBadge({ priority, always = false }: { priority: Priority; always?: boolean }) {
  const { t } = useT();
  if (priority === 'normal' && !always) return null;
  return (
    <span className={`prio prio-${priority}`} title={t.priority.title(t.priority[priority])}>
      <PriorityIcon priority={priority} size={13} />{t.priority[priority]}
    </span>
  );
}

/** The due date, coloured by how close it is. */
export function DueChip({ dueOn }: { dueOn: string }) {
  const { t } = useT();
  return (
    <span className={`due due-${dueState(dueOn)}`} title={t.due.title(formatDay(dueOn, t))}>
      <CalendarClock size={12} aria-hidden />{dueLabel(dueOn, t)}
    </span>
  );
}

/** A menu section to pick a task's priority; the current one is marked and disabled. */
export function priorityGroup(task: TaskDto, t: Messages, onSet: (p: Priority) => void): MenuGroup {
  return {
    title: t.priority.change,
    items: PRIORITIES.map((p) => ({
      label: p === task.priority ? `${t.priority[p]} ✓` : t.priority[p], icon: <PriorityIcon priority={p} />,
      disabled: p === task.priority && task.prioritySource === 'owner', onSelect: () => onSet(p),
    })),
  };
}

type TaskList = { tasks: TaskDto[] };
export type PlanningChange = { task: TaskDto; priority?: Priority; dueOn?: string | null };

/**
 * Sets a task's priority and/or due date. Like a status change, it shows at once in every cached list and in the
 * task's detail, and rolls back if the server refuses it.
 */
export function useSetPlanning(track?: { onMutate?: () => void; onError?: (e: unknown) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { t } = useT();
  return useMutation({
    mutationFn: ({ task, priority, dueOn }: PlanningChange) =>
      api(`/tasks/${task.id}/planning`, { method: 'PATCH', json: { ...(priority ? { priority } : {}), ...(dueOn !== undefined ? { due_on: dueOn } : {}) } }),
    onMutate: async ({ task, priority, dueOn }: PlanningChange) => {
      track?.onMutate?.();
      await Promise.all([qc.cancelQueries({ queryKey: ['tasks'] }), qc.cancelQueries({ queryKey: ['task', task.id] })]);
      const lists = qc.getQueriesData<TaskList>({ queryKey: ['tasks'] });
      const detail = qc.getQueryData<TaskDetailDto>(['task', task.id]);
      const patch = (x: TaskDto): TaskDto => ({
        ...x, ...(priority ? { priority, prioritySource: 'owner' as const } : {}), ...(dueOn !== undefined ? { dueOn } : {}),
      });
      qc.setQueriesData<TaskList>({ queryKey: ['tasks'] }, (d) => (d?.tasks ? { ...d, tasks: d.tasks.map((x) => (x.id === task.id ? patch(x) : x)) } : d));
      if (detail) qc.setQueryData<TaskDetailDto>(['task', task.id], { ...detail, task: patch(detail.task) });
      return { lists, detail };
    },
    onError: (e, { task }, ctx) => {
      ctx?.lists.forEach(([key, data]) => qc.setQueryData(key, data));
      if (ctx?.detail) qc.setQueryData(['task', task.id], ctx.detail);
      track?.onError?.(e);
    },
    onSuccess: (_r, { task, priority, dueOn }) => {
      if (priority) toast(`${task.ref}: ${t.priority[priority]}`);
      else toast(dueOn ? `${task.ref}: ${t.due.title(formatDay(dueOn, t))}` : `${task.ref}: ${t.due.cleared}`);
    },
    onSettled: (_r, _e, { task }) => {
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['task', task.id] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
    },
  });
}
