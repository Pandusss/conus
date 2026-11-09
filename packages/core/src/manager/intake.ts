import type { Db, Queryable } from '../db';
import { DomainError } from '../errors';
import { t } from '../lang';
import { mapProject } from '../rows';
import { getSettings, localClock } from '../settings';
import { proposeTask } from '../tasks/create';
import { managerSetPriority, parseDueDate } from '../tasks/owner-ops';
import { TASK_VIEW_SELECT, mapTaskView, getTaskByRef } from '../tasks/queries';
import { truncate } from '../text';
import type { Ctx, Project, TaskView } from '../types';
import { requireManager, type IntakeContext, type ManagerLlm } from './llm';

export const INTAKE_MAX_CHARS = 30_000;
const MAX_ITEMS = 25;
const OPEN_PER_PROJECT = 40;
/** Where proposals go when no project fits; the owner moves them from there. */
export const INBOX_KEY = 'INBOX';

export interface IntakeDuplicate { title: string; ref: string; existingTitle: string }
export interface IntakeBatch {
  id: number; source: 'telegram' | 'web'; status: 'done' | 'failed'; summary: string | null; error: string | null;
  tasks: TaskView[]; duplicates: IntakeDuplicate[]; telegramMessageId: number | null; createdAt: Date;
}

const manager = (db: Db): Ctx => ({ db, actor: { kind: 'manager' } });

async function inboxProject(db: Db): Promise<Project> {
  const { rows } = await db.query(
    `INSERT INTO projects(key, name) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key RETURNING *`,
    [INBOX_KEY, t('Inbox', 'Входящие')],
  );
  return mapProject(rows[0]);
}

export async function intakeContext(q: Queryable, now: Date): Promise<IntakeContext> {
  const settings = await getSettings(q);
  const projects = (await q.query('SELECT * FROM projects ORDER BY key')).rows.map(mapProject);
  const { rows } = await q.query(
    `${TASK_VIEW_SELECT} WHERE t.deleted_at IS NULL AND t.status IN ('proposed','todo','in_progress','blocked','review') ORDER BY t.updated_at DESC`,
  );
  const open = rows.map(mapTaskView);
  return {
    today: localClock(now, settings.timeZone).date,
    timeZone: settings.timeZone,
    projects: projects.map((p) => ({
      key: p.key, name: p.name,
      open: open.filter((x) => x.projectId === p.id).slice(0, OPEN_PER_PROJECT).map((x) => ({ ref: x.ref, title: truncate(x.title, 120), status: x.status })),
    })),
  };
}

/**
 * Reads correspondence or notes and files the work in it as proposals in the right projects (or Inbox), with a
 * priority, a due date and the quote it came from. Repeats of open tasks are reported, not filed again. The owner
 * accepts or rejects the proposals; nothing here starts work by itself.
 */
export async function runIntake(
  deps: { db: Db; llm: ManagerLlm; now?: Date }, input: { source: 'telegram' | 'web'; text: string },
): Promise<IntakeBatch> {
  const text = input.text.trim();
  if (!text) throw new DomainError('validation', 'Nothing to read: the text is empty.', { field: 'text' });
  if (text.length > INTAKE_MAX_CHARS) throw new DomainError('validation', `The text is too long (max ${INTAKE_MAX_CHARS} characters).`, { field: 'text' });
  requireManager(deps.llm);
  const { db } = deps;
  const now = deps.now ?? new Date();
  const context = await intakeContext(db, now);

  let result;
  try {
    result = await deps.llm.extract(text, context);
  } catch (e) {
    await db.query(`INSERT INTO intake_batches(source, status, input, error) VALUES ($1, 'failed', $2, $3)`,
      [input.source, text, e instanceof Error ? e.message : String(e)]);
    throw e;
  }

  const byKey = new Map(context.projects.map((p) => [p.key.toUpperCase(), p.key]));
  const created: string[] = [];
  const duplicates: IntakeDuplicate[] = [];
  for (const item of result.items.slice(0, MAX_ITEMS)) {
    const title = truncate(item.title.trim(), 200);
    if (!title) continue;
    const key = item.project_key ? byKey.get(item.project_key.trim().toUpperCase()) : undefined;
    const project = key ? (await db.query('SELECT * FROM projects WHERE key = $1', [key])).rows.map(mapProject)[0]! : await inboxProject(db);
    if (item.duplicate_of) {
      const existing = await getTaskByRef(db, project.id, item.duplicate_of).catch(() => null);
      if (existing && !['done', 'dropped'].includes(existing.status)) {
        duplicates.push({ title, ref: existing.ref, existingTitle: existing.title });
        continue;
      }
    }
    const from = item.requested_by?.trim();
    const description = [item.description.trim(), from ? t(`Requested by: ${from}`, `Просит: ${from}`) : '']
      .filter(Boolean).join('\n\n');
    const quote = truncate(item.source_quote.trim() || title, 1000);
    const r = await proposeTask(manager(db), { projectId: project.id, title, description: truncate(description, 10_000), sourceQuote: quote });
    if (r.outcome === 'possible_duplicates') {
      const top = r.candidates[0]!;
      duplicates.push({ title, ref: top.ref, existingTitle: top.title });
      continue;
    }
    let dueOn: string | null = null;
    try { dueOn = item.due_on ? parseDueDate(item.due_on) : null; } catch { dueOn = null; }
    if (item.priority !== 'normal' || dueOn) {
      await managerSetPriority(manager(db), { taskId: r.task.id, priority: item.priority, dueOn, reason: t('From the correspondence', 'Из переписки') });
    }
    created.push(r.task.id);
  }

  const { rows } = await db.query(
    `INSERT INTO intake_batches(source, status, input, summary, task_ids, duplicates) VALUES ($1, 'done', $2, $3, $4, $5) RETURNING id`,
    [input.source, text, truncate(result.summary, 2000), created, JSON.stringify(duplicates)],
  );
  return (await getIntakeBatch(db, rows[0].id))!;
}

export async function getIntakeBatch(q: Queryable, id: number): Promise<IntakeBatch | null> {
  const { rows } = await q.query('SELECT * FROM intake_batches WHERE id = $1', [id]);
  const b = rows[0];
  if (!b) return null;
  const tasks = b.task_ids.length
    ? (await q.query(`${TASK_VIEW_SELECT} WHERE t.id = ANY($1) AND t.deleted_at IS NULL`, [b.task_ids])).rows.map(mapTaskView)
    : [];
  const order = new Map<string, number>(b.task_ids.map((id: string, i: number) => [id, i]));
  tasks.sort((x, y) => order.get(x.id)! - order.get(y.id)!);
  return {
    id: b.id, source: b.source, status: b.status, summary: b.summary, error: b.error, tasks, duplicates: b.duplicates,
    telegramMessageId: b.telegram_message_id == null ? null : Number(b.telegram_message_id), createdAt: b.created_at,
  };
}

export async function setBatchTelegramMessage(q: Queryable, id: number, messageId: number): Promise<void> {
  await q.query('UPDATE intake_batches SET telegram_message_id = $2 WHERE id = $1', [id, messageId]);
}
