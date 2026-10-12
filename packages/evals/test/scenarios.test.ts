import { describe, expect, it } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadScenarios, parseScenario } from '../src/scenario';

const dir = join(dirname(fileURLToPath(import.meta.url)), '../scenarios');

describe('scenarios', () => {
  it('all 16 files parse with unique ids', () => {
    const all = loadScenarios(dir);
    expect(all).toHaveLength(16);
    expect(new Set(all.map((s) => s.id)).size).toBe(16);
    expect(all.filter((s) => s.manual).map((s) => s.id)).toEqual(['long-session-compaction']);
  });
  it('applies defaults and camelCases keys', () => {
    const s = parseScenario('id: x\ndescription: d\nfixture: node-cli-small\nturns:\n  - user: hi\n    kill_after_seconds: 5\nexpect:\n  created: { max: 0 }\n');
    expect(s).toMatchObject({ agents: ['claude', 'codex'], seed: [], parallelSessions: 1, manual: false, turns: [{ user: 'hi', killAfterSeconds: 5 }], expect: { maxNudges: 2, janitorAllowed: false, tasks: [], created: { max: 0 } } });
  });
  it('rejects invalid scenarios', () => {
    expect(() => parseScenario('id: x\nturns: []\n')).toThrow();
  });
});
