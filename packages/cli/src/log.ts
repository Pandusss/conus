import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function log(dir: string, msg: string): void {
  try {
    const logs = join(dir, 'logs');
    mkdirSync(logs, { recursive: true });
    const file = join(logs, 'hook.log');
    try { if (statSync(file).size > 1_000_000) renameSync(file, file + '.1'); } catch { /* no file yet */ }
    appendFileSync(file, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* logging must never break the hook */ }
}
