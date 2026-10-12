import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Check, Inbox, Quote, X } from 'lucide-react';
import { api, type TaskDto } from '../api';
import { ReasonDialog } from '../components/Dialog';
import { EmptyState } from '../components/EmptyState';
import { ErrorLine } from '../components/ErrorLine';
import { useToast } from '../components/Toast';
import { useT } from '../i18n';
import { formatTime, relativeTime } from '../labels';

type Act = { task: TaskDto; action: 'accept' | 'reject'; reason?: string };

export function Proposals() {
  const { t } = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [rejecting, setRejecting] = useState<TaskDto | null>(null);
  const q = useQuery({ queryKey: ['tasks', 'proposed'], queryFn: () => api<{ tasks: TaskDto[] }>('/tasks?status=proposed') });
  const act = useMutation({
    mutationFn: ({ task, action, reason }: Act) =>
      api(`/proposals/${task.id}/${action}`, { method: 'POST', json: action === 'reject' ? { reason } : {} }),
    onSuccess: (_r, { task, action }) => {
      toast(action === 'accept' ? t.proposals.accepted(task.ref) : t.proposals.rejected(task.ref));
      return qc.invalidateQueries({ queryKey: ['tasks'] });
    },
    // a failed action (e.g. someone else already handled the proposal) means the list is stale
    onError: () => qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
  const list = q.data?.tasks ?? [];
  return (
    <div className="page page-narrow">
      <div className="page-head">
        <h1>{t.proposals.title} {list.length > 0 && <span className="count count-lg">{list.length}</span>}</h1>
      </div>
      <p className="page-sub">{t.proposals.sub}</p>
      <ErrorLine error={act.error ?? q.error} />
      {!list.length && !q.isLoading && !q.error && (
        <EmptyState icon={<Inbox size={28} />} title={t.proposals.emptyTitle} text={t.proposals.emptyText} />
      )}
      <div className="stack">
        {list.map((p) => (
          <article key={p.id} className="proposal">
            <div className="proposal-meta">
              <span className="chip" title={p.projectName}>{p.projectKey}</span>
              <span className="ref">{p.ref}</span>
              <time dateTime={p.createdAt} title={formatTime(p.createdAt, t)}>{relativeTime(p.createdAt, t)}</time>
            </div>
            <h2 className="proposal-title">{p.title}</h2>
            {p.description && <p className="proposal-description">{p.description}</p>}
            {p.sourceQuote && <blockquote className="quote"><Quote size={14} aria-hidden /><span>{p.sourceQuote}</span></blockquote>}
            <div className="row-actions">
              <button type="button" className="btn btn-primary btn-sm" disabled={act.isPending} onClick={() => act.mutate({ task: p, action: 'accept' })}>
                <Check size={14} aria-hidden />{t.proposals.accept}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={act.isPending} onClick={() => setRejecting(p)}>
                <X size={14} aria-hidden />{t.proposals.reject}
              </button>
            </div>
          </article>
        ))}
      </div>
      <ReasonDialog
        open={!!rejecting} title={t.proposals.rejectTitle(rejecting?.ref ?? '')} label={t.proposals.rejectLabel} confirmLabel={t.proposals.reject} danger
        message={rejecting && <p className="muted">{rejecting.title}</p>}
        onCancel={() => setRejecting(null)}
        onConfirm={(reason) => { if (rejecting) act.mutate({ task: rejecting, action: 'reject', reason }); setRejecting(null); }}
      />
    </div>
  );
}
