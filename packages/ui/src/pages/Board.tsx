import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Bug, Ellipsis, GitCommitHorizontal, ListTree, Search } from 'lucide-react';
import { Link, Outlet } from 'react-router-dom';
import { api, type ProjectDto, type Status, type TaskDto } from '../api';
import { Avatar } from '../components/Avatar';
import { ErrorLine, useActionError } from '../components/ErrorLine';
import { Menu } from '../components/Menu';
import { StatusDot } from '../components/StatusPill';
import { useT } from '../i18n';
import { MOVABLE_STATUSES, formatTime, needsReason, relativeTime } from '../labels';
import { useProjectFilter } from '../project-filter';
import { MoveReasonDialog, useSetStatus } from '../task-actions';

const COLUMNS: Status[] = ['todo', 'in_progress', 'blocked', 'review', 'done'];
/** Closed columns show only the most recent tasks until «Show all». */
const CLOSED_LIMIT = 20;

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

/** The board; the task drawer (/tasks/:id) renders over it through the <Outlet />, so filters survive opening a task. */
export function Board() {
  const { t } = useT();
  const { project, setProject } = useProjectFilter();
  const [showDropped, setShowDropped] = useState(false);
  const [onlyBugs, setOnlyBugs] = useState(false);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<Status>('todo');
  const [expanded, setExpanded] = useState<Status[]>([]);
  const [pending, setPending] = useState<{ task: TaskDto; status: Status } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<Status | null>(null);
  const dragged = useRef<TaskDto | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const { error, track } = useActionError();
  const move = useSetStatus(track);

  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<{ projects: ProjectDto[] }>('/projects') });
  // A remembered project may have been merged away or renamed; once the list is known, forget a key that is not in it.
  const known = projects.data?.projects;
  const stale = !!project && !!known && !known.some((p) => p.key === project);
  useEffect(() => {
    if (stale) setProject('');
  }, [stale, setProject]);
  const statuses: Status[] = showDropped ? [...COLUMNS, 'dropped'] : COLUMNS;
  const tasks = useQuery({
    queryKey: ['tasks', project, statuses.join(',')],
    queryFn: () => api<{ tasks: TaskDto[] }>(`/tasks?status=${statuses.join(',')}${project ? `&project=${encodeURIComponent(project)}` : ''}`),
    refetchInterval: 15_000,
    // Never ask for a project we have not validated against the list (it would 404): wait for the list, or its failure.
    enabled: !stale && (!project || !projects.isPending),
  });

  // «/» focuses the search, unless the user is typing somewhere or a modal is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const activeTab: Status = statuses.includes(tab) ? tab : 'todo';
  const all = tasks.data?.tasks ?? [];
  const needle = search.trim().toLowerCase();
  const visible = all.filter((x) =>
    (!onlyBugs || x.type === 'bug') && (!needle || x.ref.toLowerCase().includes(needle) || x.title.toLowerCase().includes(needle)));
  const inColumn = (s: Status) => visible.filter((x) => x.status === s);

  const requestMove = (task: TaskDto, status: Status) => {
    if (task.status === status) return;
    if (needsReason(status)) setPending({ task, status });
    else move.mutate({ task, status });
  };
  const onDrop = (e: DragEvent, s: Status) => {
    e.preventDefault();
    setOver(null);
    const id = dragged.current?.id ?? e.dataTransfer?.getData('text/plain');
    dragged.current = null;
    setDragging(null);
    const task = all.find((x) => x.id === id);
    if (task) requestMove(task, s);
  };

  return (
    <div className="board-page">
      <div className="page-head board-head">
        <h1>{t.board.title}</h1>
        <div className="board-tools">
          <select className="select" aria-label={t.board.project} value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">{t.common.allProjects}</option>
            {known?.map((p) => <option key={p.id} value={p.key}>{p.name} ({p.key})</option>)}
          </select>
          <div className="search">
            <Search size={16} aria-hidden />
            <input
              ref={searchRef} type="search" aria-label={t.board.searchLabel} placeholder={t.board.search} value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape' && search) { e.stopPropagation(); setSearch(''); } }}
            />
            <kbd aria-hidden="true">/</kbd>
          </div>
          <button type="button" className="toggle" aria-pressed={onlyBugs} onClick={() => setOnlyBugs((v) => !v)}>
            <Bug size={14} aria-hidden />{t.board.onlyBugs}
          </button>
          <button type="button" className="toggle" aria-pressed={showDropped} onClick={() => setShowDropped((v) => !v)}>{t.board.dropped}</button>
        </div>
      </div>
      <ErrorLine error={error ?? projects.error ?? tasks.error} />
      <div className="status-tabs" role="group" aria-label={t.board.column}>
        {statuses.map((s) => (
          <button key={s} type="button" className="status-tab" aria-pressed={activeTab === s} onClick={() => setTab(s)}>
            <StatusDot status={s} />{t.status[s]}<span className="count">{inColumn(s).length}</span>
          </button>
        ))}
      </div>
      <div className={`board${showDropped ? ' has-dropped' : ''}`}>
        {statuses.map((s) => {
          const list = inColumn(s);
          const limited = (s === 'done' || s === 'dropped') && !expanded.includes(s) && list.length > CLOSED_LIMIT;
          const shown = limited ? list.slice(0, CLOSED_LIMIT) : list;
          return (
            <section
              key={s} aria-label={t.status[s]} data-active={activeTab === s}
              className={`column st-${s}${over === s ? ' is-over' : ''}`}
              onDragOver={(e) => {
                if (!dragged.current) return;
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                if (over !== s) setOver(s);
              }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === s ? null : o)); }}
              onDrop={(e) => onDrop(e, s)}
            >
              <header className="column-head">
                <StatusDot status={s} />
                <h2>{t.status[s]}</h2>
                <span className="count">{list.length}</span>
              </header>
              <div className="column-list">
                {shown.map((x) => (
                  <TaskCard
                    key={x.id} task={x} showProject={!project} dragging={dragging === x.id} onMove={requestMove}
                    onDragStart={() => { dragged.current = x; setDragging(x.id); }}
                    onDragEnd={() => { dragged.current = null; setDragging(null); setOver(null); }}
                  />
                ))}
                {!shown.length && <p className="column-empty">{tasks.isPending && !tasks.error ? t.common.loading : t.board.empty}</p>}
                {limited && (
                  <button type="button" className="btn btn-ghost btn-sm show-all" onClick={() => setExpanded((x) => [...x, s])}>
                    {t.board.showAll(list.length)}
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <MoveReasonDialog
        move={pending}
        onCancel={() => setPending(null)}
        onConfirm={(reason) => { if (pending) move.mutate({ ...pending, reason }); setPending(null); }}
      />
      <Outlet />
    </div>
  );
}

function TaskCard({ task, showProject, dragging, onMove, onDragStart, onDragEnd }: {
  task: TaskDto; showProject: boolean; dragging: boolean;
  onMove: (task: TaskDto, status: Status) => void; onDragStart: () => void; onDragEnd: () => void;
}) {
  const { t } = useT();
  return (
    <article
      className={`task-card${dragging ? ' is-dragging' : ''}`} draggable data-task={task.ref}
      onDragStart={(e) => {
        if (e.dataTransfer) { e.dataTransfer.setData('text/plain', task.id); e.dataTransfer.effectAllowed = 'move'; }
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <div className="task-card-top">
        <span className="ref">{task.ref}</span>
        {task.type === 'bug' && <span className="tag tag-bug"><Bug size={12} aria-hidden />{t.board.bug}</span>}
        <Menu
          label={t.board.cardActions(task.ref)} className="icon-btn icon-btn-sm card-menu"
          groups={[{
            title: t.board.changeStatus,
            items: MOVABLE_STATUSES.filter((s) => s !== task.status)
              .map((s) => ({ label: t.status[s], icon: <StatusDot status={s} />, onSelect: () => onMove(task, s) })),
          }]}
        >
          <Ellipsis size={16} aria-hidden />
        </Menu>
      </div>
      <Link to={`/tasks/${task.id}`} className="task-card-title" draggable={false}>{task.title}</Link>
      {task.status === 'blocked' && task.blockReason && <p className="card-note is-blocked" title={task.blockReason}>{task.blockReason}</p>}
      {task.status === 'review' && <p className="card-note is-review">{t.board.awaitingReview}</p>}
      {task.status === 'done' && task.result && <p className="card-note" title={task.result}>{task.result}</p>}
      <div className="task-card-meta">
        {showProject && <span className="chip" title={task.projectName}>{task.projectKey}</span>}
        {task.holder && (
          <span className="chip chip-holder" title={`${task.holder.agentName} · ${task.holder.sessionRef}`}>
            {task.status === 'in_progress' && <span className="pulse" aria-hidden="true" />}
            <Avatar name={task.holder.agentName} size="xs" />
            <span className="chip-text">{task.holder.agentName}</span>
          </span>
        )}
        <time className="meta-time" dateTime={task.updatedAt} title={t.board.updatedAt(formatTime(task.updatedAt, t))}>{relativeTime(task.updatedAt, t)}</time>
        {task.subtaskCount > 0 && (
          <span className="meta-count" title={t.board.subtasks(task.subtaskCount)}><ListTree size={13} aria-hidden />{task.subtaskCount}</span>
        )}
        {task.commitCount > 0 && (
          <span className="meta-count" title={t.board.commits(task.commitCount)}><GitCommitHorizontal size={13} aria-hidden />{task.commitCount}</span>
        )}
      </div>
    </article>
  );
}
