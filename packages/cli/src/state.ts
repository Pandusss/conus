import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './fsutil';

export interface SessionState { root: string; head: string | null; remote: string | null; disabled: boolean }

const file = (dir: string, id: string) => join(dir, 'state', id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) + '.json');

export function loadState(dir: string, agentSessionId: string): SessionState | null {
  try { return JSON.parse(readFileSync(file(dir, agentSessionId), 'utf8')); } catch { return null; }
}
export function saveState(dir: string, agentSessionId: string, s: SessionState): void {
  mkdirSync(join(dir, 'state'), { recursive: true });
  writeFileAtomic(file(dir, agentSessionId), JSON.stringify(s));
}
export function removeState(dir: string, agentSessionId: string): void {
  rmSync(file(dir, agentSessionId), { force: true });
}
