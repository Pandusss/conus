import type { Db } from './db';

export const STATUSES = ['proposed', 'todo', 'in_progress', 'blocked', 'review', 'done', 'dropped'] as const;
export type Status = (typeof STATUSES)[number];
export const OPEN_STATUSES: readonly Status[] = ['proposed', 'todo', 'in_progress', 'blocked', 'review'];
export type TaskType = 'task' | 'bug';
export type AgentKind = 'claude_code' | 'codex' | 'other';
export type SessionState = 'active' | 'ended' | 'stale';
export type SessionSource = 'startup' | 'resume' | 'clear' | 'compact';
export type Actor =
  | { kind: 'agent'; agentId: string; sessionId: string | null; model: string | null }
  | { kind: 'user' }
  | { kind: 'system' };
export interface Ctx { db: Db; actor: Actor; idempotencyKey?: string | null; now?: Date }
export interface Project { id: string; key: string; name: string; repoFingerprints: string[]; createdAt: Date }
export interface Agent { id: string; name: string; kind: AgentKind; tokenPrefix: string; createdAt: Date; revokedAt: Date | null; lastSeenAt: Date | null; lastUnboundMcpAt: Date | null }
export interface Session { id: string; ref: string; agentId: string; agentSessionId: string; projectId: string | null; cwd: string | null; branch: string | null; model: string | null; currentTurn: number; state: SessionState; startedAt: Date; lastSeenAt: Date; endedAt: Date | null; endReason: string | null }
export interface Task { id: string; projectId: string; projectKey: string; number: number; ref: string; parentId: string | null; parentRef: string | null; type: TaskType; title: string; description: string; status: Status; result: string | null; blockReason: string | null; blockedByRef: string | null; sourceQuote: string | null; claimedBySessionId: string | null; claimExpiresAt: Date | null; mergedIntoId: string | null; version: number; createdAt: Date; updatedAt: Date; closedAt: Date | null; deletedAt: Date | null }
/** The session that holds a task's claim, as the owner's UI shows it. */
export interface TaskHolder { agentName: string; sessionRef: string; sessionId: string }
/** A task plus the read-model extras the owner's UI lists: project name, claim holder, subtask and commit counts. */
export interface TaskView extends Task { projectName: string; holder: TaskHolder | null; subtaskCount: number; commitCount: number }
export type TaskEventType = 'created' | 'proposed' | 'promoted' | 'started' | 'updated' | 'noted' | 'blocked' | 'completed' | 'sent_to_review' | 'reopened' | 'dropped' | 'claimed' | 'claim_released' | 'commit_linked' | 'merged_duplicate' | 'status_changed' | 'moved' | 'deleted';
export interface TaskEvent { id: number; taskId: string; seq: number; type: TaskEventType; actorKind: Actor['kind']; actorId: string | null; actorName: string | null; sessionId: string | null; sessionRef: string | null; model: string | null; changes: Record<string, { from: unknown; to: unknown }>; reason: string | null; note: string | null; createdAt: Date }
export interface Link { id: number; taskId: string; kind: 'commit' | 'branch'; ref: string; meta: Record<string, unknown>; sessionId: string | null; createdAt: Date }
export type Fact =
  | { kind: 'file_edit'; data: { path: string } }
  | { kind: 'git_commit'; data: { sha: string; subject: string; branch?: string; amends?: string } }
  | { kind: 'test_run'; data: { passed: boolean | null; command: string } }
  | { kind: 'task_op'; data: { tool: string; task?: string } };
export interface MutationResult { task: Task; chatNote: string }
export interface DuplicateCandidate { ref: string; title: string; status: Status; score: number }
export type CreateOutcome = ({ outcome: 'created' } & MutationResult) | { outcome: 'possible_duplicates'; candidates: DuplicateCandidate[] };
export interface RepoInfo { remote?: string | null; rootName: string; rootPathHash: string; branch?: string | null; head?: string | null }
