import { existsSync, readFileSync } from 'node:fs';
import { resolveWriteTarget, writeFileAtomic } from '../fsutil';

const unbalanced = (file: string) => new Error(`${file} has a conus start marker without an end marker; fix it manually.`);

/**
 * Throws when `file` has a conus start marker with no end marker after it (the state upsertBlock refuses to touch).
 * A missing file is fine. Lets a caller that updates several files check them all before writing any.
 */
export function assertBlockSane(file: string, start: string, end: string): void {
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  const s = text.indexOf(start);
  if (s >= 0 && text.indexOf(end, s + start.length) < 0) throw unbalanced(file);
}

export function upsertBlock(file: string, block: string, start: string, end: string, createIfMissing: boolean): 'created' | 'updated' | 'unchanged' | 'skipped' {
  if (!existsSync(file)) {
    if (!createIfMissing) return 'skipped';
    writeFileAtomic(file, block);
    return 'created';
  }
  const text = readFileSync(file, 'utf8');
  // Write through a symlink (dotfiles-managed AGENTS.md / CLAUDE.md) instead of replacing it.
  const target = resolveWriteTarget(file);
  const s = text.indexOf(start);
  if (s >= 0) {
    // Only an end marker AFTER the start closes the block; a stray end marker quoted earlier is just text.
    const e = text.indexOf(end, s + start.length);
    if (e < 0) throw unbalanced(file);
    const current = text.slice(s, e + end.length);
    const wanted = block.trimEnd();
    if (current === wanted) return 'unchanged';
    writeFileAtomic(target, text.slice(0, s) + wanted + text.slice(e + end.length));
    return 'updated';
  }
  // No start marker (a lone end marker counts as ordinary text): append once; later runs then find the block.
  writeFileAtomic(target, text.replace(/\s*$/, '') + '\n\n' + block);
  return 'updated';
}
