import { useQuery } from '@tanstack/react-query';
import { TriangleAlert } from 'lucide-react';
import { api, type WarningDto } from '../api';
import { useT, type Messages } from '../i18n';
import { ErrorLine } from './ErrorLine';

/** A warning in the UI language; a kind this UI does not know (or one missing its numbers) shows the server's text. */
export function warningText(w: WarningDto, t: Messages): string {
  switch (w.kind) {
    case 'hooks_missing': return t.health.hooksMissing(w.agentName);
    case 'agent_silent': return t.health.agentSilent(w.agentName);
    case 'janitor_interventions':
      return typeof w.count === 'number' && typeof w.days === 'number'
        ? t.health.janitorInterventions(w.agentName, w.count, w.days)
        : w.message;
    default: return w.message;
  }
}

/** Agent health warnings, as a slim banner at the top of the content area. */
export function HealthBanner() {
  const { t } = useT();
  const q = useQuery({ queryKey: ['health'], queryFn: () => api<{ warnings: WarningDto[] }>('/health'), refetchInterval: 60_000 });
  const warnings = q.data?.warnings ?? [];
  if (!q.error && !warnings.length) return null;
  return (
    <div className="banners">
      {q.error && <div className="banner banner-muted"><ErrorLine error={q.error} prefix={t.health.unavailable} /></div>}
      {warnings.length > 0 && (
        <div className="banner banner-warn">
          {warnings.map((w, i) => <p key={i}><TriangleAlert size={16} aria-hidden /><span>{warningText(w, t)}</span></p>)}
        </div>
      )}
    </div>
  );
}
