import { describe, expect, it } from 'vitest';
import { aggregate, renderReport, resultStatus, type ScenarioResult } from '../src/report';
import { parseScenario } from '../src/scenario';
import { NO_OPS, type Check, type EvalState, type OpCounts } from '../src/score';

const scenario = (id: string) =>
  parseScenario(`id: ${id}\ndescription: d\nfixture: node-cli-small\nturns: [{ user: x }]\nexpect:\n  created: { max: 0 }\n`);
const noTask = scenario('qa');
const seeded = parseScenario('id: drop\ndescription: d\nfixture: node-cli-small\nseed: [{ title: t, status: todo }]\nturns: [{ user: x }]\nexpect:\n  created: { max: 0 }\n');
const feature = parseScenario('id: feat\ndescription: d\nfixture: node-cli-small\nturns: [{ user: x }]\nexpect:\n  created: { min: 1 }\n');
const state = (p: Partial<EvalState> = {}, ops: Partial<OpCounts> = {}): EvalState =>
  ({ tasks: [], nudges: 0, nudgesActed: 0, janitorReleases: 0, duplicatePairs: 0, ...p, ops: { ...NO_OPS, ...ops } });
const ok = (name: string): Check => ({ name, ok: true, detail: '' });
const bad = (name: string, detail = 'x'): Check => ({ name, ok: false, detail });

const results: ScenarioResult[] = [
  { scenario: noTask, agent: 'claude', passed: true, checks: [ok('created'), ok('nudges')], state: state({ nudges: 1, nudgesActed: 1 }) },
  { scenario: feature, agent: 'claude', passed: false, checks: [bad('task[0]', 'E-1: status in_progress ∉ done|review'), ok('task[1]')], state: state({ duplicatePairs: 1, janitorReleases: 1 }, { created: 2, started: 1 }) },
  { scenario: seeded, agent: 'claude', passed: true, checks: [ok('task[0]')], state: state({}, { proposed: 1, dropped: 1 }) },
  { scenario: scenario('qa2'), agent: 'claude', passed: false, checks: [bad('created')], state: state({}, { created: 1, proposed: 1 }) },
  { scenario: scenario('qa3'), agent: 'claude', passed: true, checks: [ok('task[0]')], state: state({ duplicatePairs: 3, nudges: 4, janitorReleases: 2 }, { created: 5 }), invalid: 's1t1: conus MCP failed' },
  { scenario: scenario('qa4'), agent: 'claude', passed: false, checks: [], state: null, error: 'seed failed' },
];
const meta = { agent: 'claude', model: 'default', agentVersion: '2.1.270 (Claude Code)', judge: false, isolated: true, date: new Date('2026-10-09T10:00:00Z') };

describe('aggregate', () => {
  it('counts only valid results; recall proxy = task expectations met; false ops only on no-task scenarios without seeds', () => {
    expect(aggregate(results)).toEqual({
      total: 6, valid: 4, invalid: 1, errors: 1, passed: 2,
      expectations: { ok: 2, total: 3 },
      falseOps: 2, duplicates: 1, nudges: 1, nudgesActed: 1, janitorReleases: 1,
    });
  });
  it('false ops count only proposals beyond what the scenario allows (09 idea-mention shape)', () => {
    const idea = parseScenario('id: idea\ndescription: d\nfixture: node-cli-small\nturns: [{ user: x }]\nexpect:\n  created: { max: 0 }\n  proposed: { min: 1, max: 1 }\n');
    const run = (ops: Partial<OpCounts>): ScenarioResult => ({ scenario: idea, agent: 'claude', passed: true, checks: [], state: state({}, ops) });
    expect(aggregate([run({ proposed: 1 })]).falseOps).toBe(0);
    expect(aggregate([run({ proposed: 3 })]).falseOps).toBe(2);
    expect(aggregate([run({ created: 1, proposed: 1 })]).falseOps).toBe(1);
  });
  it('handles an empty run', () => {
    expect(aggregate([])).toMatchObject({ total: 0, valid: 0, passed: 0, expectations: { ok: 0, total: 0 }, falseOps: 0 });
  });
});

describe('resultStatus', () => {
  it('error wins over invalid, invalid over pass/fail', () => {
    expect(results.map(resultStatus)).toEqual(['pass', 'fail', 'pass', 'fail', 'invalid', 'error']);
  });
});

describe('renderReport', () => {
  const md = renderReport(results, meta);
  it('has run metadata and the aggregate header', () => {
    expect(md).toContain('2026-10-09T10:00:00.000Z');
    expect(md).toMatch(/model: default · version: 2\.1\.270 \(Claude Code\) · judge: off · isolation: on/);
    expect(md).toContain('Passed: **2/4** valid');
    expect(md).toContain('expectation pass-rate (recall proxy): **2/3 (67%)**');
    expect(md).toContain('false ops on no-task scenarios: **2**');
  });
  it('lists invalid and errored scenarios separately with their reasons, not in the main table', () => {
    const [main, rest] = md.split('## Invalid runs');
    expect(main).not.toMatch(/\| qa3 \|/);
    expect(main).toMatch(/\| feat \| claude \| ❌ \| 2\/0\/1\/0\/0\/0 \| task\[0\]: E-1: status in_progress ∉ done\\\|review \|/);
    expect(rest).toContain('| qa3 | claude | ⚠️ INVALID | s1t1: conus MCP failed |');
    expect(rest).toContain('| qa4 | claude | ERROR | seed failed |');
  });
});
