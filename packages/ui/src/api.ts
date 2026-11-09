export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details: Record<string, unknown> = {}) { super(message); }
}

export function csrfToken(cookie: string = typeof document === 'undefined' ? '' : document.cookie): string | null {
  const m = /(?:^|;\s*)conus_csrf=([^;]+)/.exec(cookie);
  return m ? decodeURIComponent(m[1]!) : null;
}

export async function api<T>(path: string, init: { method?: string; json?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = csrfToken() ?? '';
  const res = await fetch(`/api/ui${path}`, { method, headers, body: init.json !== undefined ? JSON.stringify(init.json) : undefined, credentials: 'same-origin' });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch {
    // Not JSON (a proxy's 502 page, or the SPA's index.html from a misrouted request): never leak a SyntaxError.
    throw new HttpError(res.status, 'error', res.statusText);
  }
  if (!res.ok) throw new HttpError(res.status, body?.error?.code ?? 'error', body?.error?.message ?? res.statusText, body?.error?.details ?? {});
  return body as T;
}

export type Status = 'proposed' | 'todo' | 'in_progress' | 'blocked' | 'review' | 'done' | 'dropped';
export type Priority = 'urgent' | 'high' | 'normal' | 'low';
export interface HolderDto { agentName: string; sessionRef: string; sessionId: string }
export interface TaskDto {
  id: string; ref: string; projectKey: string; projectName: string; title: string; description: string; status: Status; type: 'task' | 'bug';
  parentId: string | null; parentRef: string | null; result: string | null; blockReason: string | null; sourceQuote: string | null;
  claimedBySessionId: string | null; holder: HolderDto | null; subtaskCount: number; commitCount: number;
  /** Who set the priority last; 'owner' means the manager will not change it. */
  priority: Priority; prioritySource: 'default' | 'agent' | 'manager' | 'owner'; /** 'YYYY-MM-DD' */ dueOn: string | null;
  version: number; createdAt: string; updatedAt: string;
}
/** A task as the overview lists it: no long texts. */
export type OverviewTaskDto = Omit<TaskDto, 'description' | 'sourceQuote' | 'result'>;
export type OpenStatus = 'proposed' | 'todo' | 'in_progress' | 'blocked' | 'review';
export interface ProjectOverviewDto {
  id: string; key: string; name: string; counts: Record<OpenStatus, number>; doneThisWeek: number; lastActivityAt: string | null;
  /** When an agent was last seen in the project, and since when its longest-waiting task waits for a check. */
  lastAgentAt: string | null; reviewSince: string | null;
  live: { id: string; ref: string; agentName: string; lastSeenAt: string }[];
  inProgress: OverviewTaskDto[]; blocked: OverviewTaskDto[]; review: OverviewTaskDto[]; next: OverviewTaskDto[]; quiet: boolean;
}
export interface OverviewDto {
  projects: ProjectOverviewDto[];
  attention: { review: OverviewTaskDto[]; blocked: OverviewTaskDto[]; dated: OverviewTaskDto[]; proposals: number };
}
export interface EventDto {
  id: number; taskId: string; type: string; actorKind: 'agent' | 'user' | 'system' | 'manager'; actorName: string | null; sessionId: string | null;
  sessionRef: string | null; model: string | null; changes: Record<string, { from: unknown; to: unknown }>; reason: string | null; note: string | null; createdAt: string;
}
export interface LinkDto { id: number; kind: 'commit' | 'branch'; ref: string; meta: { subject?: string } }
export interface ProjectDto { id: string; key: string; name: string; openCount: number }
export interface AgentStatsDto { sessions: number; nudges: number; nudgesActed: number; janitorReleases: number }
export interface AgentDto { id: string; name: string; kind: string; tokenPrefix: string; createdAt: string; revokedAt: string | null; lastSeenAt: string | null; stats: AgentStatsDto }
export interface SessionDto { id: string; ref: string; agentName: string; projectKey: string | null; state: string; branch: string | null; startedAt: string; lastSeenAt: string; endedAt: string | null; taskOps: number; nudges: number; nudgesActed: number; janitorReleases: number }
/**
 * An agent health warning. The UI words the known kinds itself ('hooks_missing', 'agent_silent', 'janitor_interventions');
 * `message` is the server's English text, shown for a kind it does not know. `count` (task releases) and `days`
 * (the window) come with 'janitor_interventions'.
 */
export interface WarningDto { kind: string; agentId: string; agentName: string; message: string; count?: number; days?: number }

// ── the manager ──
export interface SettingsDto {
  settings: {
    timeZone: string; digestTime: string; quietFrom: string; quietTo: string; notifyReview: boolean; notifyBlocked: boolean;
    /** Hours between reminders; 0 means off. */
    remindEveryHours: number;
    managerAuto: boolean; telegramUsername: string | null; telegramLinked: boolean;
  };
  telegram: { configured: boolean; botUsername: string | null; error: string | null };
  manager: { enabled: boolean; model: string | null };
}
export interface ReviewDto {
  id: number; trigger: 'daily' | 'owner'; model: string; summary: string; createdAt: string;
  focus: { taskId: string; ref: string; title: string; why: string }[];
  changes: { taskId: string; ref: string; title: string; from: Priority; to: Priority; reason: string; applied: boolean }[];
  findings: { kind: 'duplicate' | 'stale' | 'unclear' | 'risk'; refs: string[]; note: string }[];
}
export interface IntakeBatchDto {
  id: number; source: 'telegram' | 'web'; status: 'done' | 'failed'; summary: string | null; error: string | null;
  tasks: TaskDto[]; duplicates: { title: string; ref: string; existingTitle: string }[]; createdAt: string;
}
