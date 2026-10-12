import type { SessionDto } from '../api';
import { useT } from '../i18n';
import { sessionStateLabel } from '../labels';

/** How long a session ran: until its end, until now while active, until it was last heard from otherwise. */
export function sessionDuration(s: SessionDto, now: number = Date.now()): number {
  const end = s.endedAt ? Date.parse(s.endedAt) : s.state === 'active' ? now : Date.parse(s.lastSeenAt);
  return end - Date.parse(s.startedAt);
}

/** A state dot plus its name: green «active», amber «silent», gray «ended». */
export function SessionState({ state }: { state: string }) {
  const { t } = useT();
  return <span className={`state state-${state}`}><span className="state-dot" aria-hidden="true" />{sessionStateLabel(state, t)}</span>;
}
