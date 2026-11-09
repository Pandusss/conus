import { useQuery } from '@tanstack/react-query';
import { Ban, Bot, CalendarClock, ChevronRight, Eye, Inbox, LayoutDashboard, PartyPopper } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { api, type OpenStatus, type OverviewDto, type OverviewTaskDto, type ProjectOverviewDto } from '../api';
import { Avatar } from '../components/Avatar';
import { EmptyState } from '../components/EmptyState';
import { ErrorLine } from '../components/ErrorLine';
import { DueChip, PriorityBadge, PriorityIcon } from '../components/Planning';
import { StatusDot } from '../components/StatusPill';
import { useT } from '../i18n';
import { dueState, formatTime, relativeTime } from '../labels';
import { useProjectFilter } from '../project-filter';

/** Columns of the project bar, in board order. */
const BAR: OpenStatus[] = ['todo', 'in_progress', 'blocked', 'review'];

/** Every project at a glance, and what waits for the owner. The task drawer (/tasks/:id) opens over it. */
export function Overview() {
  const { t } = useT();
  const q = useQuery({ queryKey: ['overview'], queryFn: () => api<OverviewDto>('/overview'), refetchInterval: 30_000 });
  const o = q.data;
  const active = o?.projects.filter((p) => !p.quiet) ?? [];
  const quiet = o?.projects.filter((p) => p.quiet) ?? [];
  const sum = (f: (p: ProjectOverviewDto) => number) => (o?.projects ?? []).reduce((n, p) => n + f(p), 0);
  const overdue = (o?.attention.dated ?? []).filter((x) => x.dueOn && dueState(x.dueOn) === 'overdue').length;
  const waiting = o ? o.attention.review.length + o.attention.blocked.length + overdue + o.attention.proposals : 0;

  return (
    <div className="page page-wide overview">
      <div className="page-head"><h1>{t.overview.title}</h1></div>
      <p className="page-sub">{t.overview.sub}</p>
      <ErrorLine error={q.error} />
      {!o ? (!q.error && <p className="muted">{t.common.loading}</p>) : !o.projects.length ? (
        <EmptyState icon={<LayoutDashboard size={24} aria-hidden />} title={t.overview.emptyTitle} text={t.overview.emptyText} />
      ) : (
        <>
          <div className="tiles">
            <Tile label={t.overview.tiles.inProgress} value={sum((p) => p.counts.in_progress)} sub={t.overview.working(sum((p) => p.live.length))} />
            <Tile label={t.overview.tiles.review} value={sum((p) => p.counts.review)} warn={sum((p) => p.counts.review) > 0} />
            <Tile label={t.overview.tiles.blocked} value={sum((p) => p.counts.blocked)} warn={sum((p) => p.counts.blocked) > 0} />
            <Tile label={t.overview.tiles.overdue} value={overdue} danger={overdue > 0} />
            <Tile label={t.overview.tiles.doneWeek} value={sum((p) => p.doneThisWeek)} />
          </div>

          <section className="section">
            <h2>{t.overview.needsYou}{waiting > 0 && <span className="count">{waiting}</span>}</h2>
            {waiting === 0 ? (
              <div className="panel panel-success all-clear"><PartyPopper size={16} aria-hidden />{t.overview.allClear}</div>
            ) : (
              <div className="attention">
                {o.attention.review.length > 0 && (
                  <AttentionList icon={<Eye size={15} aria-hidden />} title={t.overview.review} tone="review">
                    {o.attention.review.map((x) => (
                      <TaskRow key={x.id} task={x} aside={<span className="muted">{t.overview.reviewWaiting(relativeTime(x.updatedAt, t))}</span>} />
                    ))}
                  </AttentionList>
                )}
                {o.attention.blocked.length > 0 && (
                  <AttentionList icon={<Ban size={15} aria-hidden />} title={t.overview.blocked} tone="blocked">
                    {o.attention.blocked.map((x) => <TaskRow key={x.id} task={x} note={x.blockReason} />)}
                  </AttentionList>
                )}
                {o.attention.dated.length > 0 && (
                  <AttentionList icon={<CalendarClock size={15} aria-hidden />} title={t.overview.dated} tone="dated">
                    {o.attention.dated.map((x) => <TaskRow key={x.id} task={x} aside={<DueChip dueOn={x.dueOn!} />} />)}
                  </AttentionList>
                )}
                {o.attention.proposals > 0 && (
                  <Link to="/proposals" className="attention-link"><Inbox size={15} aria-hidden />{t.overview.proposals(o.attention.proposals)}<ChevronRight size={15} aria-hidden /></Link>
                )}
              </div>
            )}
          </section>

          <section className="section">
            <h2>{t.overview.projects}<span className="count">{active.length}</span></h2>
            <div className="ov-grid">{active.map((p) => <ProjectCard key={p.id} project={p} />)}</div>
            {quiet.length > 0 && (
              <details className="quiet">
                <summary>{t.overview.quiet(quiet.length)}<span className="muted"> · {t.overview.quietHint}</span></summary>
                <div className="ov-grid">{quiet.map((p) => <ProjectCard key={p.id} project={p} />)}</div>
              </details>
            )}
          </section>
        </>
      )}
      <Outlet />
    </div>
  );
}

function Tile({ label, value, sub, warn, danger }: { label: string; value: number; sub?: string; warn?: boolean; danger?: boolean }) {
  return (
    <div className={`tile${danger ? ' is-danger' : warn ? ' is-warn' : ''}`}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}

function AttentionList({ icon, title, tone, children }: { icon: ReactNode; title: string; tone: string; children: ReactNode }) {
  return (
    <div className={`attention-list tone-${tone}`}>
      <h3>{icon}{title}</h3>
      <ul>{children}</ul>
    </div>
  );
}

/** One task in a list: ref, title (opens the task), its project, and an optional note or right-hand detail. */
function TaskRow({ task, note, aside }: { task: OverviewTaskDto; note?: string | null; aside?: ReactNode }) {
  return (
    <li className="task-row">
      <div className="task-row-main">
        <span className="ref">{task.ref}</span>
        <PriorityBadge priority={task.priority} />
        <Link to={`/tasks/${task.id}`} className="task-row-title">{task.title}</Link>
        {aside && <span className="task-row-aside">{aside}</span>}
      </div>
      {note && <p className="task-row-note" title={note}>{note}</p>}
    </li>
  );
}

function ProjectCard({ project: p }: { project: ProjectOverviewDto }) {
  const { t } = useT();
  const nav = useNavigate();
  const { setProject } = useProjectFilter();
  const open = p.counts.todo + p.counts.in_progress + p.counts.blocked + p.counts.review;
  const openBoard = () => { setProject(p.key); nav('/board'); };
  return (
    <article className={`ov-card${p.live.length ? ' is-live' : ''}`}>
      <header className="ov-card-head">
        <span className="key-badge">{p.key}</span>
        <h3 title={p.name}>{p.name}</h3>
        {p.live.length > 0 ? (
          <span className="ov-live" title={p.live.map((l) => `${l.agentName} · ${l.ref}`).join('\n')}>
            <span className="pulse" aria-hidden="true" />{t.overview.working(p.live.length)}
          </span>
        ) : (
          <span className="muted ov-when" title={p.lastActivityAt ? formatTime(p.lastActivityAt, t) : undefined}>
            {p.lastActivityAt ? t.overview.lastActivity(relativeTime(p.lastActivityAt, t)) : t.overview.noActivity}
          </span>
        )}
      </header>

      {open > 0 ? (
        <div className="ov-bar" role="img" aria-label={BAR.map((s) => `${t.status[s]}: ${p.counts[s]}`).join(', ')}>
          {BAR.filter((s) => p.counts[s] > 0).map((s) => <span key={s} className={`st-${s}`} style={{ flexGrow: p.counts[s] }} />)}
        </div>
      ) : <div className="ov-bar is-empty" aria-hidden="true" />}
      <div className="ov-counts">
        {BAR.filter((s) => p.counts[s] > 0).map((s) => (
          <span key={s} className="ov-count"><StatusDot status={s} />{t.status[s]} <b>{p.counts[s]}</b></span>
        ))}
        {open === 0 && <span className="muted">{t.overview.nothingOpen}</span>}
      </div>

      {p.inProgress.length > 0 && (
        <div className="ov-block">
          <div className="ov-block-title">{t.overview.inProgress}</div>
          <ul className="ov-list">
            {p.inProgress.map((x) => (
              <li key={x.id}>
                {x.holder ? <Avatar name={x.holder.agentName} size="xs" /> : <Bot size={14} aria-hidden className="muted" />}
                <Link to={`/tasks/${x.id}`} title={x.holder ? `${x.title} — ${x.holder.agentName}` : x.title}>{x.title}</Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(p.blocked.length > 0 || p.review.length > 0) && (
        <div className="ov-block">
          <ul className="ov-list">
            {p.blocked.map((x) => (
              <li key={x.id} className="is-blocked"><StatusDot status="blocked" /><Link to={`/tasks/${x.id}`} title={x.blockReason ?? x.title}>{x.title}</Link></li>
            ))}
            {p.review.map((x) => (
              <li key={x.id}><StatusDot status="review" /><Link to={`/tasks/${x.id}`}>{x.title}</Link></li>
            ))}
          </ul>
        </div>
      )}
      {p.next.length > 0 && (
        <div className="ov-block">
          <div className="ov-block-title">{t.overview.next}</div>
          <ul className="ov-list">
            {p.next.map((x) => (
              <li key={x.id}>
                <PriorityIcon priority={x.priority} />
                <Link to={`/tasks/${x.id}`}>{x.title}</Link>
                {x.dueOn && <DueChip dueOn={x.dueOn} />}
              </li>
            ))}
          </ul>
        </div>
      )}

      <footer className="ov-card-foot">
        <span className="muted">{p.doneThisWeek > 0 ? t.overview.doneWeek(p.doneThisWeek) : ''}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={openBoard}>{t.overview.openBoard}<ChevronRight size={14} aria-hidden /></button>
      </footer>
    </article>
  );
}
