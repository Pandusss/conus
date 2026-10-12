import { useQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type SessionDto } from '../api';
import { EmptyState } from '../components/EmptyState';
import { ErrorLine } from '../components/ErrorLine';
import { SessionState, sessionDuration } from '../components/SessionState';
import { useT } from '../i18n';
import { formatDuration, formatTime, relativeTime } from '../labels';

export function Sessions() {
  const { t } = useT();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['sessions'], queryFn: () => api<{ sessions: SessionDto[] }>('/sessions'), refetchInterval: 30_000 });
  const sessions = q.data?.sessions ?? [];
  return (
    <div className="page">
      <div className="page-head"><h1>{t.sessions.title}</h1></div>
      <p className="page-sub">{t.sessions.sub}</p>
      <ErrorLine error={q.error} />
      {!sessions.length && !q.isLoading && !q.error && (
        <EmptyState icon={<Activity size={28} />} title={t.sessions.emptyTitle} text={t.sessions.emptyText} />
      )}
      {sessions.length > 0 && (
        <div className="table-card">
          <table className="table">
            <thead>
              <tr>
                <th>{t.sessions.session}</th><th>{t.sessions.agent}</th><th>{t.sessions.project}</th><th>{t.sessions.branch}</th>
                <th>{t.sessions.started}</th><th>{t.sessions.duration}</th>
                <th className="num">{t.sessions.taskOps}</th><th className="num">{t.sessions.nudges}</th><th className="num">{t.sessions.cleanup}</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} className="row-link" onClick={() => nav(`/sessions/${s.id}`)}>
                  <td>
                    <div className="session-cell">
                      <SessionState state={s.state} />
                      <Link to={`/sessions/${s.id}`} className="mono" onClick={(e) => e.stopPropagation()}>{s.ref}</Link>
                    </div>
                  </td>
                  <td>{s.agentName}</td>
                  <td>{s.projectKey ? <span className="chip">{s.projectKey}</span> : <span className="muted">—</span>}</td>
                  <td>{s.branch ? <span className="mono muted">{s.branch}</span> : <span className="muted">—</span>}</td>
                  <td title={formatTime(s.startedAt, t)}>{relativeTime(s.startedAt, t)}</td>
                  <td className="num">{formatDuration(sessionDuration(s), t)}</td>
                  <td className="num">{s.taskOps}</td>
                  <td className="num">{s.nudges} <span className="muted">({s.nudgesActed})</span></td>
                  <td className={`num${s.janitorReleases ? ' warn-text' : ''}`}>{s.janitorReleases}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
