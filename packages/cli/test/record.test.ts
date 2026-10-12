import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Recorded payloads hold prompt text and Bash diff hunks: they must be created owner-only. On Windows the
// mode is not observable through stat, so the write options are captured instead.
const { writes } = vi.hoisted(() => ({ writes: [] as { path: string; opts: unknown }[] }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const writeFileSync = ((p: Parameters<typeof fs.writeFileSync>[0], d: Parameters<typeof fs.writeFileSync>[1], o?: Parameters<typeof fs.writeFileSync>[2]) => {
    writes.push({ path: String(p), opts: o });
    return fs.writeFileSync(p, d, o);
  }) as typeof fs.writeFileSync;
  return { ...fs, writeFileSync, default: { ...fs, writeFileSync } };
});

const { runHook } = await import('../src/hook/run');

describe('raw payload recording', () => {
  it('writes each recorded payload with mode 0o600', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'conus-rec-mode-'));
    const rec = join(dir, 'records');
    const fetchImpl = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const git = { repoContext: () => null, headCommit: () => null };
    await runHook('claude', 'prompt', '{"session_id":"x","cwd":"C:\\\\r","prompt":"secret"}', { env: { CONUS_CONFIG_DIR: dir, CONUS_HOOK_RECORD_DIR: rec }, fetchImpl, git });
    const recorded = writes.filter((w) => w.path.startsWith(rec));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.opts).toMatchObject({ mode: 0o600 });
    if (process.platform !== 'win32') expect(statSync(recorded[0]!.path).mode & 0o777).toBe(0o600);
  });
});
