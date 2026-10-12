import {
  ArrowRight, ArrowRightLeft, Ban, CircleCheck, CircleDot, CircleX, Eye, FolderInput, GitCommitHorizontal, GitMerge, Hand,
  Lightbulb, Pencil, Play, Plus, RotateCcw, StickyNote, ThumbsUp, Trash2, Undo2, type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import type { EventDto } from '../api';
import { useT, type Messages } from '../i18n';
import { eventLabel, formatTime, isStatus, relativeTime } from '../labels';
import { Avatar } from './Avatar';
import { StatusPill } from './StatusPill';

const EVENT_ICON: Record<string, LucideIcon> = {
  created: Plus, proposed: Lightbulb, promoted: ThumbsUp, started: Play, updated: Pencil, noted: StickyNote, blocked: Ban,
  completed: CircleCheck, sent_to_review: Eye, reopened: RotateCcw, dropped: CircleX, claimed: Hand, claim_released: Undo2,
  commit_linked: GitCommitHorizontal, merged_duplicate: GitMerge, status_changed: ArrowRightLeft, moved: FolderInput, deleted: Trash2,
};

/** Event types that get the status colour of where they lead. */
const EVENT_TONE: Record<string, string> = {
  completed: 'done', blocked: 'blocked', dropped: 'dropped', sent_to_review: 'review', started: 'in_progress', claimed: 'in_progress',
  proposed: 'proposed', promoted: 'todo', reopened: 'todo',
};

export const actorName = (e: Pick<EventDto, 'actorKind' | 'actorName'>, t: Messages): string =>
  e.actorKind === 'user' ? t.actor.you : e.actorKind === 'system' ? t.actor.system : e.actorName ?? t.actor.agent;

function StatusOrDash({ value }: { value: unknown }) {
  if (isStatus(value)) return <StatusPill status={value} />;
  return <span className="muted">{value === null || value === undefined ? '—' : String(value)}</span>;
}

/** A task's history as a vertical timeline. */
export function Timeline({ events }: { events: EventDto[] }) {
  const { t } = useT();
  if (!events.length) return <p className="muted">{t.task.noEvents}</p>;
  return (
    <ol className="timeline">
      {events.map((e) => {
        const Icon = EVENT_ICON[e.type] ?? CircleDot;
        const who = actorName(e, t);
        const tone = EVENT_TONE[e.type] ?? (isStatus(e.changes?.status?.to) ? (e.changes.status!.to as string) : null);
        return (
          <li key={e.id} className="tl-item">
            <span className={`tl-icon${tone ? ` toned st-${tone}` : ''}`} aria-hidden="true"><Icon size={14} /></span>
            <div className="tl-body">
              <div className="tl-head">
                <span className="tl-actor"><Avatar name={who} size="xs" />{who}</span>
                <span className="tl-what">{eventLabel(e.type, t)}</span>
                {e.sessionRef && e.sessionId && <Link className="tl-session" to={`/sessions/${e.sessionId}`}>{e.sessionRef}</Link>}
                {e.model && <span className="muted tl-model">{e.model}</span>}
                <time className="tl-time" dateTime={e.createdAt} title={formatTime(e.createdAt, t)}>{relativeTime(e.createdAt, t)}</time>
              </div>
              {e.changes?.status && (
                <div className="tl-transition">
                  <StatusOrDash value={e.changes.status.from} />
                  <ArrowRight size={14} aria-hidden /><span className="sr-only">→</span>
                  <StatusOrDash value={e.changes.status.to} />
                </div>
              )}
              {e.reason && <p className="tl-reason">{t.common.reasonLine(e.reason)}</p>}
              {e.note && <p className="tl-note">{e.note}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
