import { withTx, type Db, type Queryable } from './db';
import { DomainError } from './errors';
import { appendEvent } from './events';
import { formatRef } from './refs';
import { mapProject } from './rows';
import type { Project, RepoInfo } from './types';

/** Remote reduced to `host/path` (no scheme, no credentials, no `.git`), case preserved. */
function cleanRemote(remote: string): string {
  const r = remote.trim();
  let host: string;
  let path: string;
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(r);
  if (scp && !r.includes('://')) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    try {
      const u = new URL(r);
      host = u.hostname;
      path = u.pathname;
    } catch {
      // Not parsable as a URL (e.g. a non-numeric port): still drop scheme and userinfo.
      return r
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
        .replace(/^[^@/]*@/, '')
        .replace(/\/+$/, '')
        .replace(/\.git$/, '')
        .replace(/\/+$/, '');
    }
  }
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  return `${host}/${path}`;
}

export function normalizeRemote(remote: string): string {
  return cleanRemote(remote).toLowerCase();
}

export function repoFingerprint(repo: RepoInfo): string {
  return repo.remote ? normalizeRemote(repo.remote) : `local:${repo.rootName.toLowerCase()}:${repo.rootPathHash.slice(0, 8)}`;
}

export function deriveProjectKey(name: string): string {
  const words = name.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean);
  let key: string;
  if (words.length === 0) key = 'P';
  else if (words.length === 1) key = words[0]!.slice(0, 3).toUpperCase();
  else key = words.map((w) => w[0]).join('').slice(0, 4).toUpperCase();
  if (!/^[A-Z]/.test(key)) key = ('P' + key).slice(0, 4);
  return key;
}

function projectNameFor(repo: RepoInfo): string {
  if (repo.remote) {
    const parts = cleanRemote(repo.remote).split('/'); // keep case: camelCase names derive better keys
    return parts[parts.length - 1] || repo.rootName;
  }
  return repo.rootName;
}

export async function resolveOrCreateProject(db: Db, repo: RepoInfo): Promise<{ project: Project; created: boolean }> {
  const fp = repoFingerprint(repo);
  return withTx(db, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['project:' + fp]);
    const found = await tx.query('SELECT * FROM projects WHERE $1 = ANY(repo_fingerprints) LIMIT 1', [fp]);
    if (found.rowCount) return { project: mapProject(found.rows[0]), created: false };
    const name = projectNameFor(repo);
    await tx.query('SELECT pg_advisory_xact_lock(727002)'); // serialize key allocation
    const base = deriveProjectKey(name);
    const { rows } = await tx.query('SELECT key FROM projects WHERE key = $1 OR key ~ $2', [base, `^${base}[0-9]+$`]);
    const taken = new Set(rows.map((r) => r.key as string));
    let key = base;
    for (let i = 2; taken.has(key); i++) key = `${base}${i}`;
    const ins = await tx.query(
      'INSERT INTO projects(key, name, repo_fingerprints) VALUES ($1, $2, $3) RETURNING *',
      [key, name, [fp]],
    );
    return { project: mapProject(ins.rows[0]), created: true };
  });
}

export async function getProjectById(q: Queryable, id: string): Promise<Project | null> {
  const { rows } = await q.query('SELECT * FROM projects WHERE id = $1', [id]);
  return rows[0] ? mapProject(rows[0]) : null;
}

export async function getProjectByKey(q: Queryable, key: string): Promise<Project | null> {
  const { rows } = await q.query('SELECT * FROM projects WHERE key = $1', [key.toUpperCase()]);
  return rows[0] ? mapProject(rows[0]) : null;
}

export async function findProjectByRemote(q: Queryable, remote: string): Promise<Project | null> {
  const { rows } = await q.query('SELECT * FROM projects WHERE $1 = ANY(repo_fingerprints) LIMIT 1', [normalizeRemote(remote)]);
  return rows[0] ? mapProject(rows[0]) : null;
}

/** True for something shaped like a repo remote: `host.tld/owner/repo` once scheme, credentials and `.git` are dropped. */
export function isRepoRemote(remote: string): boolean {
  if (/\s/.test(remote.trim())) return false;
  const [host, ...path] = cleanRemote(remote).split('/');
  return !!host && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host) && path.filter(Boolean).length >= 2;
}

/**
 * The project of a git remote an agent names over MCP. A repo no hook has registered yet (the session's start hook never
 * ran there) gets its project created exactly as at session start. Null when `remote` is not a repo remote.
 */
export async function projectForRemote(db: Db, remote: string): Promise<Project | null> {
  const found = await findProjectByRemote(db, remote);
  if (found || !isRepoRemote(remote)) return found;
  const rootName = cleanRemote(remote).split('/').pop() || 'repo';
  return (await resolveOrCreateProject(db, { remote, rootName, rootPathHash: '' })).project;
}

export async function listProjects(q: Queryable): Promise<(Project & { openCount: number })[]> {
  const { rows } = await q.query(`
    SELECT p.*, (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.deleted_at IS NULL
      AND t.status IN ('proposed','todo','in_progress','blocked','review')) AS open_count
    FROM projects p ORDER BY p.name`);
  return rows.map((r) => ({ ...mapProject(r), openCount: r.open_count }));
}

export async function renameProject(q: Queryable, id: string, name: string): Promise<Project> {
  const n = name.trim();
  if (!n || n.length > 100) throw new DomainError('validation', 'Project name must be 1..100 characters.');
  const { rows } = await q.query('UPDATE projects SET name = $2 WHERE id = $1 RETURNING *', [id, n]);
  if (!rows[0]) throw new DomainError('not_found', 'Project not found.');
  return mapProject(rows[0]);
}

export async function allocateTaskNumber(tx: Queryable, projectId: string): Promise<number> {
  const { rows } = await tx.query(
    'UPDATE projects SET next_task_number = next_task_number + 1 WHERE id = $1 RETURNING next_task_number - 1 AS n',
    [projectId],
  );
  if (!rows[0]) throw new DomainError('not_found', 'Project not found.');
  return rows[0].n;
}

/**
 * Moves every task (soft-deleted ones included) of `fromId` into `intoId`, renumbering them from the target's counter,
 * merges the repo fingerprints, re-points sessions and deletes the source project. Owner-only; the UI API is the caller.
 *
 * Lock order is the same everywhere: both projects in one statement ordered by id, then the source tasks in one
 * statement ordered by id (the order mergeDuplicate uses), so concurrent merges cannot deadlock each other.
 */
export async function mergeProjects(db: Db, fromId: string, intoId: string): Promise<void> {
  if (fromId === intoId) throw new DomainError('validation', 'Cannot merge a project into itself.');
  await withTx(db, async (tx) => {
    const { rows: ps } = await tx.query('SELECT * FROM projects WHERE id = ANY($1) ORDER BY id FOR UPDATE', [[fromId, intoId]]);
    const from = ps.find((p) => p.id === fromId);
    const into = ps.find((p) => p.id === intoId);
    if (!from || !into) throw new DomainError('not_found', 'Project not found.');
    const { rows: locked } = await tx.query('SELECT id, number FROM tasks WHERE project_id = $1 ORDER BY id FOR UPDATE', [fromId]);
    const tasks = [...locked].sort((a, b) => a.number - b.number); // keep the original relative order
    for (const t of tasks) {
      const n = await allocateTaskNumber(tx, intoId);
      await tx.query('UPDATE tasks SET project_id = $2, number = $3, updated_at = now() WHERE id = $1', [t.id, intoId, n]);
      await appendEvent(tx, {
        taskId: t.id, type: 'moved', actor: { kind: 'user' },
        changes: { ref: { from: formatRef(from.key, t.number), to: formatRef(into.key, n) } },
      });
    }
    await tx.query(
      `UPDATE projects SET repo_fingerprints = (SELECT array_agg(DISTINCT f) FROM unnest(repo_fingerprints || $2::text[]) f) WHERE id = $1`,
      [intoId, from.repo_fingerprints],
    );
    await tx.query('UPDATE sessions SET project_id = $2 WHERE project_id = $1', [fromId, intoId]);
    await tx.query('DELETE FROM projects WHERE id = $1', [fromId]);
  });
}
