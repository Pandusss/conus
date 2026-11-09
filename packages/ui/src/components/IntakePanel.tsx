import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { MessageSquareText } from 'lucide-react';
import { api, type IntakeBatchDto, type SettingsDto } from '../api';
import { useT } from '../i18n';
import { ErrorLine } from './ErrorLine';
import { PriorityBadge } from './Planning';
import { useToast } from './Toast';

const MAX = 30_000;

/** Pasted correspondence → the manager files the work in it as proposals; the list below shows them. */
export function IntakePanel() {
  const { t } = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const id = useId();
  const [text, setText] = useState('');
  const [last, setLast] = useState<IntakeBatchDto | null>(null);
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsDto>('/settings') });
  const run = useMutation({
    mutationFn: (body: string) => api<{ batch: IntakeBatchDto }>('/intake', { method: 'POST', json: { text: body } }),
    onSuccess: ({ batch }) => {
      setLast(batch);
      setText('');
      toast(batch.tasks.length ? t.intake.result(batch.tasks.length) : t.intake.nothing);
      void qc.invalidateQueries({ queryKey: ['tasks'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
    },
  });
  const off = settings.data?.manager?.enabled === false;
  return (
    <section className="panel intake-panel">
      <h2><MessageSquareText size={16} aria-hidden />{t.intake.title}</h2>
      <p className="muted">{off ? t.intake.off : t.intake.sub}</p>
      {!off && (
        <form className="edit-form" onSubmit={(e) => { e.preventDefault(); if (text.trim()) run.mutate(text); }}>
          <div className="field">
            <label htmlFor={id} className="sr-only">{t.intake.label}</label>
            <textarea id={id} rows={6} maxLength={MAX} value={text} placeholder={t.intake.placeholder} disabled={run.isPending}
              onChange={(e) => setText(e.target.value)} />
          </div>
          <div className="row-actions">
            <button type="submit" className="btn btn-primary btn-sm" disabled={run.isPending || !text.trim()}>
              {run.isPending ? t.intake.submitting : t.intake.submit}
            </button>
          </div>
        </form>
      )}
      <ErrorLine error={run.error} />
      {last && (
        <div className="intake-result">
          {last.summary && <p className="manager-summary">{last.summary}</p>}
          {last.tasks.length > 0 && (
            <ul className="change-list">
              {last.tasks.map((x) => (
                <li key={x.id}><span className="chip">{x.projectKey}</span><PriorityBadge priority={x.priority} /><span>{x.title}</span></li>
              ))}
            </ul>
          )}
          {last.duplicates.length > 0 && (
            <>
              <p className="muted">{t.intake.duplicates}</p>
              <ul className="change-list">
                {last.duplicates.map((d) => <li key={d.ref + d.title}><span className="ref">{d.ref}</span><span>{d.existingTitle}</span><span className="muted">← {d.title}</span></li>)}
              </ul>
            </>
          )}
        </div>
      )}
    </section>
  );
}
