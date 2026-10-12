import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function isRepoDisabled(root: string): boolean {
  try { return JSON.parse(readFileSync(join(root, '.conus.json'), 'utf8')).enabled === false; } catch { return false; }
}

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

export function setRepoEnabled(root: string, enabled: boolean): void {
  const file = join(root, '.conus.json');
  if (enabled) { rmSync(file, { force: true }); return; }
  writeFileSync(file, JSON.stringify({ enabled: false }, null, 2) + '\n');
  // In a linked worktree or submodule `.git` is a file pointing elsewhere; the exclude entry is skipped there.
  if (isDir(join(root, '.git'))) {
    const exclude = join(root, '.git', 'info', 'exclude');
    mkdirSync(join(root, '.git', 'info'), { recursive: true });
    const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (!cur.split(/\r?\n/).includes('.conus.json')) appendFileSync(exclude, (cur.endsWith('\n') || !cur ? '' : '\n') + '.conus.json\n');
  }
}
