import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Bot, Check, Code, Copy, KeyRound, Plus, Sparkles, type LucideIcon } from 'lucide-react';
import { api, type AgentDto } from '../api';
import { ConfirmDialog, Dialog } from '../components/Dialog';
import { EmptyState } from '../components/EmptyState';
import { ErrorLine, useActionError } from '../components/ErrorLine';
import { useToast } from '../components/Toast';
import { useT } from '../i18n';
import { formatTime, kindLabel, relativeTime } from '../labels';

const KIND_ICON: Record<string, LucideIcon> = { claude_code: Sparkles, codex: Code, other: Bot };
type Issued = { name: string; kind: string; token: string };

export function Agents() {
  const { t } = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['agents'], queryFn: () => api<{ agents: AgentDto[] }>('/agents') });
  const [connecting, setConnecting] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [revoking, setRevoking] = useState<AgentDto | null>(null);
  const { error, track } = useActionError();
  const create = useMutation({
    mutationFn: (b: { name: string; kind: string }) => api<{ agent: AgentDto; token: string }>('/agents', { method: 'POST', json: b }),
    onSuccess: (r) => {
      setIssued({ name: r.agent.name, kind: r.agent.kind, token: r.token });
      setConnecting(false);
      toast(t.agents.connected(r.agent.name));
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (a: AgentDto) => api(`/agents/${a.id}/revoke`, { method: 'POST' }),
    onSuccess: (_r, a) => { setRevoking(null); toast(t.agents.tokenRevoked(a.name)); void qc.invalidateQueries({ queryKey: ['agents'] }); },
    ...track,
  });
  const agents = q.data?.agents ?? [];
  const connect = () => { create.reset(); setConnecting(true); };
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t.agents.title}</h1>
        <button type="button" className="btn btn-primary" onClick={connect}><Plus size={16} aria-hidden />{t.agents.connect}</button>
      </div>
      <p className="page-sub">{t.agents.sub}</p>
      <ErrorLine error={error ?? q.error} />
      {issued && <TokenPanel issued={issued} onHide={() => setIssued(null)} />}
      {!agents.length && !q.isLoading && !q.error && (
        <EmptyState
          icon={<Bot size={28} />} title={t.agents.emptyTitle} text={t.agents.emptyText}
          action={<button type="button" className="btn btn-primary" onClick={connect}><Plus size={16} aria-hidden />{t.agents.connect}</button>}
        />
      )}
      <div className="card-grid">
        {agents.map((a) => {
          const Icon = KIND_ICON[a.kind] ?? Bot;
          return (
            <article key={a.id} className={`agent-card${a.revokedAt ? ' is-revoked' : ''}`} aria-label={a.name}>
              <div className="agent-head">
                <span className="kind-icon" aria-hidden="true"><Icon size={18} /></span>
                <div className="agent-id">
                  <h2>{a.name}</h2>
                  <span className="muted">{kindLabel(a.kind, t)}</span>
                </div>
                {a.revokedAt
                  ? <span className="tag">{t.agents.revoked}</span>
                  : <button type="button" className="btn btn-ghost btn-sm btn-danger-text" disabled={revoke.isPending} onClick={() => setRevoking(a)}>{t.agents.revoke}</button>}
              </div>
              <div className="agent-meta">
                <code className="mono">{a.tokenPrefix}…</code>
                <span title={a.lastSeenAt ? formatTime(a.lastSeenAt, t) : undefined}>
                  {a.lastSeenAt ? t.agents.lastSeen(relativeTime(a.lastSeenAt, t)) : t.agents.neverSeen}
                </span>
              </div>
              <dl className="stats" aria-label={t.agents.stats}>
                <div><dt>{t.agents.sessions}</dt><dd>{a.stats.sessions}</dd></div>
                <div><dt>{t.agents.nudges}</dt><dd>{a.stats.nudges}<span className="stat-sub">{t.agents.actedOn(a.stats.nudgesActed)}</span></dd></div>
                <div className={a.stats.janitorReleases ? 'is-warn' : ''}><dt>{t.agents.cleanups}</dt><dd>{a.stats.janitorReleases}</dd></div>
              </dl>
              <div className="stats-caption">{t.agents.statsCaption}</div>
            </article>
          );
        })}
      </div>
      {connecting && (
        <ConnectDialog busy={create.isPending} error={create.error} onSubmit={(b) => create.mutate(b)} onCancel={() => setConnecting(false)} />
      )}
      <ConfirmDialog
        open={!!revoking} title={t.agents.revokeTitle(revoking?.name ?? '')} danger confirmLabel={t.agents.revoke} busy={revoke.isPending}
        message={t.agents.revokeText}
        onConfirm={() => { if (revoking) revoke.mutate(revoking); }} onCancel={() => setRevoking(null)}
      />
    </div>
  );
}

function ConnectDialog({ busy, error, onSubmit, onCancel }: {
  busy: boolean; error: unknown; onSubmit: (b: { name: string; kind: string }) => void; onCancel: () => void;
}) {
  const { t } = useT();
  const [name, setName] = useState('');
  const [kind, setKind] = useState('claude_code');
  const nameId = useId();
  const kindId = useId();
  return (
    <Dialog
      open title={t.agents.connect} onClose={onCancel} onSubmit={() => { if (name.trim() && !busy) onSubmit({ name: name.trim(), kind }); }}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel}>{t.common.cancel}</button>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>{t.agents.connectConfirm}</button>
        </>
      )}
    >
      <div className="field">
        <label htmlFor={nameId}>{t.agents.name}</label>
        <input id={nameId} placeholder="claude-code@laptop" value={name} maxLength={100} required data-autofocus onChange={(e) => setName(e.target.value)} />
        <span className="field-hint">{t.agents.nameHint}</span>
      </div>
      <div className="field">
        <label htmlFor={kindId}>{t.agents.kind}</label>
        <select id={kindId} className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="claude_code">{kindLabel('claude_code', t)}</option>
          <option value="codex">{kindLabel('codex', t)}</option>
          <option value="other">{kindLabel('other', t)}</option>
        </select>
      </div>
      <ErrorLine error={error} />
    </Dialog>
  );
}

/** The one-time token with the commands to run on the agent's machine. */
function TokenPanel({ issued, onHide }: { issued: Issued; onHide: () => void }) {
  const { t } = useT();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const command = `npm install -g conus-cli\nconus setup ${window.location.origin} ${issued.token}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setCopyFailed(false);
      toast(t.agents.commandsCopied);
    } catch {
      setCopyFailed(true);
    }
  };
  return (
    <section className="panel panel-accent token-panel" aria-label={t.agents.tokenPanel}>
      <h2><KeyRound size={16} aria-hidden />{t.agents.tokenFor(issued.name)}</h2>
      <p>{t.agents.tokenHint}</p>
      <div className="code-block">
        <pre>{command}</pre>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copy()}>
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}{copied ? t.agents.copied : t.agents.copy}
        </button>
      </div>
      {copyFailed && <p className="error" role="alert">{t.agents.copyFailed}</p>}
      <div className="row-actions"><button type="button" className="btn btn-ghost btn-sm" onClick={onHide}>{t.agents.hide}</button></div>
    </section>
  );
}
