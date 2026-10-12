import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { ArrowRight, FolderKanban, GitMerge, Pencil, TriangleAlert } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, type ProjectDto } from '../api';
import { Dialog, PromptDialog } from '../components/Dialog';
import { EmptyState } from '../components/EmptyState';
import { ErrorLine, useActionError } from '../components/ErrorLine';
import { useToast } from '../components/Toast';
import { useT } from '../i18n';
import { useProjectFilter } from '../project-filter';

export function Projects() {
  const { t } = useT();
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const { setProject } = useProjectFilter();
  const q = useQuery({ queryKey: ['projects'], queryFn: () => api<{ projects: ProjectDto[] }>('/projects') });
  const [renaming, setRenaming] = useState<ProjectDto | null>(null);
  const [merging, setMerging] = useState<ProjectDto | null>(null);
  const { error, track } = useActionError();
  const rename = useMutation({
    mutationFn: (p: { project: ProjectDto; name: string }) => api(`/projects/${p.project.id}`, { method: 'PATCH', json: { name: p.name } }),
    onSuccess: (_r, p) => { setRenaming(null); toast(t.projects.renamed(p.project.key, p.name)); return qc.invalidateQueries(); },
    ...track,
  });
  const merge = useMutation({
    mutationFn: (p: { project: ProjectDto; into: ProjectDto }) => api(`/projects/${p.project.id}/merge`, { method: 'POST', json: { into_id: p.into.id } }),
    onSuccess: (_r, p) => { setMerging(null); toast(t.projects.merged(p.project.key, p.into.key)); return qc.invalidateQueries(); },
    ...track,
  });
  const busy = rename.isPending || merge.isPending;
  const list = q.data?.projects ?? [];
  return (
    <div className="page">
      <div className="page-head"><h1>{t.projects.title}</h1></div>
      <p className="page-sub">{t.projects.sub}</p>
      <ErrorLine error={error ?? q.error} />
      {!list.length && !q.isLoading && !q.error && (
        <EmptyState icon={<FolderKanban size={28} />} title={t.projects.emptyTitle} text={t.projects.emptyText} />
      )}
      <div className="card-grid">
        {list.map((p) => (
          <article key={p.id} className="project-card" aria-label={p.name}>
            <div className="project-head">
              <span className="key-badge">{p.key}</span>
              <h2>{p.name}</h2>
            </div>
            <p className="muted"><span className="num">{p.openCount}</span> {t.projects.openSuffix}</p>
            <div className="row-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setProject(p.key); nav('/'); }}>
                {t.projects.openBoard}<ArrowRight size={14} aria-hidden />
              </button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setRenaming(p)}>
                <Pencil size={14} aria-hidden />{t.projects.rename}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy || list.length < 2} onClick={() => setMerging(p)}>
                <GitMerge size={14} aria-hidden />{t.projects.merge}
              </button>
            </div>
          </article>
        ))}
      </div>
      <PromptDialog
        open={!!renaming} title={t.projects.renameTitle(renaming?.key ?? '')} label={t.projects.nameLabel} initial={renaming?.name} busy={rename.isPending}
        onCancel={() => setRenaming(null)}
        onConfirm={(name) => {
          if (!renaming) return;
          if (name === renaming.name) setRenaming(null);
          else rename.mutate({ project: renaming, name });
        }}
      />
      {merging && (
        <MergeProjectDialog
          project={merging} others={list.filter((o) => o.id !== merging.id)} busy={merge.isPending}
          onCancel={() => setMerging(null)} onConfirm={(into) => merge.mutate({ project: merging, into })}
        />
      )}
    </div>
  );
}

function MergeProjectDialog({ project, others, busy, onConfirm, onCancel }: {
  project: ProjectDto; others: ProjectDto[]; busy: boolean; onConfirm: (into: ProjectDto) => void; onCancel: () => void;
}) {
  const { t } = useT();
  const [into, setInto] = useState('');
  const fieldId = useId();
  const target = others.find((o) => o.id === into);
  return (
    <Dialog
      open title={t.projects.mergeTitle(project.key)} onClose={onCancel} onSubmit={() => { if (target && !busy) onConfirm(target); }}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>{t.common.cancel}</button>
          <button type="submit" className="btn btn-danger" disabled={!target || busy}>{t.projects.mergeConfirm}</button>
        </>
      )}
    >
      <div className="field">
        <label htmlFor={fieldId}>{t.projects.moveTo}</label>
        <select id={fieldId} className="select" value={into} data-autofocus onChange={(e) => setInto(e.target.value)}>
          <option value="">{t.projects.pickProject}</option>
          {others.map((o) => <option key={o.id} value={o.id}>{o.key} — {o.name}</option>)}
        </select>
      </div>
      <p className="dialog-warning">
        <TriangleAlert size={16} aria-hidden />
        <span>{t.projects.mergeWarning(project.key, target?.key)}</span>
      </p>
    </Dialog>
  );
}
