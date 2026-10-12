import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, BellRing, Check, CircleDot, Minus, Wrench } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { api, type EventDto, type SessionDto } from '../api';
import { ErrorLine } from '../components/ErrorLine';
import { useT } from '../i18n';
import { eventLabel, formatDuration, formatTime, relativeTime, ruleLabel } from '../labels';
import { SessionState, sessionDuration } from '../components/SessionState';

type TaskEvent = EventDto & { taskRef: string; taskTitle: string };
type Ov = { session: SessionDto; events: TaskEvent[]; nudges: { rule: string; reason: string; acted: boolean; createdAt: string }[]; janitor: TaskEvent[] };

function Tile({ label, value, sub, warn }: { label: string; value: string | number; sub?: string; warn?: boolean }) {
  return (
    <div className={`tile${warn ? ' is-warn' : ''}`}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}

function TaskEventList({ events, empty }: { events: TaskEvent[]; empty: string }) {
  const { t } = useT();
  if (!events.length) return <p className="muted">{empty}</p>;
  return (
    <ol className="timeline">
      {events.map((e) => (
        <li key={e.id} className="tl-item">
          <span className="tl-icon" aria-hidden="true"><CircleDot size={14} /></span>
          <div className="tl-body">
            <div className="tl-head">
              <Link to={`/tasks/${e.taskId}`} className="mono">{e.taskRef}</Link>
              <span className="tl-title">{e.taskTitle}</span>
              <span className="tl-what">{eventLabel(e.type, t)}</span>
              <time className="tl-time" dateTime={e.createdAt} title={formatTime(e.createdAt, t)}>{relativeTime(e.createdAt, t)}</time>
            </div>
            {e.reason && <p className="tl-reason">{t.common.reasonLine(e.reason)}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function SessionPage() {
  const { t } = useT();
  const { id } = useParams();
  const q = useQuery({ queryKey: ['session', id], queryFn: () => api<Ov>(`/sessions/${id}`) });
  const back = <Link to="/sessions" className="back-link"><ArrowLeft size={14} aria-hidden />{t.session.back}</Link>;
  if (!q.data) return <div className="page">{back}{q.error ? <ErrorLine error={q.error} /> : <p className="muted">{t.common.loading}</p>}</div>;
  const { session: s, events, nudges, janitor } = q.data;
  return (
    <div className="page">
      {back}
      <div className="page-head">
        <h1><span className="mono">{s.ref}</span> · {s.agentName}</h1>
        <SessionState state={s.state} />
      </div>
      <p className="page-sub">
        {s.projectKey ?? t.session.noProject}{s.branch && <> · <span className="mono">{s.branch}</span></>} · {formatTime(s.startedAt, t)} — {s.endedAt ? formatTime(s.endedAt, t) : t.session.ongoing}
      </p>
      <div className="tiles">
        <Tile label={t.session.duration} value={formatDuration(sessionDuration(s), t)} />
        <Tile label={t.session.taskOps} value={s.taskOps} />
        <Tile label={t.session.nudges} value={s.nudges} sub={t.session.actedOn(s.nudgesActed)} />
        <Tile label={t.session.cleanup} value={s.janitorReleases} warn={s.janitorReleases > 0} sub={t.session.cleanupSub} />
      </div>

      <section className="section">
        <h2>{t.session.tasksTitle}</h2>
        <TaskEventList events={events} empty={t.session.nothing} />
      </section>
      <section className="section">
        <h2>{t.session.nudgesTitle}</h2>
        {!nudges.length ? <p className="muted">{t.session.noNudges}</p> : (
          <ol className="timeline">
            {nudges.map((n, i) => (
              <li key={i} className="tl-item">
                <span className={`tl-icon${n.acted ? ' toned st-done' : ''}`} aria-hidden="true"><BellRing size={14} /></span>
                <div className="tl-body">
                  <div className="tl-head">
                    <span className="tag">{ruleLabel(n.rule, t)}</span>
                    <span className={`acted${n.acted ? ' is-acted' : ''}`}>
                      {n.acted ? <><Check size={14} aria-hidden />{t.session.acted}</> : <><Minus size={14} aria-hidden />{t.session.ignored}</>}
                    </span>
                    <time className="tl-time" dateTime={n.createdAt} title={formatTime(n.createdAt, t)}>{relativeTime(n.createdAt, t)}</time>
                  </div>
                  <p className="tl-note">{n.reason}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section className="section">
        <h2><Wrench size={16} aria-hidden />{t.session.cleanupTitle}</h2>
        <TaskEventList events={janitor} empty={t.session.noCleanup} />
      </section>
    </div>
  );
}
