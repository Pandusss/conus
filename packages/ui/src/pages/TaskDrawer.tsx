import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Ban, ChevronDown, CircleCheck, Ellipsis, GitCommitHorizontal, GitMerge, Pencil, Quote, Trash2, X } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, HttpError, type Status, type TaskDto } from '../api';
import { Avatar } from '../components/Avatar';
import { ConfirmDialog, Dialog } from '../components/Dialog';
import { ErrorLine, useActionError } from '../components/ErrorLine';
import { trapTab, useEscapeLayer, useFocusInside } from '../components/layers';
import { Menu } from '../components/Menu';
import { StatusDot, StatusPill } from '../components/StatusPill';
import { Timeline } from '../components/Timeline';
import { useToast } from '../components/Toast';
import { useT } from '../i18n';
import { MOVABLE_STATUSES, formatTime, needsReason, relativeTime } from '../labels';
import { MoveReasonDialog, useSetStatus, type TaskDetailDto } from '../task-actions';

/** The edit form; `version` is the task version the user started editing from (optimistic-lock token). */
type Draft = { title: string; description: string; version: number };

/**
 * The /tasks/:id drawer over the board. Esc, a click on the overlay or ✕ go back to the board (its filters live in the
 * board, which stays mounted underneath).
 */
export function TaskDrawer() {
  const { t } = useT();
  const { id } = useParams();
  const nav = useNavigate();
  const close = useCallback(() => nav('/'), [nav]);
  const panel = useRef<HTMLDivElement>(null);
  useEscapeLayer(close);
  useFocusInside(panel, { self: true });
  return createPortal(
    <div className="drawer-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={panel} className="drawer" role="dialog" aria-modal="true" aria-label={t.task.dialogLabel} tabIndex={-1} onKeyDown={(e) => trapTab(e, panel.current)}>
        {/* keyed by id so the edit draft and action error never carry over to another task */}
        <TaskDetail key={id} id={id!} onClose={close} />
      </div>
    </div>,
    document.body,
  );
}

export function TaskDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useT();
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const q = useQuery({ queryKey: ['task', id], queryFn: () => api<TaskDetailDto>(`/tasks/${id}`) });
  const [edit, setEdit] = useState<Draft | null>(null);
  const [dialog, setDialog] = useState<null | 'merge' | 'delete'>(null);
  const [moving, setMoving] = useState<{ task: TaskDto; status: Status } | null>(null);
  const { error, track } = useActionError();
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['task', id] }); void qc.invalidateQueries({ queryKey: ['tasks'] }); };
  const onError = (e: unknown) => {
    track.onError(e);
    // somebody changed the task under us: pull the current version so the next attempt starts from it
    if (e instanceof HttpError && e.code === 'conflict_version') void qc.invalidateQueries({ queryKey: ['task', id] });
  };
  const setStatus = useSetStatus({ onMutate: track.onMutate, onError });
  const save = useMutation({
    mutationFn: (d: Draft) => api(`/tasks/${id}`, { method: 'PATCH', json: { title: d.title, description: d.description, expected_version: d.version } }),
    onSuccess: () => { setEdit(null); refresh(); toast(t.task.saved); }, onMutate: track.onMutate, onError,
  });
  const merge = useMutation({
    mutationFn: (into: TaskDto) => api(`/tasks/${id}/merge`, { method: 'POST', json: { into_id: into.id } }),
    onSuccess: (_r, into) => { setDialog(null); refresh(); toast(t.task.mergedInto(into.ref)); nav(`/tasks/${into.id}`); },
    onMutate: track.onMutate, onError,
  });
  const del = useMutation({
    mutationFn: () => api(`/tasks/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDialog(null);
      void qc.invalidateQueries({ queryKey: ['tasks'] }); // the board must not keep showing the deleted task
      toast(t.task.deleted(q.data?.task.ref));
      nav('/');
    },
    onMutate: track.onMutate, onError,
  });
  const busy = setStatus.isPending || save.isPending || merge.isPending || del.isPending;

  const closeButton = (
    <button type="button" className="icon-btn" aria-label={t.common.close} onClick={onClose}><X size={18} aria-hidden /></button>
  );
  if (!q.data) {
    return (
      <>
        <div className="drawer-head"><div className="drawer-head-main" />{closeButton}</div>
        <div className="drawer-body">{q.error ? <ErrorLine error={q.error} /> : <p className="muted">{t.common.loading}</p>}</div>
      </>
    );
  }
  const { task, events, links, subtasks } = q.data;
  const requestMove = (status: Status) => {
    if (needsReason(status)) setMoving({ task, status });
    else setStatus.mutate({ task, status });
  };

  return (
    <>
      <div className="drawer-head">
        <div className="drawer-head-main">
          <span className="ref">{task.ref}</span>
          <span className={`tag${task.type === 'bug' ? ' tag-bug' : ''}`}>{task.type === 'bug' ? t.task.bug : t.task.task}</span>
          <Menu
            label={t.task.statusButton(t.status[task.status])} className={`pill pill-button st-${task.status}`} disabled={busy} align="start"
            groups={[{
              title: t.task.changeStatus,
              items: MOVABLE_STATUSES.filter((s) => s !== task.status)
                .map((s) => ({ label: t.status[s], icon: <StatusDot status={s} />, onSelect: () => requestMove(s) })),
            }]}
          >
            <StatusDot status={task.status} />{t.status[task.status]}<ChevronDown size={14} aria-hidden />
          </Menu>
        </div>
        <Menu
          label={t.task.actions} disabled={busy}
          groups={[{
            items: [
              { label: t.task.duplicateOf, icon: <GitMerge size={16} aria-hidden />, onSelect: () => setDialog('merge') },
              { label: t.task.delete, icon: <Trash2 size={16} aria-hidden />, danger: true, onSelect: () => setDialog('delete') },
            ],
          }]}
        >
          <Ellipsis size={18} aria-hidden />
        </Menu>
        {closeButton}
      </div>

      <div className="drawer-body">
        {edit ? (
          <EditForm edit={edit} busy={busy} onChange={setEdit} onSave={() => save.mutate(edit)} onCancel={() => setEdit(null)} />
        ) : (
          <div className="task-heading">
            <h2 className="task-title">{task.title}</h2>
            <button
              type="button" className="btn btn-ghost btn-sm" disabled={busy}
              onClick={() => setEdit({ title: task.title, description: task.description, version: task.version })}
            >
              <Pencil size={14} aria-hidden />{t.task.edit}
            </button>
          </div>
        )}
        <ErrorLine error={error ?? q.error} />
        {!edit && (task.description ? <p className="task-description pre">{task.description}</p> : <p className="muted">{t.task.noDescription}</p>)}

        <dl className="meta-grid">
          <div><dt>{t.task.project}</dt><dd>{task.projectName} <span className="muted mono">{task.projectKey}</span></dd></div>
          <div>
            <dt>{t.task.holder}</dt>
            <dd>
              {task.holder ? (
                <span className="holder">
                  <Avatar name={task.holder.agentName} size="xs" />{task.holder.agentName}
                  <Link to={`/sessions/${task.holder.sessionId}`} className="mono">{task.holder.sessionRef}</Link>
                </span>
              ) : <span className="muted">—</span>}
            </dd>
          </div>
          <div>
            <dt>{t.task.parent}</dt>
            <dd>{task.parentRef ? (task.parentId ? <Link to={`/tasks/${task.parentId}`} className="mono">{task.parentRef}</Link> : task.parentRef) : <span className="muted">—</span>}</dd>
          </div>
          <div><dt>{t.task.created}</dt><dd title={formatTime(task.createdAt, t)}>{formatTime(task.createdAt, t)} <span className="muted">· {relativeTime(task.createdAt, t)}</span></dd></div>
          <div><dt>{t.task.updated}</dt><dd title={formatTime(task.updatedAt, t)}>{formatTime(task.updatedAt, t)} <span className="muted">· {relativeTime(task.updatedAt, t)}</span></dd></div>
        </dl>

        {task.result && (
          <section className="panel panel-success">
            <h3><CircleCheck size={16} aria-hidden />{t.task.result}</h3>
            <p className="pre">{task.result}</p>
          </section>
        )}
        {task.blockReason && (
          <section className="panel panel-danger">
            <h3><Ban size={16} aria-hidden />{t.task.blocker}</h3>
            <p className="pre">{task.blockReason}</p>
          </section>
        )}
        {task.sourceQuote && (
          <section className="section">
            <h3>{t.task.source}</h3>
            <blockquote className="quote"><Quote size={14} aria-hidden /><span>{task.sourceQuote}</span></blockquote>
          </section>
        )}
        {subtasks.length > 0 && (
          <section className="section">
            <h3>{t.task.subtasks} <span className="count">{subtasks.length}</span></h3>
            <ul className="link-list">
              {subtasks.map((s) => (
                <li key={s.id}>
                  <Link to={`/tasks/${s.id}`}><span className="ref">{s.ref}</span><span className="link-list-title">{s.title}</span></Link>
                  <StatusPill status={s.status} />
                </li>
              ))}
            </ul>
          </section>
        )}
        {links.length > 0 && (
          <section className="section">
            <h3>{t.task.commits} <span className="count">{links.length}</span></h3>
            <ul className="commit-list">
              {links.map((l) => (
                <li key={l.id}>
                  <GitCommitHorizontal size={14} aria-hidden />
                  <code className="sha">{l.ref.slice(0, 7)}</code>
                  <span>{l.meta?.subject ?? (l.kind === 'branch' ? t.task.branch : '')}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section className="section">
          <h3>{t.task.history}</h3>
          <Timeline events={events} />
        </section>
      </div>

      <MoveReasonDialog
        move={moving} onCancel={() => setMoving(null)}
        onConfirm={(reason) => { if (moving) setStatus.mutate({ ...moving, reason }); setMoving(null); }}
      />
      <ConfirmDialog
        open={dialog === 'delete'} title={t.task.deleteTitle} danger confirmLabel={t.task.delete} busy={del.isPending}
        message={<p><span className="mono">{task.ref}</span> {t.task.deleteText(task.title)}</p>}
        onConfirm={() => del.mutate()} onCancel={() => setDialog(null)}
      />
      {dialog === 'merge' && (
        <MergeDialog task={task} busy={merge.isPending} onConfirm={(into) => merge.mutate(into)} onCancel={() => setDialog(null)} />
      )}
    </>
  );
}

function EditForm({ edit, busy, onChange, onSave, onCancel }: {
  edit: Draft; busy: boolean; onChange: (d: Draft) => void; onSave: () => void; onCancel: () => void;
}) {
  const { t } = useT();
  const titleId = useId();
  const descId = useId();
  return (
    <form className="edit-form" onSubmit={(e) => { e.preventDefault(); onSave(); }}>
      <div className="field">
        <label htmlFor={titleId}>{t.task.titleLabel}</label>
        <input id={titleId} value={edit.title} maxLength={200} required autoFocus onChange={(e) => onChange({ ...edit, title: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor={descId}>{t.task.descriptionLabel}</label>
        <textarea id={descId} rows={8} value={edit.description} onChange={(e) => onChange({ ...edit, description: e.target.value })} />
      </div>
      <div className="row-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>{t.common.save}</button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>{t.common.cancel}</button>
      </div>
    </form>
  );
}

/** «Duplicate of…»: pick the main task of the same project; this one is dropped into it. */
function MergeDialog({ task, busy, onConfirm, onCancel }: { task: TaskDto; busy: boolean; onConfirm: (into: TaskDto) => void; onCancel: () => void }) {
  const { t } = useT();
  const [into, setInto] = useState('');
  const fieldId = useId();
  const siblings = useQuery({
    queryKey: ['tasks', 'siblings', task.projectKey],
    queryFn: () => api<{ tasks: TaskDto[] }>(`/tasks?project=${encodeURIComponent(task.projectKey)}&status=proposed,todo,in_progress,blocked,review`),
  });
  const options = (siblings.data?.tasks ?? []).filter((o) => o.id !== task.id);
  const target = options.find((o) => o.id === into);
  return (
    <Dialog
      open title={t.task.mergeTitle(task.ref)} onClose={onCancel} onSubmit={() => { if (target && !busy) onConfirm(target); }}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>{t.common.cancel}</button>
          <button type="submit" className="btn btn-primary" disabled={!target || busy}>{t.task.mergeConfirm}</button>
        </>
      )}
    >
      <div className="field">
        <label htmlFor={fieldId}>{t.task.mainTask}</label>
        <select id={fieldId} className="select" value={into} data-autofocus onChange={(e) => setInto(e.target.value)}>
          <option value="">{siblings.isPending ? t.common.loading : t.task.pickTask}</option>
          {options.map((o) => <option key={o.id} value={o.id}>{o.ref} {o.title}</option>)}
        </select>
      </div>
      <ErrorLine error={siblings.error} />
      <p className="dialog-note">{t.task.mergeNote}</p>
    </Dialog>
  );
}
