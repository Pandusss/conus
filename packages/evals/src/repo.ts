import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Scenario } from './scenario';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = resolve(pkgRoot, '../..');

export function prepareRepo(s: Scenario, workRoot: string): { dir: string; remote: string } {
  const stamp = Date.now();
  const dir = join(workRoot, `${s.id}-${stamp}`);
  mkdirSync(dir, { recursive: true });
  cpSync(join(pkgRoot, 'fixtures', s.fixture), dir, { recursive: true });
  if (s.overlay) cpSync(join(pkgRoot, 'fixtures', 'overlays', s.overlay), dir, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  const remote = `git@evals.local:evals/${s.id}-${stamp}.git`;
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'evals@example.com');
  git('config', 'user.name', 'evals');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  git('remote', 'add', 'origin', remote);
  return { dir, remote };
}

export function shimDir(workRoot: string): string {
  const dir = join(workRoot, 'bin');
  mkdirSync(dir, { recursive: true });
  const entry = join(repoRoot, 'packages', 'cli', 'dist', 'conus.mjs');
  writeFileSync(join(dir, 'conus'), `#!/bin/sh\nexec node "${entry.replace(/\\/g, '/')}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(dir, 'conus.cmd'), `@node "${entry}" %*\r\n`);
  return dir;
}
