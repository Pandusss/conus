import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../../../test/helpers/db';
import type { Db } from '../src/db';
import {
  deriveProjectKey, normalizeRemote, repoFingerprint, resolveOrCreateProject, renameProject,
  getProjectByKey, findProjectByRemote, allocateTaskNumber,
} from '../src/projects';

let db: Db; let drop: () => Promise<void>;
beforeAll(async () => ({ db, drop } = await createTestDb()));
afterAll(async () => drop());

describe('normalizeRemote', () => {
  it.each([
    ['git@github.com:Owner/Repo.git', 'github.com/owner/repo'],
    ['https://github.com/Owner/Repo.git', 'github.com/owner/repo'],
    ['https://user:secret@github.com/Owner/Repo/', 'github.com/owner/repo'],
    ['ssh://git@gitlab.example.com:2222/group/sub/repo.git', 'gitlab.example.com/group/sub/repo'],
    // unparsable by URL (non-numeric port): fallback must still drop scheme and credentials
    ['https://user:secret@host:abc/Repo.git', 'host:abc/repo'],
    ['https://user:secret@host:abc/Repo.git/', 'host:abc/repo'],
  ])('%s', (input, out) => expect(normalizeRemote(input)).toBe(out));
});

describe('keys and fingerprints', () => {
  it.each([
    ['agent-tasks', 'AT'], ['gizmo', 'GIZ'], ['my cool app', 'MCA'], ['TheOpenRoad', 'TOR'],
    ['проект', 'P'], ['2fa', 'P2FA'],
  ])('deriveProjectKey(%s) = %s', (name, key) => expect(deriveProjectKey(name)).toBe(key));

  it('fingerprint uses remote when present, local root otherwise', () => {
    expect(repoFingerprint({ remote: 'git@github.com:a/b.git', rootName: 'b', rootPathHash: 'ffff' })).toBe('github.com/a/b');
    expect(repoFingerprint({ remote: null, rootName: 'Notes', rootPathHash: 'abcdef1234' })).toBe('local:notes:abcdef12');
  });
});

describe('resolveOrCreateProject', () => {
  it('creates once per fingerprint and reuses it', async () => {
    const repo = { remote: 'git@github.com:me/agent-tasks.git', rootName: 'agent-tasks', rootPathHash: 'x1' };
    const a = await resolveOrCreateProject(db, repo);
    const b = await resolveOrCreateProject(db, repo);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.project.id).toBe(a.project.id);
    expect(a.project.key).toBe('AT');
    expect(a.project.name).toBe('agent-tasks');
    expect((await findProjectByRemote(db, 'https://github.com/ME/agent-tasks'))?.id).toBe(a.project.id);
  });
  it('keeps the remote name case so camelCase keys work (fingerprint stays lowercase)', async () => {
    const scp = await resolveOrCreateProject(db, { remote: 'git@github.com:me/TheOpenRoad.git', rootName: 'x', rootPathHash: 'x5' });
    expect(scp.project.name).toBe('TheOpenRoad');
    expect(scp.project.key).toBe('TOR');
    expect(scp.project.repoFingerprints).toEqual(['github.com/me/theopenroad']);
    const url = await resolveOrCreateProject(db, { remote: 'https://github.com/me/WebBridge.git/', rootName: 'x', rootPathHash: 'x6' });
    expect(url.project.name).toBe('WebBridge');
    expect(url.project.key).toBe('WB');
  });
  it('makes keys unique', async () => {
    const p = await resolveOrCreateProject(db, { remote: 'git@github.com:other/alpha-tool.git', rootName: 'alpha-tool', rootPathHash: 'x2' });
    expect(p.project.key).toBe('AT2');
  });
  it('is safe under concurrent creation', async () => {
    const repo = { remote: 'git@github.com:me/race.git', rootName: 'race', rootPathHash: 'x3' };
    const [x, y] = await Promise.all([resolveOrCreateProject(db, repo), resolveOrCreateProject(db, repo)]);
    expect(x.project.id).toBe(y.project.id);
  });
  it('renames and allocates sequential task numbers', async () => {
    const { project } = await resolveOrCreateProject(db, { remote: null, rootName: 'seq', rootPathHash: 'x4' });
    expect((await renameProject(db, project.id, 'Sequence')).name).toBe('Sequence');
    expect(await allocateTaskNumber(db, project.id)).toBe(1);
    expect(await allocateTaskNumber(db, project.id)).toBe(2);
    expect((await getProjectByKey(db, project.key))?.name).toBe('Sequence');
  });
});
