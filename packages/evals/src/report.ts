import type { Scenario } from './scenario';
import type { Check, EvalState } from './score';

export interface ScenarioResult {
  scenario: Scenario; agent: string; passed: boolean; checks: Check[];
  state: EvalState | null; // null when the scenario errored before the state was collected
  invalid?: string | null; // why the run cannot be scored (agent/wiring failure)
  error?: string | null; // exception in the harness while running the scenario
}
export interface ReportMeta { agent: string; model: string; agentVersion: string; judge: boolean; isolated: boolean; date: Date }

export type ResultStatus = 'pass' | 'fail' | 'invalid' | 'error';
export const STATUS_LABEL: Record<ResultStatus, string> = { pass: '✅', fail: '❌', invalid: '⚠️ INVALID', error: 'ERROR' };

export function resultStatus(r: ScenarioResult): ResultStatus {
  if (r.error) return 'error';
  if (r.invalid) return 'invalid';
  return r.passed ? 'pass' : 'fail';
}

export interface Aggregate {
  total: number; valid: number; invalid: number; errors: number; passed: number;
  /** Recall proxy: task expectations (`task[i]` checks) met, over valid scenarios. */
  expectations: { ok: number; total: number };
  /** On scenarios that expect no tasks (`created.max === 0`) and seed nothing: agent creates + proposals beyond `proposed.max`. */
  falseOps: number;
  duplicates: number; nudges: number; nudgesActed: number; janitorReleases: number;
}

/** Metrics over valid results only: invalid and errored runs say nothing about agent behaviour. */
export function aggregate(results: ScenarioResult[]): Aggregate {
  const valid = results.filter((r) => r.state && (resultStatus(r) === 'pass' || resultStatus(r) === 'fail'));
  const sum = (f: (s: EvalState) => number) => valid.reduce((n, r) => n + f(r.state!), 0);
  const expectationChecks = valid.flatMap((r) => r.checks.filter((c) => /^task\[\d+\]$/.test(c.name)));
  return {
    total: results.length,
    valid: valid.length,
    invalid: results.filter((r) => resultStatus(r) === 'invalid').length,
    errors: results.filter((r) => resultStatus(r) === 'error').length,
    passed: valid.filter((r) => r.passed).length,
    expectations: { ok: expectationChecks.filter((c) => c.ok).length, total: expectationChecks.length },
    falseOps: valid
      .filter((r) => r.scenario.expect.created?.max === 0 && r.scenario.seed.length === 0)
      .reduce((n, r) => n + r.state!.ops.created + Math.max(0, r.state!.ops.proposed - (r.scenario.expect.proposed?.max ?? 0)), 0),
    duplicates: sum((s) => s.duplicatePairs),
    nudges: sum((s) => s.nudges),
    nudgesActed: sum((s) => s.nudgesActed),
    janitorReleases: sum((s) => s.janitorReleases),
  };
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ');
const pct = (ok: number, total: number) => (total ? `${ok}/${total} (${Math.round((ok / total) * 100)}%)` : '—');

export function renderReport(results: ScenarioResult[], meta: ReportMeta): string {
  const a = aggregate(results);
  const valid = results.filter((r) => r.state && ['pass', 'fail'].includes(resultStatus(r)));
  const broken = results.filter((r) => ['invalid', 'error'].includes(resultStatus(r)));
  const lines = [
    `# Autonomy eval — ${meta.date.toISOString()}`,
    '',
    `Agent: **${meta.agent}** · model: ${meta.model} · version: ${meta.agentVersion} · judge: ${meta.judge ? 'on' : 'off'} · isolation: ${meta.isolated ? 'on' : 'off'}`,
    '',
    `Passed: **${a.passed}/${a.valid}** valid (of ${a.total}; invalid ${a.invalid}, errors ${a.errors}) · expectation pass-rate (recall proxy): **${pct(a.expectations.ok, a.expectations.total)}** · false ops on no-task scenarios: **${a.falseOps}** · duplicates: **${a.duplicates}** · nudges: **${a.nudges}** (acted ${a.nudgesActed}) · janitor releases: **${a.janitorReleases}**`,
    '',
    '| Scenario | Agent | Result | Ops cr/pr/st/bl/co/dr | Failed checks |',
    '|---|---|---|---|---|',
    ...valid.map((r) => {
      const o = r.state!.ops;
      const failed = r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ');
      return `| ${r.scenario.id} | ${r.agent} | ${STATUS_LABEL[resultStatus(r)]} | ${[o.created, o.proposed, o.started, o.blocked, o.completed, o.dropped].join('/')} | ${cell(failed) || '—'} |`;
    }),
  ];
  if (broken.length) {
    lines.push(
      '',
      '## Invalid runs',
      '',
      'Excluded from the pass count and all metrics above.',
      '',
      '| Scenario | Agent | Status | Reason |',
      '|---|---|---|---|',
      ...broken.map((r) => `| ${r.scenario.id} | ${r.agent} | ${STATUS_LABEL[resultStatus(r)]} | ${cell(r.error ?? r.invalid ?? '')} |`),
    );
  }
  lines.push(
    '',
    '## Final task state per scenario',
    ...results.filter((r) => r.state).flatMap((r) => [
      `### ${r.scenario.id} (${r.agent})${resultStatus(r) === 'invalid' ? ' — ⚠️ INVALID' : ''}`,
      ...r.state!.tasks.map((t) => `- ${t.ref} [${t.status}${t.type === 'bug' ? ', bug' : ''}] ${t.title}${t.result ? ` — ${t.result.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`),
      '',
    ]),
  );
  return lines.join('\n');
}
