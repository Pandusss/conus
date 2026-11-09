import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ChevronDown, ChevronUp, Sparkles, Target } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type ReviewDto, type SettingsDto } from '../api';
import { useT } from '../i18n';
import { formatTime, relativeTime } from '../labels';
import { readStored, writeStored } from '../storage';
import { ErrorLine, useActionError } from './ErrorLine';
import { PriorityBadge } from './Planning';
import { useToast } from './Toast';

type ReviewState = { review: ReviewDto | null } & Pick<SettingsDto, 'manager'>;
const COLLAPSED_KEY = 'conus.manager.collapsed';

/** The owner's own choice wins; without one the panel starts folded on a phone, where it would push the projects off the first screen. */
function startsCollapsed(): boolean {
  const stored = readStored(COLLAPSED_KEY);
  if (stored === '1' || stored === '0') return stored === '1';
  try { return typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches; } catch { return false; }
}

/**
 * The manager's latest review on the overview: its summary, today's focus, priority changes and notes. It folds
 * into one line, and stays folded, for an owner who wants the projects first.
 */
export function ManagerPanel() {
  const { t } = useT();
  const [collapsed, setCollapsed] = useState(startsCollapsed);
  const fold = () => { writeStored(COLLAPSED_KEY, collapsed ? '0' : '1'); setCollapsed(!collapsed); };
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
  const summary = review && review.summary !== '—' ? review.summary : null;
  const folded = collapsed && !!review;
  return (
    <section className={`panel manager-panel${folded ? ' is-collapsed' : ''}`} aria-label={t.manager.title}>
      <div className="manager-head">
        <h2><Sparkles size={16} aria-hidden />{t.manager.title}</h2>
        {review && <span className="muted" title={formatTime(review.createdAt, t)}>{t.manager.at(relativeTime(review.createdAt, t))}</span>}
        <div className="manager-actions">
          {manager.enabled && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={run.isPending} onClick={() => run.mutate()}>
              {run.isPending ? t.manager.running : t.manager.run}
            </button>
          )}
          {review && (
            <button type="button" className="icon-btn icon-btn-sm" aria-expanded={!collapsed} onClick={fold}
              aria-label={collapsed ? t.manager.expand : t.manager.collapse} title={collapsed ? t.manager.expand : t.manager.collapse}>
              {collapsed ? <ChevronDown size={15} aria-hidden /> : <ChevronUp size={15} aria-hidden />}
            </button>
          )}
        </div>
      </div>
      <ErrorLine error={error} />
      {!review ? <p className="muted">{t.manager.never}</p> : folded ? (
        (summary ?? review.focus[0]) && <p className="manager-teaser">{summary ?? `${t.manager.focus}: ${review.focus[0]!.title}`}</p>
      ) : (
        <div className={`manager-body${review.focus.length > 0 && (summary || applied.length + suggested.length + review.findings.length > 0) ? ' is-split' : ''}`}>
          <div className="manager-main">
            {summary && <p className="manager-summary">{summary}</p>}
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
          </div>
          {review.focus.length > 0 && (
            <div className="manager-block manager-focus">
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
        </div>
      )}
    </section>
  );
}
