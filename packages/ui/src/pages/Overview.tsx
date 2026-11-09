import { useQuery } from '@tanstack/react-query';
import { AlarmClock, Ban, Bot, ChevronDown, ChevronRight, Eye, LayoutDashboard, Lightbulb, SquareKanban } from 'lucide-react';
import { useId, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { api, type OverviewDto, type OverviewTaskDto, type ProjectOverviewDto } from '../api';
import { Avatar } from '../components/Avatar';
import { EmptyState } from '../components/EmptyState';
import { ErrorLine } from '../components/ErrorLine';
import { ManagerPanel } from '../components/ManagerPanel';
import { DueChip, PriorityIcon } from '../components/Planning';
import { useT, type Messages } from '../i18n';
import { dueLabel, dueState, formatDuration, formatTime, relativeTime } from '../labels';
import { useProjectFilter } from '../project-filter';

/** What a project asks of the owner right now; the page lists the groups in this order. */
type Group = 'waiting' | 'working' | 'idle' | 'empty';
const GROUPS: Group[] = ['waiting', 'working', 'idle', 'empty'];
const GROUP_TONE: Record<Group, string> = { waiting: 'st-review', working: 'st-in_progress', idle: 'st-todo', empty: 'st-dropped' };

interface Row {
  project: ProjectOverviewDto;
  group: Group;
  /** The project's open tasks with a due date, nearest first; `overdue` are the ones already past it. */
  dated: OverviewTaskDto[];
  overdue: OverviewTaskDto[];
}

function toRow(p: ProjectOverviewDto, dated: OverviewTaskDto[]): Row {
  const mine = dated.filter((x) => x.projectKey === p.key);
  const overdue = mine.filter((x) => x.dueOn && dueState(x.dueOn) === 'overdue');
  const group: Group = p.counts.review + p.counts.blocked + overdue.length > 0 ? 'waiting'
    : p.live.length > 0 || p.counts.in_progress > 0 ? 'working'
      : p.counts.todo + p.counts.proposed > 0 ? 'idle' : 'empty';
  return { project: p, group, dated: mine, overdue };
}

/** «waiting 12 min» / «waiting 5 h» / «waiting 22 d»: how long a task has been waiting, to the largest unit. */
function waited(since: string, t: Messages): string {
  const ms = Math.max(0, Date.now() - Date.parse(since));
  const h = Math.floor(ms / 3_600_000);
  return t.overview.waitingFor(h < 1 ? formatDuration(ms, t) : h < 24 ? t.duration.hours(h, 0) : t.duration.days(Math.floor(h / 24), 0));
}

const stop = (e: MouseEvent) => e.stopPropagation();

/**
 * Every project on one screen, grouped by what it asks of the owner: the ones waiting for them first, then the ones
 * agents are busy in, then the idle ones. A row says what is going on in one line and opens into the project's tasks.
 * The task drawer (/tasks/:id) opens over the page.
 */
export function Overview() {
  const { t } = useT();
  const q = useQuery({ queryKey: ['overview'], queryFn: () => api<OverviewDto>('/overview'), refetchInterval: 30_000 });
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (!n.delete(id)) n.add(id); return n; });
  const o = q.data;
  const rows = (o?.projects ?? []).map((p) => toRow(p, o!.attention.dated));

  return (
    <div className="page page-wide overview">
      <div className="page-head"><h1>{t.overview.title}</h1></div>
      <ErrorLine error={q.error} />
      {!o ? (!q.error && <p className="muted">{t.common.loading}</p>) : !o.projects.length ? (
        <EmptyState icon={<LayoutDashboard size={24} aria-hidden />} title={t.overview.emptyTitle} text={t.overview.emptyText} />
      ) : (
        <>
          <Lead rows={rows} proposals={o.attention.proposals} />
          <ManagerPanel />
          <div className="ov-table">
            <div className="ov-cols" aria-hidden="true">
              <span>{t.overview.cols.project}</span>
              <span>{t.overview.cols.now}</span>
              <span>{t.overview.cols.waiting}</span>
              <span className="is-num">{t.overview.cols.queue}</span>
              <span className="is-num">{t.overview.cols.done}</span>
              <span>{t.overview.cols.agent}</span>
              <span />
            </div>
            {GROUPS.map((g) => {
              const list = rows.filter((r) => r.group === g);
              return list.length > 0 && <GroupSection key={g} group={g} rows={list} open={open} onToggle={toggle} />;
            })}
          </div>
        </>
      )}
      <Outlet />
    </div>
  );
}

/** The answer to «what needs me?» in one line, with the totals behind it; the chips are the legend of the rows' chips. */
function Lead({ rows, proposals }: { rows: Row[]; proposals: number }) {
  const { t } = useT();
  const sum = (f: (r: Row) => number) => rows.reduce((n, r) => n + f(r), 0);
  const waiting = rows.filter((r) => r.group === 'waiting').length;
  const review = sum((r) => r.project.counts.review);
  const blocked = sum((r) => r.project.counts.blocked);
  const overdue = sum((r) => r.overdue.length);
  const live = rows.filter((r) => r.project.live.length > 0).length;
  const done = sum((r) => r.project.doneThisWeek);
  return (
    <div className="ov-lead">
      <div className="ov-lead-top">
        <p className={`ov-lead-main${waiting ? '' : ' is-clear'}`}>{waiting ? t.overview.lead.waiting(waiting) : t.overview.lead.clear}</p>
        <div className="ov-lead-chips">
          {review > 0 && <span className="ov-chip ov-chip-lg st-review"><Eye size={14} aria-hidden />{t.overview.lead.review(review)}</span>}
          {blocked > 0 && <span className="ov-chip ov-chip-lg st-blocked"><Ban size={14} aria-hidden />{t.overview.lead.blocked(blocked)}</span>}
          {overdue > 0 && <span className="ov-chip ov-chip-lg is-danger"><AlarmClock size={14} aria-hidden />{t.overview.lead.overdue(overdue)}</span>}
          {proposals > 0 && (
            <Link to="/proposals" className="ov-chip ov-chip-lg st-proposed">
              <Lightbulb size={14} aria-hidden />{t.overview.proposals(proposals)}<ChevronRight size={14} aria-hidden />
            </Link>
          )}
        </div>
      </div>
      <p className="ov-lead-side">
        <span className="ov-lead-live">{live > 0 && <span className="pulse" aria-hidden="true" />}{live > 0 ? t.overview.lead.working(live) : t.overview.lead.nobody}</span>
        {done > 0 && <span>{t.overview.lead.done(done)}</span>}
      </p>
    </div>
  );
}

function GroupSection({ group, rows, open, onToggle }: { group: Group; rows: Row[]; open: ReadonlySet<string>; onToggle: (id: string) => void }) {
  const { t } = useT();
  const id = useId();
  // Projects with nothing open are one line until asked for: they need no attention.
  const foldable = group === 'empty';
  const [folded, setFolded] = useState(foldable);
  const title = t.overview.groups[group];
  return (
    <section className={`ov-group is-${group}`} aria-labelledby={id}>
      <div className="ov-group-head">
        <span className={`dot ${GROUP_TONE[group]}`} aria-hidden="true" />
        <h2 id={id}>
          {foldable ? (
            <button type="button" className="ov-fold" aria-expanded={!folded} onClick={() => setFolded((f) => !f)}>
              {title}<ChevronDown size={14} aria-hidden className="ov-chevron" />
            </button>
          ) : title}
        </h2>
        <span className="count">{rows.length}</span>
        <span className="ov-group-hint">{t.overview.groupHint[group]}</span>
      </div>
      {!folded && (
        <ul className="ov-rows">
          {rows.map((r) => <ProjectRow key={r.project.id} row={r} open={open.has(r.project.id)} onToggle={() => onToggle(r.project.id)} />)}
        </ul>
      )}
    </section>
  );
}

function ProjectRow({ row, open, onToggle }: { row: Row; open: boolean; onToggle: () => void }) {
  const { t } = useT();
  const nav = useNavigate();
  const { setProject } = useProjectFilter();
  const id = useId();
  const p = row.project;
  const openBoard = () => { setProject(p.key); nav('/board'); };
  return (
    <li className={`ov-item${open ? ' is-open' : ''}`}>
      {/* The whole row opens the project; the name is the button that does it from the keyboard. */}
      <div className="ov-row" onClick={onToggle}>
        <div className="ov-name">
          <span className="key-badge">{p.key}</span>
          <button type="button" className="ov-toggle" aria-expanded={open} aria-controls={open ? id : undefined} title={p.name}>{p.name}</button>
        </div>
        <div className="ov-now"><NowLine row={row} /></div>
        <div className="ov-wait">
          {p.counts.review > 0 && <Chip tone="st-review" icon={<Eye size={13} aria-hidden />} n={p.counts.review} label={t.overview.chip.review(p.counts.review)} />}
          {p.counts.blocked > 0 && <Chip tone="st-blocked" icon={<Ban size={13} aria-hidden />} n={p.counts.blocked} label={t.overview.chip.blocked(p.counts.blocked)} />}
          {row.overdue.length > 0 && <Chip tone="is-danger" icon={<AlarmClock size={13} aria-hidden />} n={row.overdue.length} label={t.overview.chip.overdue(row.overdue.length)} />}
          {p.counts.proposed > 0 && <Chip tone="st-proposed" icon={<Lightbulb size={13} aria-hidden />} n={p.counts.proposed} label={t.overview.chip.proposals(p.counts.proposed)} />}
        </div>
        <div className="ov-meta">
          <span className={`ov-num${p.counts.todo ? '' : ' is-zero'}`}><span className="ov-label">{`${t.overview.cols.queue}: `}</span>{p.counts.todo}</span>
          <span className={`ov-num${p.doneThisWeek ? '' : ' is-zero'}`}><span className="ov-label">{`${t.overview.cols.done}: `}</span>{p.doneThisWeek}</span>
          {p.live.length > 0 ? (
            <span className="ov-agent is-live" title={p.live.map((l) => `${l.agentName} · ${l.ref}`).join('\n')}>
              <span className="pulse" aria-hidden="true" /><span className="ov-label">{`${t.overview.cols.agent}: `}</span>{t.overview.agentNow}
            </span>
          ) : (
            <span className="ov-agent" title={p.lastAgentAt ? t.overview.agentSeen(formatTime(p.lastAgentAt, t)) : t.overview.agentNever}>
              <span className="ov-label">{`${t.overview.cols.agent}: `}</span>{p.lastAgentAt ? relativeTime(p.lastAgentAt, t) : '—'}
            </span>
          )}
        </div>
        <div className="ov-act">
          <button type="button" className="icon-btn icon-btn-sm" aria-label={t.overview.boardOf(p.name)} title={t.overview.boardOf(p.name)}
            onClick={(e) => { e.stopPropagation(); openBoard(); }}>
            <SquareKanban size={15} aria-hidden />
          </button>
          <ChevronDown size={15} aria-hidden className="ov-chevron" />
        </div>
      </div>
      {open && <ProjectDetails id={id} row={row} onBoard={openBoard} />}
    </li>
  );
}

function Chip({ tone, icon, n, label }: { tone: string; icon: ReactNode; n: number; label: string }) {
  return <span className={`ov-chip ${tone}`} title={label}>{icon}<span aria-hidden="true">{n}</span><span className="sr-only">{label}</span></span>;
}

/** The one thing to know about the project right now: what waits for the owner, else what an agent is doing, else what is next. */
function NowLine({ row }: { row: Row }) {
  const { t } = useT();
  const p = row.project;
  const title = (x: OverviewTaskDto) => <Link to={`/tasks/${x.id}`} className="ov-now-title" onClick={stop}>{x.title}</Link>;
  if (row.group === 'waiting') {
    const [b] = p.blocked; const [r] = p.review; const [d] = row.overdue;
    if (b) return <><Ban size={14} aria-hidden className="ov-now-icon st-blocked" />{title(b)}{b.blockReason && <span className="ov-now-note">{` — ${b.blockReason}`}</span>}</>;
    if (r) return <><Eye size={14} aria-hidden className="ov-now-icon st-review" />{title(r)}<span className="ov-now-note">{` · ${waited(r.updatedAt, t)}`}</span></>;
    if (d) return <><AlarmClock size={14} aria-hidden className="ov-now-icon is-danger" />{title(d)}<span className="ov-now-note">{` · ${dueLabel(d.dueOn!, t)}`}</span></>;
  }
  if (row.group === 'working') {
    const [x] = p.inProgress;
    if (!x) return <><Bot size={14} aria-hidden className="ov-now-icon" /><span className="ov-now-note">{t.overview.now.agentIdle}</span></>;
    return (
      <>
        {x.holder ? <Avatar name={x.holder.agentName} size="xs" /> : <Bot size={14} aria-hidden className="ov-now-icon" />}
        {title(x)}
        {p.counts.in_progress > 1 && <span className="ov-now-note">{` · ${t.overview.now.more(p.counts.in_progress - 1)}`}</span>}
      </>
    );
  }
  if (row.group === 'idle') {
    const [x] = p.next;
    if (!x) return <><Lightbulb size={14} aria-hidden className="ov-now-icon st-proposed" /><span className="ov-now-note">{t.overview.now.proposals(p.counts.proposed)}</span></>;
    return (
      <>
        <span className="ov-now-pre">{t.overview.now.next}</span>
        {(x.priority === 'urgent' || x.priority === 'high') && <PriorityIcon priority={x.priority} />}
        {title(x)}
        {x.dueOn && <span className="ov-now-note">{` · ${dueLabel(x.dueOn, t)}`}</span>}
      </>
    );
  }
  return <span className="ov-now-note">{t.overview.now.nothing}</span>;
}

/** The opened project: what waits for the owner first, then what is being done and what is next. */
function ProjectDetails({ id, row, onBoard }: { id: string; row: Row; onBoard: () => void }) {
  const { t } = useT();
  const p = row.project;
  const listed = new Set([...p.review, ...p.blocked, ...p.inProgress, ...p.next].map((x) => x.id));
  const dated = row.dated.filter((x) => !listed.has(x.id));
  const any = p.review.length + p.blocked.length + p.inProgress.length + p.next.length + dated.length > 0;
  return (
    <div className="ov-details" id={id}>
      {any ? (
        <div className="ov-blocks">
          <Block title={t.overview.review} total={p.counts.review} tasks={p.review} tone="st-review"
            aside={(x) => waited(x.updatedAt, t)} />
          <Block title={t.overview.blocked} total={p.counts.blocked} tasks={p.blocked} tone="st-blocked"
            note={(x) => x.blockReason} />
          <Block title={t.overview.dated} total={dated.length} tasks={dated} />
          <Block title={t.overview.inProgress} total={p.counts.in_progress} tasks={p.inProgress} tone="st-in_progress"
            lead={(x) => (x.holder ? <Avatar name={x.holder.agentName} size="xs" /> : <Bot size={14} aria-hidden className="muted" />)}
            aside={(x) => x.holder?.agentName} />
          <Block title={t.overview.next} total={p.counts.todo} tasks={p.next} tone="st-todo"
            lead={(x) => <PriorityIcon priority={x.priority} />} />
        </div>
      ) : <p className="muted ov-nothing">{t.overview.nothingOpen}</p>}
      <div className="ov-details-foot">
        {p.live.length > 0 ? (
          <>
            <span className="ov-live"><span className="pulse" aria-hidden="true" />{t.overview.working(p.live.length)}</span>
            {p.live.map((l) => (
              <Link key={l.id} to={`/sessions/${l.id}`} className="ov-session"><Avatar name={l.agentName} size="xs" />{`${l.agentName} · ${l.ref}`}</Link>
            ))}
          </>
        ) : <span className="muted">{p.lastAgentAt ? t.overview.agentSeen(relativeTime(p.lastAgentAt, t)) : t.overview.agentNever}</span>}
        {p.counts.proposed > 0 && <Link to="/proposals" className="ov-foot-link">{t.overview.proposals(p.counts.proposed)}</Link>}
        <button type="button" className="btn btn-secondary btn-sm" onClick={onBoard}>{t.overview.openBoard}<ChevronRight size={14} aria-hidden /></button>
      </div>
    </div>
  );
}

function Block({ title, total, tasks, tone, lead, aside, note }: {
  title: string; total: number; tasks: OverviewTaskDto[]; tone?: string;
  lead?: (x: OverviewTaskDto) => ReactNode; aside?: (x: OverviewTaskDto) => ReactNode; note?: (x: OverviewTaskDto) => string | null | undefined;
}) {
  const { t } = useT();
  if (!tasks.length) return null;
  return (
    <div className="ov-block">
      <h3>{tone && <span className={`dot ${tone}`} aria-hidden="true" />}{title}<span className="count">{total}</span></h3>
      <ul>
        {tasks.map((x) => {
          const more = aside?.(x);
          const why = note?.(x);
          return (
            <li key={x.id}>
              <div className="ov-task">
                {lead?.(x)}
                <span className="ref">{x.ref}</span>
                <Link to={`/tasks/${x.id}`} title={x.title}>{x.title}</Link>
                {x.dueOn && <DueChip dueOn={x.dueOn} />}
                {more && <span className="ov-task-aside">{more}</span>}
              </div>
              {why && <p className="ov-task-note" title={why}>{why}</p>}
            </li>
          );
        })}
      </ul>
      {total > tasks.length && <p className="muted ov-block-more">{t.overview.more(total - tasks.length)}</p>}
    </div>
  );
}
