import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import { seedAgentSession } from '../../../test/helpers/fixtures';
import type { Db } from '../src/db';
import { findDuplicates } from '../src/tasks/dedup';

let db: Db; let drop: () => Promise<void>;
beforeAll(async () => ({ db, drop } = await createTestDb()));
afterAll(async () => drop());

let n = 0;
async function task(projectId: string, title: string, status = 'todo', closedDaysAgo: number | null = null, description = '') {
  n++;
  await db.query(
    `INSERT INTO tasks(project_id, number, type, title, description, status, closed_at)
     VALUES ($1, $2, 'task', $3, $4, $5, CASE WHEN $6::int IS NULL THEN NULL ELSE now() - make_interval(days => $6::int) END)`,
    [projectId, n, title, description, status, closedDaysAgo],
  );
}

describe('findDuplicates', () => {
  it('finds Russian paraphrases and ignores unrelated tasks', async () => {
    const { project } = await seedAgentSession(db, { remote: 'git@github.com:me/d1.git' });
    await task(project.id, 'Добавить импорт CSV');
    expect((await findDuplicates(db, project.id, 'Добавить импорт CSV-файлов')).map((c) => c.title)).toEqual(['Добавить импорт CSV']);
    expect((await findDuplicates(db, project.id, 'Импорт CSV файлов')).length).toBe(1);
    expect(await findDuplicates(db, project.id, 'Настроить CI для деплоя')).toEqual([]);
  });

  it('finds English paraphrases', async () => {
    const { project } = await seedAgentSession(db, { remote: 'git@github.com:me/d2.git' });
    await task(project.id, 'Add CSV import');
    expect((await findDuplicates(db, project.id, 'Add CSV import command')).length).toBe(1);
    expect(await findDuplicates(db, project.id, 'Rotate API keys')).toEqual([]);
  });

  it('considers open tasks and recently done ones only, within the project', async () => {
    const { project } = await seedAgentSession(db, { remote: 'git@github.com:me/d3.git' });
    const { project: other } = await seedAgentSession(db, { remote: 'git@github.com:me/d4.git' });
    await task(project.id, 'Export report to PDF', 'done', 2);
    await task(project.id, 'Export report to PDF', 'done', 10);
    await task(project.id, 'Export report to PDF', 'dropped', 1);
    await task(other.id, 'Export report to PDF');
    const c = await findDuplicates(db, project.id, 'Export report to PDF');
    expect(c).toHaveLength(1);
    expect(c[0]?.status).toBe('done');
    expect(c[0]?.score).toBeGreaterThan(0.9);
  });

  it('returns at most 5 candidates ordered by score', async () => {
    const { project } = await seedAgentSession(db, { remote: 'git@github.com:me/d5.git' });
    for (let i = 0; i < 7; i++) await task(project.id, `Improve search ranking v${i}`);
    const c = await findDuplicates(db, project.id, 'Improve search ranking');
    expect(c).toHaveLength(5);
    expect([...c].sort((a, b) => b.score - a.score)).toEqual(c);
  });
});
