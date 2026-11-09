import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Sparkles, Target } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, type ReviewDto, type SettingsDto } from '../api';
import { useT } from '../i18n';
import { formatTime, relativeTime } from '../labels';
import { ErrorLine, useActionError } from './ErrorLine';
import { PriorityBadge } from './Planning';
import { useToast } from './Toast';

type ReviewState = { review: ReviewDto | null } & Pick<SettingsDto, 'manager'>;

/** The manager's latest review on the overview: its summary, today's focus, priority changes and notes. */
export function ManagerPanel() {
  const { t } = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const { error, track } = useActionError();
  const q = useQuery({ queryKey: ['manager', 'review'], queryFn: () => api<ReviewState>('/manager/review'), refetchInterval: 120_000 });
  const run = useMutation({
    mutationFn: () => api<ReviewState>('/manager/review', { method: 'POST' }),
    onSuccess: (d) => {
      qc.setQueryData(['manager', 'review'], d);
      void qc.invalidateQueries({ queryKey: ['overview'] });
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      toast(t.manager.ran);
    },
    ...track,
  });
  if (!q.data) return q.error ? <ErrorLine error={q.error} /> : null;
  const review = q.data.review ?? null;
  const manager = q.data.manager ?? { enabled: false, model: null };
  if (!manager.enabled && !review) {
    return <div className="panel manager-panel is-off"><h2><Sparkles size={16} aria-hidden />{t.manager.title}</h2><p className="muted">{t.manager.off}</p></div>;
  }
  const applied = review?.changes.filter((c) => c.applied) ?? [];
  const suggested = review?.changes.filter((c) => !c.applied) ?? [];
  return (
    <section className="panel manager-panel" aria-label={t.manager.title}>
      <div className="manager-head">
        <h2><Sparkles size={16} aria-hidden />{t.manager.title}</h2>
        {review && <span className="muted" title={formatTime(review.createdAt, t)}>{t.manager.at(relativeTime(review.createdAt, t))}</span>}
        {manager.enabled && (
          <button type="button" className="btn btn-secondary btn-sm" disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? t.manager.running : t.manager.run}
          </button>
        )}
      </div>
      <ErrorLine error={error} />
      {!review ? <p className="muted">{t.manager.never}</p> : (
        <>
          {review.summary !== '—' && <p className="manager-summary">{review.summary}</p>}
          {review.focus.length > 0 && (
            <div className="manager-block">
              <h3><Target size={14} aria-hidden />{t.manager.focus}</h3>
              <ol className="focus-list">
                {review.focus.map((f) => (
                  <li key={f.taskId}>
                    <Link to={`/tasks/${f.taskId}`}><span className="ref">{f.ref}</span> {f.title}</Link>
                    <span className="muted focus-why">{f.why}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {(applied.length > 0 || suggested.length > 0) && (
            <details className="manager-block">
              <summary>{applied.length ? t.manager.changes(applied.length) : t.manager.suggested(suggested.length)}</summary>
              <ul className="change-list">
                {[...applied, ...suggested].map((c) => (
                  <li key={c.taskId}>
                    <Link to={`/tasks/${c.taskId}`} className="ref">{c.ref}</Link>
                    <PriorityBadge priority={c.from} always /><ArrowRight size={12} aria-hidden /><PriorityBadge priority={c.to} always />
                    {!c.applied && <span className="tag">{t.manager.suggestedTag}</span>}
                    <span className="muted">{c.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {review.findings.length > 0 && (
            <details className="manager-block">
              <summary>{t.manager.findings} ({review.findings.length})</summary>
              <ul className="change-list">
                {review.findings.map((f, i) => (
                  <li key={i}><span className="tag">{t.manager.finding[f.kind]}</span><span className="mono">{f.refs.join(', ')}</span><span className="muted">{f.note}</span></li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
